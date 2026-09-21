/**
 * Converts conversational money updates into safe Notion writes.
 *
 * Design note (information-systems idea): this is the write layer. The model
 * may suggest an action, but code validates it and Notion confirms it before
 * Fin says anything was saved. That keeps the AI from becoming the system of
 * record; Notion remains the source of truth.
 */
import { AUTO_LINK_IN_NOTION, EXTRACTION_MODEL_ID } from "./config";
import {
	addDays,
	daysBetween,
	DS,
	explainWriteError,
	findMonthFor,
	findWeekFor,
	friendlyDate,
	INCOME_SOURCES,
	PURCHASE_CATEGORIES,
	readBill,
	readIncome,
	readPurchase,
	type FinanceData,
} from "./finance";
import {
	addToRelation,
	appendRelation,
	createPage,
	P,
	plain,
	titleOf,
	trashPage,
	updatePage,
} from "./notion";
import type { Env } from "./types";

export interface Extraction {
	purchases: {
		item: string;
		amount: number;
		category: string;
		needOrWant: "Need" | "Want" | null;
		daysAgo: number;
		allowDuplicate: boolean;
	}[];
	incomes: {
		description: string;
		amount: number;
		source: string;
		daysAgo: number;
		allowDuplicate: boolean;
	}[];
	planned: { item: string; amount: number; date: string | null }[];
	savings: {
		goal: string;
		action: "create" | "add_saved" | "set_saved" | "set_target";
		amount: number;
	}[];
	bills: {
		name: string;
		action: "create" | "update" | "mark_paid";
		amount: number | null;
		frequency: string | null;
		dueDate: string | null;
	}[];
	markPaid: string[];
	undoLast: boolean;
}

export const EMPTY_EXTRACTION: Extraction = {
	purchases: [],
	incomes: [],
	planned: [],
	savings: [],
	bills: [],
	markPaid: [],
	undoLast: false,
};

export function hasActions(e: Extraction): boolean {
	return (
		e.undoLast ||
		e.purchases.length > 0 ||
		e.incomes.length > 0 ||
		e.planned.length > 0 ||
		e.savings.length > 0 ||
		e.bills.length > 0 ||
		e.markPaid.length > 0
	);
}

const SCHEMA = {
	type: "object",
	properties: {
		purchases: {
			type: "array",
			items: {
				type: "object",
				properties: {
					item: { type: "string" },
					amount: { type: "number" },
					category: { type: "string", enum: PURCHASE_CATEGORIES },
					need_or_want: { type: "string", enum: ["Need", "Want", "Unsure"] },
					days_ago: { type: "integer" },
					allow_duplicate: { type: "boolean" },
				},
				required: ["item", "amount", "category", "need_or_want", "days_ago", "allow_duplicate"],
			},
		},
		incomes: {
			type: "array",
			items: {
				type: "object",
				properties: {
					description: { type: "string" },
					amount: { type: "number" },
					source: { type: "string", enum: INCOME_SOURCES },
					days_ago: { type: "integer" },
					allow_duplicate: { type: "boolean" },
				},
				required: ["description", "amount", "source", "days_ago", "allow_duplicate"],
			},
		},
		planned: {
			type: "array",
			items: {
				type: "object",
				properties: {
					item: { type: "string" }, amount: { type: "number" }, date: { type: "string" },
				},
				required: ["item", "amount", "date"],
			},
		},
		savings: {
			type: "array",
			items: {
				type: "object",
				properties: {
					goal: { type: "string" },
					action: { type: "string", enum: ["create", "add_saved", "set_saved", "set_target"] },
					amount: { type: "number" },
				},
				required: ["goal", "action", "amount"],
			},
		},
		bills: {
			type: "array",
			items: {
				type: "object",
				properties: {
					name: { type: "string" },
					action: { type: "string", enum: ["create", "update", "mark_paid"] },
					amount: { type: ["number", "null"] },
					frequency: { type: ["string", "null"] },
					due_date: { type: ["string", "null"] },
				},
				required: ["name", "action", "amount", "frequency", "due_date"],
			},
		},
		mark_paid: { type: "array", items: { type: "string" } },
		undo_last: { type: "boolean" },
	},
	required: ["purchases", "incomes", "planned", "savings", "bills", "mark_paid", "undo_last"],
};

function extractionPrompt(today: string, weekday: string, plannedNames: string[]): string {
	return `You convert ONE message into structured financial actions. Today is ${weekday} ${today}.

Only extract actions that the user clearly states happened or clearly asks to change. Questions and hypotheticals produce no write actions.

PURCHASES: something already bought/spent. Category must be one of ${PURCHASE_CATEGORIES.join(", ")}. days_ago 0=today, 1=yesterday. allow_duplicate=true ONLY when wording clearly means another separate transaction, such as "another coffee", "again", "second one".

INCOMES: money actually earned/received. Source must be one of ${INCOME_SOURCES.join(", ")}. allow_duplicate=true only when clearly another separate payment.

PLANNED: a future one-time purchase that belongs in the Expenses plan and has an amount. Use YYYY-MM-DD or "" if no date.

SAVINGS: the dedicated savings-goal database.
- "I'm saving $2500 for Japan" => create, amount 2500.
- "add $75 to Japan" => add_saved, 75.
- "I've saved $400 for Japan" => set_saved, 400.
- "change my Japan goal to $3000" => set_target, 3000.
Do not turn ordinary planned purchases into savings goals unless the user talks about saving toward a named goal.

BILLS: recurring/regular expenses.
- "add Spotify at $12 monthly" => create.
- "my phone bill is $82 now" => update.
- "I paid Spotify" => mark_paid.
frequency may be Monthly, Weekly, Yearly, One-time, or null. due_date is YYYY-MM-DD or null.

MARK_PAID is retained for existing one-time planned purchases. Current planned items: ${plannedNames.length ? plannedNames.map((n) => `"${n}"`).join(", ") : "(none)"}.

UNDO_LAST=true only for an explicit request to undo/remove the most recently logged purchase/income.

Examples:
"I spent 5.25 on coffee" => one purchase, allow_duplicate false
"I bought another coffee for 5.25" => one purchase, allow_duplicate true
"got paid 1200 from work" => one income
"I'm saving 2500 for Japan" => one savings create
"add 100 to Japan" => one savings add_saved
"Netflix is 24.99 now" => one bill update
"can I afford a 40 dollar shirt?" => no actions

Return ONLY JSON.`;
}

export async function extractActions(
	env: Env,
	message: string,
	today: string,
	weekday: string,
	plannedNames: string[],
): Promise<Extraction> {
	const looksRelevant = /\d/.test(message) || /\b(undo|remove|delete|paid|bought|spent|earned|received|saving|save|bill|rent|subscription|another|again)\b/i.test(message);
	if (!looksRelevant) return EMPTY_EXTRACTION;
	try {
		const out = (await env.AI.run(EXTRACTION_MODEL_ID, {
			messages: [
				{ role: "system", content: extractionPrompt(today, weekday, plannedNames) },
				{ role: "user", content: message.slice(0, 1200) },
			],
			response_format: { type: "json_schema", json_schema: SCHEMA },
			max_tokens: 900,
			temperature: 0,
		} as any)) as any;
		let raw = out?.response ?? out;
		if (typeof raw === "string") raw = JSON.parse(raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());
		return sanitize(raw, today);
	} catch (error) {
		console.error("Extraction failed:", error);
		return EMPTY_EXTRACTION;
	}
}

const validAmount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0 && n < 1_000_000;
const money = (n: number) => `$${n.toFixed(2)}`;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const tidy = (s: unknown, max = 100) => {
	const value = typeof s === "string" ? s.trim().replace(/\s+/g, " ").slice(0, max) : "";
	return value ? value.charAt(0).toUpperCase() + value.slice(1) : "";
};
const clampDays = (n: unknown) => typeof n === "number" && Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 0), 60) : 0;
const r2 = (n: number) => Math.round(n * 100) / 100;
const THIRTY_MIN = 30 * 60 * 1000;

function cleanIso(value: unknown, today: string): string | null {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	let date = value;
	if (date < today) {
		const next = `${Number(date.slice(0, 4)) + 1}${date.slice(4)}`;
		if (next >= today) date = next;
	}
	return daysBetween(today, date) <= 800 ? date : null;
}

function sanitize(raw: any, today: string): Extraction {
	const arr = (v: unknown): any[] => Array.isArray(v) ? v.slice(0, 8) : [];
	const purchases = arr(raw?.purchases).filter((p) => tidy(p?.item) && validAmount(p?.amount)).map((p) => ({
		item: tidy(p.item), amount: r2(p.amount),
		category: PURCHASE_CATEGORIES.includes(p.category) ? p.category : "Other",
		needOrWant: (p.need_or_want === "Need" || p.need_or_want === "Want" ? p.need_or_want : null) as "Need" | "Want" | null,
		daysAgo: clampDays(p.days_ago), allowDuplicate: p.allow_duplicate === true,
	}));
	const incomes = arr(raw?.incomes).filter((i) => validAmount(i?.amount)).map((i) => ({
		description: tidy(i.description) || "Income", amount: r2(i.amount),
		source: INCOME_SOURCES.includes(i.source) ? i.source : "Other",
		daysAgo: clampDays(i.days_ago), allowDuplicate: i.allow_duplicate === true,
	}));
	const planned = arr(raw?.planned).filter((p) => tidy(p?.item) && validAmount(p?.amount)).map((p) => ({
		item: tidy(p.item), amount: r2(p.amount), date: cleanIso(p.date, today),
	}));
	const savings = arr(raw?.savings).filter((s) => tidy(s?.goal) && validAmount(s?.amount) && ["create","add_saved","set_saved","set_target"].includes(s?.action)).map((s) => ({
		goal: tidy(s.goal), action: s.action as "create" | "add_saved" | "set_saved" | "set_target", amount: r2(s.amount),
	}));
	const bills = arr(raw?.bills).filter((b) => tidy(b?.name) && ["create","update","mark_paid"].includes(b?.action)).map((b) => ({
		name: tidy(b.name), action: b.action as "create" | "update" | "mark_paid",
		amount: validAmount(b.amount) ? r2(b.amount) : null,
		frequency: typeof b.frequency === "string" && b.frequency.trim() ? tidy(b.frequency, 40) : null,
		dueDate: typeof b.due_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.due_date) ? b.due_date : null,
	}));
	const markPaid = arr(raw?.mark_paid).map((s) => tidy(s)).filter(Boolean);
	return { purchases, incomes, planned, savings, bills, markPaid, undoLast: raw?.undo_last === true };
}

export interface LogReport {
	saved: string[];
	planned: string[];
	updated: string[];
	markedPaid: string[];
	undone: string | null;
	duplicates: string[];
	needsInfo: string[];
	failures: string[];
	guessedNeedWant: boolean;
	linked: string[];
	changed: boolean;
	incomeSaved: boolean;
}

export function emptyReport(): LogReport {
	return { saved: [], planned: [], updated: [], markedPaid: [], undone: null, duplicates: [], needsInfo: [], failures: [], guessedNeedWant: false, linked: [], changed: false, incomeSaved: false };
}

function findNamed<T extends { name?: string; goal?: string }>(items: T[], name: string): T[] {
	const needle = norm(name);
	return items.filter((item) => {
		const value = norm(String(item.name ?? item.goal ?? ""));
		return value === needle || value.includes(needle) || needle.includes(value);
	});
}

function savingsRows(data: FinanceData) {
	return data.savings.map((page) => ({
		page,
		goal: titleOf(page),
		target: Number(plain(page.properties["Target Amount"]) ?? 0),
		saved: Number(plain(page.properties["Saved So Far"]) ?? 0),
	}));
}

function pickPlannedCategory(data: FinanceData): string | null {
	return data.categories.find((c) => /fun|entertain|social|event|misc|other/i.test(titleOf(c)))?.id ?? null;
}

export async function applyActions(
	env: Env,
	data: FinanceData,
	ex: Extraction,
	today: string,
	report: LogReport = emptyReport(),
	now = Date.now(),
): Promise<LogReport> {
	if (ex.undoLast) {
		const candidates = [
			...data.purchases.map((page) => ({ page, kind: "purchase" as const })),
			...data.incomes.map((page) => ({ page, kind: "income" as const })),
		].filter((c) => c.page.created_time && now - Date.parse(c.page.created_time) <= THIRTY_MIN)
		 .sort((a,b) => Date.parse(b.page.created_time!) - Date.parse(a.page.created_time!));
		const target = candidates[0];
		if (!target) report.failures.push("There isn't a purchase or income from the last 30 minutes to undo.");
		else try {
			await trashPage(env, target.page.id);
			const label = target.kind === "purchase" ? (() => { const p=readPurchase(target.page); return `${p.item} — ${money(p.amount)}`; })() : (() => { const i=readIncome(target.page); return `${i.title} — ${money(i.amount)}`; })();
			report.undone = label; report.changed = true;
			data.purchases = data.purchases.filter((p) => p.id !== target.page.id);
			data.incomes = data.incomes.filter((p) => p.id !== target.page.id);
		} catch (e) { report.failures.push(`Couldn't remove it: ${explainWriteError(e)}`); }
		return report;
	}

	for (const p of ex.purchases) {
		const date = addDays(today, -p.daysAgo);
		const duplicate = data.purchases.map(readPurchase).find((x) => norm(x.item) === norm(p.item) && x.amount === p.amount && x.date === date);
		if (duplicate && !p.allowDuplicate) {
			report.duplicates.push(`${p.item} — ${money(p.amount)} on ${friendlyDate(date, today)}`);
			report.needsInfo.push(`I already see ${p.item} for ${money(p.amount)} ${friendlyDate(date, today)}. If this was a separate purchase, say “another ${p.item} for ${money(p.amount)}.”`);
			continue;
		}
		const guessed = p.needOrWant === null;
		const needOrWant = p.needOrWant ?? (p.category === "Groceries" ? "Need" : "Want");
		try {
			const page = await createPage(env, DS.purchases, { Item:P.title(p.item), Amount:P.number(p.amount), Category:P.select(p.category), Date:P.date(date), "Need or Want":P.select(needOrWant) });
			data.purchases.push(page); report.changed = true; if (guessed) report.guessedNeedWant = true;
			const week = findWeekFor(data.weeks, date); let weekNote="";
			if (week) try { await appendRelation(env, week.id, "Daily Purchases", page.id); weekNote=` · ${week.title}`; } catch(e) { report.failures.push(`Saved "${p.item}" but couldn't link it to the week: ${explainWriteError(e)}`); }
			report.saved.push(`${p.item} — ${money(p.amount)} · ${p.category} · ${needOrWant} · ${friendlyDate(date,today)}${weekNote}`);
		} catch(e) { report.failures.push(`Couldn't save "${p.item}": ${explainWriteError(e)}`); }
	}

	for (const inc of ex.incomes) {
		const date = addDays(today, -inc.daysAgo);
		const duplicate = data.incomes.map(readIncome).find((x) => x.amount === inc.amount && norm(x.source ?? "Other") === norm(inc.source) && x.date === date);
		if (duplicate && !inc.allowDuplicate) {
			report.duplicates.push(`Income ${money(inc.amount)} · ${inc.source} · ${friendlyDate(date,today)}`);
			report.needsInfo.push(`I already see ${money(inc.amount)} of ${inc.source} income ${friendlyDate(date,today)}. If this is a second payment, tell me it was another payment.`);
			continue;
		}
		try {
			const month=findMonthFor(data.months,date);
			const page=await createPage(env,DS.incomes,{ Income:P.title(inc.description), Amount:P.number(inc.amount), income:P.select(inc.source), Date:P.date(date), ...(month?{Month:P.relation([month.id])}:{}) });
			data.incomes.push(page); report.changed=true; report.incomeSaved=true;
			const week=findWeekFor(data.weeks,date); let weekNote="";
			if(week) try{await appendRelation(env,week.id,"Incomes",page.id);weekNote=` · ${week.title}`;}catch(e){report.failures.push(`Saved income but couldn't link it to the week: ${explainWriteError(e)}`);}
			report.saved.push(`Income: ${inc.description} — ${money(inc.amount)} · ${inc.source} · ${friendlyDate(date,today)}${weekNote}`);
		}catch(e){report.failures.push(`Couldn't save the income "${inc.description}": ${explainWriteError(e)}`);}
	}

	for (const s of ex.savings) {
		const rows=savingsRows(data); const matches=findNamed(rows,s.goal);
		if(s.action==="create"){
			if(matches.length){ report.duplicates.push(`${s.goal} is already in Things I'm Saving For`); continue; }
			try{const titleProp=Object.entries(data.savings[0]?.properties??{}).find(([,v]:any)=>v?.type==="title")?.[0]??"Goal";const page=await createPage(env,DS.savings,{ [titleProp]:P.title(s.goal), "Target Amount":P.number(s.amount), "Saved So Far":P.number(0) }); data.savings.push(page); report.changed=true; report.updated.push(`Started savings goal ${s.goal} — target ${money(s.amount)}`);}catch(e){report.failures.push(`Couldn't create savings goal "${s.goal}": ${explainWriteError(e)}`);} continue;
		}
		if(matches.length!==1){ report.needsInfo.push(matches.length?`More than one savings goal matches "${s.goal}". Please use the exact goal name.`:`I couldn't find a savings goal called "${s.goal}".`); continue; }
		const row=matches[0];
		try{
			if(s.action==="add_saved"){const next=r2(row.saved+s.amount);await updatePage(env,row.page.id,{properties:{"Saved So Far":P.number(next)}});row.page.properties["Saved So Far"]={type:"number",number:next};report.updated.push(`${row.goal}: saved amount ${money(row.saved)} → ${money(next)}`);}
			if(s.action==="set_saved"){await updatePage(env,row.page.id,{properties:{"Saved So Far":P.number(s.amount)}});row.page.properties["Saved So Far"]={type:"number",number:s.amount};report.updated.push(`${row.goal}: saved so far set to ${money(s.amount)}`);}
			if(s.action==="set_target"){await updatePage(env,row.page.id,{properties:{"Target Amount":P.number(s.amount)}});row.page.properties["Target Amount"]={type:"number",number:s.amount};report.updated.push(`${row.goal}: target set to ${money(s.amount)}`);}
			report.changed=true;
		}catch(e){report.failures.push(`Couldn't update savings goal "${row.goal}": ${explainWriteError(e)}`);}
	}

	for(const b of ex.bills){
		const rows=data.expenses.map(page=>({page,bill:readBill(page)})); const matches=findNamed(rows.map(x=>({name:x.bill.name,...x})),b.name);
		if(b.action==="create"){
			if(matches.length){report.duplicates.push(`${b.name} already exists in your bills/expenses`);continue;}
			if(!b.amount){report.needsInfo.push(`What amount should I use for ${b.name}?`);continue;}
			try{const page=await createPage(env,DS.expenses,{Expense:P.title(b.name),Amount:P.number(b.amount),Frequency:P.select(b.frequency||"Monthly"),Status:P.status("Not paid"),...(b.dueDate?{"Due Date":P.date(b.dueDate)}:{})});data.expenses.push(page);report.changed=true;report.updated.push(`Added recurring bill ${b.name} — ${money(b.amount)} · ${b.frequency||"Monthly"}`);}catch(e){report.failures.push(`Couldn't add bill "${b.name}": ${explainWriteError(e)}`);}continue;
		}
		if(matches.length!==1){report.needsInfo.push(matches.length?`More than one bill matches "${b.name}". Please use the exact name.`:`I couldn't find a bill called "${b.name}".`);continue;}
		const {page,bill}=matches[0] as any;
		try{
			if(b.action==="mark_paid"){await updatePage(env,page.id,{properties:{Status:P.status("Paid")}});page.properties["Status"]={type:"status",status:{name:"Paid"}};report.markedPaid.push(`${bill.name} — ${money(bill.amount)} marked paid`);}
			else{const props:Record<string,unknown>={};if(b.amount)props.Amount=P.number(b.amount);if(b.frequency)props.Frequency=P.select(b.frequency);if(b.dueDate)props["Due Date"]=P.date(b.dueDate);if(!Object.keys(props).length){report.needsInfo.push(`What should I change about ${bill.name}?`);continue;}await updatePage(env,page.id,{properties:props});report.updated.push(`${bill.name} updated${b.amount?` to ${money(b.amount)}`:""}`);}
			report.changed=true;
		}catch(e){report.failures.push(`Couldn't update bill "${bill.name}": ${explainWriteError(e)}`);}
	}

	for(const pl of ex.planned){
		if(!pl.date){report.needsInfo.push(`${pl.item} (${money(pl.amount)}): what date do you need the money by?`);continue;}
		const already=data.expenses.map(readBill).find(b=>norm(b.name)===norm(pl.item)&&b.amount===pl.amount&&b.status!=="Paid");
		if(already){report.duplicates.push(`${pl.item} is already in your plan`);continue;}
		try{const month=findMonthFor(data.months,pl.date);const categoryId=pickPlannedCategory(data);const page=await createPage(env,DS.expenses,{Expense:P.title(pl.item),Amount:P.number(pl.amount),Frequency:P.select("One-time"),Status:P.status("Not paid"),"Due Date":P.date(pl.date),...(categoryId?{Category:P.relation([categoryId])}:{}),...(month?{Month:P.relation([month.id])}:{})});data.expenses.push(page);report.changed=true;const week=findWeekFor(data.weeks,pl.date);if(week)try{await appendRelation(env,week.id,"Expenses",page.id);}catch{}const weeks=Math.max(1,Math.ceil(daysBetween(today,pl.date)/7));report.planned.push(`${pl.item} — ${money(pl.amount)} · due ${friendlyDate(pl.date,today)}${weeks>1?` · about ${money(pl.amount/weeks)}/week`:""}`);}catch(e){report.failures.push(`Couldn't add "${pl.item}" to your plan: ${explainWriteError(e)}`);}
	}

	for(const name of ex.markPaid){
		const needle=norm(name);const matches=data.expenses.map(page=>({page,bill:readBill(page)})).filter(({bill})=>bill.status!=="Paid"&&(norm(bill.name).includes(needle)||needle.includes(norm(bill.name))));
		if(matches.length!==1){report.needsInfo.push(matches.length?`More than one unpaid item matches "${name}".`:`I couldn't find "${name}" in your unpaid plan.`);continue;}
		const {page,bill}=matches[0];try{await updatePage(env,page.id,{properties:{Status:P.status("Paid")}});page.properties["Status"]={type:"status",status:{name:"Paid"}};report.markedPaid.push(`${bill.name} — ${money(bill.amount)} marked paid`);report.changed=true;}catch(e){report.failures.push(`Couldn't mark "${bill.name}" paid: ${explainWriteError(e)}`);}
	}
	return report;
}

export function formatReport(r: LogReport): string {
	const lines:string[]=[];
	if(r.saved.length){lines.push("### Saved to Notion");r.saved.forEach(x=>lines.push(`- ${x}`));}
	if(r.updated.length){lines.push("### Updated in Notion");r.updated.forEach(x=>lines.push(`- ${x}`));}
	if(r.planned.length){lines.push("### Added to your plan");r.planned.forEach(x=>lines.push(`- ${x}`));}
	r.markedPaid.forEach(x=>lines.push(`- ✅ ${x}`));
	if(r.undone)lines.push(`- ↩️ Removed: ${r.undone}`);
	r.duplicates.forEach(x=>lines.push(`NOTE: I didn't add a duplicate: ${x}`));
	r.needsInfo.forEach(x=>lines.push(`WATCH: ${x}`));
	r.failures.forEach(x=>lines.push(`WATCH: ${x}`));
	if(r.guessedNeedWant)lines.push("NOTE: I guessed Need vs Want on one or more purchases; you can correct me.");
	return lines.length?lines.join("\n")+"\n\n":"";
}

export function reportForModel(r:LogReport):string|null{
	const any=r.saved.length||r.updated.length||r.planned.length||r.markedPaid.length||r.undone||r.duplicates.length||r.needsInfo.length||r.failures.length;
	if(!any)return null;
	return `JUST HANDLED THIS TURN (code-generated; do not contradict it):\n${JSON.stringify(r)}\nThe user already sees the confirmation. Add only the useful interpretation or answer. Never claim a write succeeded unless it appears here.`;
}

export function plannedNamesOf(data:FinanceData):string[]{return data.expenses.map(readBill).filter(b=>b.frequency==="One-time"&&b.status!=="Paid"&&b.name).map(b=>b.name).slice(0,20);}

export async function syncLinks(env:Env,data:FinanceData,today:string,report:LogReport):Promise<void>{
	if(!AUTO_LINK_IN_NOTION)return;
	try{
		const week=findWeekFor(data.weeks,today);
		if(week){const inWeek=(d:string|null)=>!!d&&d>=week.range.start&&d<=week.range.end;const groups=[{prop:"Incomes",label:"income",ids:data.incomes.map(readIncome).filter(i=>inWeek(i.date)&&i.amount>0).map(i=>i.id)},{prop:"Daily Purchases",label:"purchase",ids:data.purchases.map(readPurchase).filter(p=>inWeek(p.date)&&p.amount>0).map(p=>p.id)}];
			for(const g of groups){const linked=new Set<string>(plain(week.page.properties[g.prop])??[]);const missing=g.ids.filter(id=>!linked.has(id));if(!missing.length)continue;try{const added=await addToRelation(env,week.id,g.prop,missing);if(added>0){report.changed=true;report.linked.push(`Linked ${added} ${g.label} ${added===1?"entry":"entries"} to ${week.title}.`);}}catch(e){report.failures.push(`Couldn't link ${g.label} rows to ${week.title}: ${explainWriteError(e)}`);}}
		}
		let fixed=0;for(const page of data.incomes){if(fixed>=15)break;const inc=readIncome(page);if(inc.monthIds.length||!inc.date||inc.amount<=0)continue;const month=findMonthFor(data.months,inc.date);if(!month)continue;try{await updatePage(env,page.id,{properties:{Month:P.relation([month.id])}});page.properties["Month"]={type:"relation",relation:[{id:month.id}]};fixed++;}catch{break;}}
		if(fixed){report.changed=true;report.linked.push(`Linked ${fixed} income ${fixed===1?"entry":"entries"} to the correct month.`);}
	}catch(error){console.error("syncLinks failed:",error);}
}
