/**
 * Turns what Veronica says ("I got a latte for 6.25", "concert tickets are $180
 * on Oct 25") into entries in her Notion databases.
 *
 * Flow: a small, strict AI call reads the message and returns JSON -> this file
 * validates every field in code -> writes to Notion -> reports exactly what
 * happened (so Fin never claims something was saved when it wasn't).
 */
import { MODEL_ID } from "./config";
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
	readPurchase,
	readIncome,
	type FinanceData,
} from "./finance";
import { appendRelation, createPage, P, titleOf, trashPage, updatePage } from "./notion";
import type { Env } from "./types";

/* ---------------- What the AI extracts ---------------- */

export interface Extraction {
	purchases: {
		item: string;
		amount: number;
		category: string;
		needOrWant: "Need" | "Want" | null;
		daysAgo: number;
	}[];
	incomes: { description: string; amount: number; source: string; daysAgo: number }[];
	planned: { item: string; amount: number; date: string | null }[];
	markPaid: string[];
	undoLast: boolean;
}

export const EMPTY_EXTRACTION: Extraction = {
	purchases: [],
	incomes: [],
	planned: [],
	markPaid: [],
	undoLast: false,
};

export function hasActions(e: Extraction): boolean {
	return (
		e.undoLast ||
		e.purchases.length > 0 ||
		e.incomes.length > 0 ||
		e.planned.length > 0 ||
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
				},
				required: ["item", "amount", "category", "need_or_want", "days_ago"],
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
				},
				required: ["description", "amount", "source", "days_ago"],
			},
		},
		planned: {
			type: "array",
			items: {
				type: "object",
				properties: {
					item: { type: "string" },
					amount: { type: "number" },
					date: { type: "string" },
				},
				required: ["item", "amount", "date"],
			},
		},
		mark_paid: { type: "array", items: { type: "string" } },
		undo_last: { type: "boolean" },
	},
	required: ["purchases", "incomes", "planned", "mark_paid", "undo_last"],
};

function extractionPrompt(today: string, weekday: string, plannedNames: string[]): string {
	return `You read ONE message from Veronica, who tracks her money in Notion. Decide whether she is TELLING you about money that already moved or something she is planning (save it), or just asking/chatting (save nothing).

Today is ${weekday} ${today}.

PURCHASES (already bought). Only when she says she bought/spent/paid for something ("I got", "just bought", "spent", "grabbed"). One entry per item. amount = plain number of dollars.
- category: "Eating Out" (restaurants, takeout, delivery, fast food), "Coffee" (cafes, tea, coffee drinks), "Groceries" (grocery store, food to cook at home), "Fun" (entertainment, hobbies, games, shopping for wants), "Other" (gas, household, medicine, everything else).
- need_or_want: "Need" for essentials (groceries, gas, medicine, basics), "Want" for extras, "Unsure" if you can't tell.
- days_ago: 0 for today or not mentioned, 1 for yesterday, 2 for two days ago, etc.

INCOMES. Only when she says she earned, got paid or received money. source is one of ${INCOME_SOURCES.join(", ")}.

PLANNED = an important FUTURE purchase she wants to make or save for (concert or event tickets, flights, trips, big gifts, anything expensive). Phrases like "I want to buy", "I need to save for", "add ... to my plan", "tickets are $X on <date>". NOT things she already bought.
- date = the day the money is needed, or the event date if she doesn't say, as YYYY-MM-DD. If she gives no year, use the next time that date happens after today. Use "" if she gave no date.

MARK_PAID: she says she has now bought/paid for something already on her planned list. Her planned list right now: ${plannedNames.length ? plannedNames.map((n) => `"${n}"`).join(", ") : "(empty)"}. If her message is about one of these, put its exact name in mark_paid and do NOT also add it to purchases.

UNDO_LAST: true only if she asks to undo, remove or delete the last thing that was logged.

Never save questions, hypotheticals or thinking-out-loud ("can I afford...", "should I buy...", "how much did I spend..."). If nothing should be saved return empty arrays and false.

Examples:
"got a latte for 6.25" -> purchases: [{item:"Latte", amount:6.25, category:"Coffee", need_or_want:"Want", days_ago:0}]
"yesterday I spent 43.10 at Safeway and 12 on a burrito" -> two purchases, days_ago 1: Groceries/Need and Eating Out/Want
"got paid 412 from work" -> incomes: [{description:"Paycheck", amount:412, source:"Wages", days_ago:0}]
"I want to go to the Wicked concert, tickets are $180 on Oct 25" -> planned: [{item:"Wicked concert tickets", amount:180, date:"<Oct 25 as YYYY-MM-DD>"}]
"can I afford a $40 shirt?" -> nothing
"undo that" -> undo_last: true

Return ONLY JSON.`;
}

/** Calls the model and returns a cleaned-up, validated Extraction. Never throws. */
export async function extractActions(
	env: Env,
	message: string,
	today: string,
	weekday: string,
	plannedNames: string[],
): Promise<Extraction> {
	const looksRelevant =
		/\d/.test(message) ||
		/\b(undo|take that back|remove that|delete that|delete the last|remove the last)\b/i.test(message) ||
		(plannedNames.length > 0 && /\b(bought|got|paid|booked|purchased|ordered)\b/i.test(message));
	if (!looksRelevant) return EMPTY_EXTRACTION;

	try {
		const body = {
			messages: [
				{ role: "system", content: extractionPrompt(today, weekday, plannedNames) },
				{ role: "user", content: message.slice(0, 1000) },
			],
			response_format: { type: "json_schema", json_schema: SCHEMA },
			max_tokens: 600,
			temperature: 0,
		};
		const out = (await env.AI.run(MODEL_ID, body as any)) as unknown as any;

		let raw: any = out?.response ?? out;
		if (typeof raw === "string") {
			raw = JSON.parse(raw.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());
		}
		return sanitize(raw, today);
	} catch (e) {
		console.error("Extraction failed:", e);
		return EMPTY_EXTRACTION;
	}
}

const validAmount = (n: unknown): n is number =>
	typeof n === "number" && Number.isFinite(n) && n > 0 && n < 100_000;
const clampDays = (n: unknown): number =>
	typeof n === "number" && Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 0), 60) : 0;
const tidy = (s: unknown, max = 100): string => {
	const t = typeof s === "string" ? s.trim().replace(/\s+/g, " ").slice(0, max) : "";
	return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
};

function sanitize(raw: any, today: string): Extraction {
	const arr = (v: unknown): any[] => (Array.isArray(v) ? v.slice(0, 8) : []);

	const purchases = arr(raw?.purchases)
		.filter((p) => tidy(p?.item) && validAmount(p?.amount))
		.map((p) => ({
			item: tidy(p.item),
			amount: Math.round(p.amount * 100) / 100,
			category: PURCHASE_CATEGORIES.includes(p.category) ? p.category : "Other",
			needOrWant: (p.need_or_want === "Need" || p.need_or_want === "Want" ? p.need_or_want : null) as
				| "Need"
				| "Want"
				| null,
			daysAgo: clampDays(p.days_ago),
		}));

	const incomes = arr(raw?.incomes)
		.filter((i) => validAmount(i?.amount))
		.map((i) => ({
			description: tidy(i.description) || "Income",
			amount: Math.round(i.amount * 100) / 100,
			source: INCOME_SOURCES.includes(i.source) ? i.source : "Other",
			daysAgo: clampDays(i.days_ago),
		}));

	const planned = arr(raw?.planned)
		.filter((p) => tidy(p?.item) && validAmount(p?.amount))
		.map((p) => {
			let date: string | null = /^\d{4}-\d{2}-\d{2}$/.test(p.date ?? "") ? p.date : null;
			// The model sometimes picks a date that has already passed; move it to next year.
			if (date && date < today) {
				const next = `${Number(date.slice(0, 4)) + 1}${date.slice(4)}`;
				date = next >= today ? next : null;
			}
			if (date && daysBetween(today, date) > 800) date = null;
			return { item: tidy(p.item), amount: Math.round(p.amount * 100) / 100, date };
		});

	const markPaid = arr(raw?.mark_paid).map((s) => tidy(s)).filter(Boolean);

	return { purchases, incomes, planned, markPaid, undoLast: raw?.undo_last === true };
}

/* ---------------- Writing to Notion ---------------- */

export interface LogReport {
	saved: string[];
	planned: string[];
	markedPaid: string[];
	undone: string | null;
	duplicates: string[];
	needsInfo: string[];
	failures: string[];
	guessedNeedWant: boolean;
	/** True if anything in Notion changed (so Notion's own formulas may lag). */
	changed: boolean;
}

export function emptyReport(): LogReport {
	return {
		saved: [],
		planned: [],
		markedPaid: [],
		undone: null,
		duplicates: [],
		needsInfo: [],
		failures: [],
		guessedNeedWant: false,
		changed: false,
	};
}

const money = (n: number) => `$${n.toFixed(2)}`;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const THIRTY_MIN = 30 * 60 * 1000;
const THREE_MIN = 3 * 60 * 1000;

/** Picks a Budget Database category for planned splurges (fun / entertainment...). */
function pickPlannedCategory(data: FinanceData): string | null {
	const match = data.categories.find((c) => /fun|entertain|social|event|misc|other/i.test(titleOf(c)));
	return match?.id ?? null;
}

export async function applyActions(
	env: Env,
	data: FinanceData,
	ex: Extraction,
	today: string,
	now = Date.now(),
): Promise<LogReport> {
	const report = emptyReport();

	/* ---- Undo (only ever the most recent entry, within 30 minutes) ---- */
	if (ex.undoLast) {
		const candidates = [
			...data.purchases.map((page) => ({ page, kind: "purchase" })),
			...data.incomes.map((page) => ({ page, kind: "income" })),
		]
			.filter((c) => c.page.created_time && now - Date.parse(c.page.created_time) <= THIRTY_MIN)
			.sort((a, b) => Date.parse(b.page.created_time!) - Date.parse(a.page.created_time!));
		const target = candidates[0];
		if (!target) {
			report.failures.push(
				"There's nothing logged in the last 30 minutes to undo. Older entries can be removed directly in Notion.",
			);
		} else {
			try {
				await trashPage(env, target.page.id);
				const label =
					target.kind === "purchase"
						? (() => {
								const p = readPurchase(target.page);
								return `${p.item} — ${money(p.amount)}`;
							})()
						: (() => {
								const i = readIncome(target.page);
								return `${i.title} — ${money(i.amount)}`;
							})();
				report.undone = label;
				report.changed = true;
				data.purchases = data.purchases.filter((p) => p.id !== target.page.id);
				data.incomes = data.incomes.filter((p) => p.id !== target.page.id);
			} catch (e) {
				report.failures.push(`Couldn't remove it: ${explainWriteError(e)}`);
			}
		}
		return report; // undo never combines with saving new things
	}

	/* ---- Purchases ---- */
	for (const p of ex.purchases) {
		const date = addDays(today, -p.daysAgo);
		const dup = data.purchases.map(readPurchase).find(
			(x) =>
				norm(x.item) === norm(p.item) &&
				x.amount === p.amount &&
				x.date === date &&
				x.createdTime &&
				now - Date.parse(x.createdTime) <= THREE_MIN,
		);
		if (dup) {
			report.duplicates.push(`${p.item} — ${money(p.amount)}`);
			continue;
		}

		const guessed = p.needOrWant === null;
		const needOrWant = p.needOrWant ?? (p.category === "Groceries" ? "Need" : "Want");

		try {
			const page = await createPage(env, DS.purchases, {
				Item: P.title(p.item),
				Amount: P.number(p.amount),
				Category: P.select(p.category),
				Date: P.date(date),
				"Need or Want": P.select(needOrWant),
			});
			data.purchases.push(page);
			report.changed = true;
			if (guessed) report.guessedNeedWant = true;

			let weekNote = "";
			const week = findWeekFor(data.weeks, date);
			if (week) {
				try {
					await appendRelation(env, week.id, "Daily Purchases", page.id);
					weekNote = ` · added to ${week.title}`;
				} catch (e) {
					report.failures.push(
						`Saved "${p.item}" but couldn't attach it to the week: ${explainWriteError(e)}`,
					);
				}
			}
			report.saved.push(
				`${p.item} — ${money(p.amount)} · ${p.category} · ${needOrWant}${guessed ? " (my guess)" : ""} · ${friendlyDate(date, today)}${weekNote}`,
			);
		} catch (e) {
			report.failures.push(`Couldn't save "${p.item}": ${explainWriteError(e)}`);
		}
	}

	/* ---- Income ---- */
	for (const inc of ex.incomes) {
		const date = addDays(today, -inc.daysAgo);
		try {
			const month = findMonthFor(data.months, date);
			const page = await createPage(env, DS.incomes, {
				Income: P.title(inc.description),
				Amount: P.number(inc.amount),
				income: P.select(inc.source),
				Date: P.date(date),
				...(month ? { Month: P.relation([month.id]) } : {}),
			});
			data.incomes.push(page);
			report.changed = true;

			let weekNote = "";
			const week = findWeekFor(data.weeks, date);
			if (week) {
				try {
					await appendRelation(env, week.id, "Incomes", page.id);
					weekNote = ` · added to ${week.title}`;
				} catch (e) {
					report.failures.push(
						`Saved "${inc.description}" but couldn't attach it to the week: ${explainWriteError(e)}`,
					);
				}
			}
			report.saved.push(
				`Income: ${inc.description} — ${money(inc.amount)} · ${inc.source} · ${friendlyDate(date, today)}${weekNote}`,
			);
		} catch (e) {
			report.failures.push(`Couldn't save the income "${inc.description}": ${explainWriteError(e)}`);
		}
	}

	/* ---- Planned (important future) purchases -> Expenses, One-time, Not paid ---- */
	for (const pl of ex.planned) {
		if (!pl.date) {
			report.needsInfo.push(
				`${pl.item} (${money(pl.amount)}): what date do you need to pay by, or when is the event? I need it to fit it into your weekly plan.`,
			);
			continue;
		}
		const already = data.expenses.map(readBill).find(
			(b) => norm(b.name) === norm(pl.item) && b.amount === pl.amount && b.status !== "Paid",
		);
		if (already) {
			report.duplicates.push(`${pl.item} is already in your plan`);
			continue;
		}

		try {
			const month = findMonthFor(data.months, pl.date);
			const categoryId = pickPlannedCategory(data);
			const page = await createPage(env, DS.expenses, {
				Expense: P.title(pl.item),
				Amount: P.number(pl.amount),
				Frequency: P.select("One-time"),
				Status: P.status("Not paid"),
				"Due Date": P.date(pl.date),
				...(categoryId ? { Category: P.relation([categoryId]) } : {}),
				...(month ? { Month: P.relation([month.id]) } : {}),
			});
			data.expenses.push(page);
			report.changed = true;

			const week = findWeekFor(data.weeks, pl.date);
			if (week) {
				try {
					await appendRelation(env, week.id, "Expenses", page.id);
				} catch (e) {
					report.failures.push(
						`Planned "${pl.item}" but couldn't attach it to its week: ${explainWriteError(e)}`,
					);
				}
			}

			const weeksLeft = Math.max(1, Math.ceil(daysBetween(today, pl.date) / 7));
			const setAside = weeksLeft > 1 ? ` · about ${money(pl.amount / weeksLeft)}/week to set aside (${weeksLeft} weeks)` : "";
			report.planned.push(`${pl.item} — ${money(pl.amount)} · due ${friendlyDate(pl.date, today)}${setAside}`);
		} catch (e) {
			report.failures.push(`Couldn't add "${pl.item}" to your plan: ${explainWriteError(e)}`);
		}
	}

	/* ---- Marking a planned purchase as bought ---- */
	for (const name of ex.markPaid) {
		const needle = norm(name);
		const matches = data.expenses
			.map((page) => ({ page, bill: readBill(page) }))
			.filter(
				({ bill }) =>
					bill.status !== "Paid" &&
					(norm(bill.name).includes(needle) || needle.includes(norm(bill.name))),
			);
		if (matches.length !== 1) {
			report.failures.push(
				matches.length === 0
					? `I couldn't find "${name}" in your unpaid plan.`
					: `More than one unpaid item looks like "${name}", so I didn't guess. Which one did you mean?`,
			);
			continue;
		}
		const { page, bill } = matches[0];
		try {
			await updatePage(env, page.id, { properties: { Status: P.status("Paid") } });
			page.properties["Status"] = { type: "status", status: { name: "Paid" } };
			report.markedPaid.push(`${bill.name} — ${money(bill.amount)} marked as paid`);
			report.changed = true;
		} catch (e) {
			report.failures.push(`Couldn't mark "${bill.name}" as paid: ${explainWriteError(e)}`);
		}
	}

	return report;
}

/* ---------------- Messages ---------------- */

/** The confirmation Veronica sees first. Written by code, not the AI, so it's always accurate. */
export function formatReport(r: LogReport): string {
	const lines: string[] = [];
	if (r.saved.length) {
		lines.push("🎃 Saved to Notion:");
		r.saved.forEach((s) => lines.push(`• ${s}`));
	}
	if (r.planned.length) {
		lines.push("🎟️ Added to your plan:");
		r.planned.forEach((s) => lines.push(`• ${s}`));
	}
	r.markedPaid.forEach((s) => lines.push(`✅ ${s}`));
	if (r.undone) lines.push(`↩️ Removed: ${r.undone}`);
	r.duplicates.forEach((s) => lines.push(`👻 Already have it: ${s}`));
	r.needsInfo.forEach((s) => lines.push(`❓ ${s}`));
	r.failures.forEach((s) => lines.push(`⚠️ ${s}`));
	if (r.guessedNeedWant) lines.push("(I guessed Need vs Want on some. Tell me if I got one wrong.)");
	return lines.length ? lines.join("\n") + "\n\n" : "";
}

export function reportForModel(r: LogReport): string | null {
	const any =
		r.saved.length ||
		r.planned.length ||
		r.markedPaid.length ||
		r.undone ||
		r.duplicates.length ||
		r.needsInfo.length ||
		r.failures.length;
	if (!any) return null;
	return `JUST HANDLED THIS TURN (Veronica already saw a confirmation list, so do NOT repeat it):
${JSON.stringify(r)}
Add one short, useful comment: how this changes this week or the plan, or the one question she still needs to answer (see needsInfo). If failures is not empty, tell her plainly and briefly what to check. Never say something was saved unless it's in saved/planned/markedPaid.`;
}

/** Names of unpaid one-time expenses, so the extractor can spot "I bought the tickets". */
export function plannedNamesOf(data: FinanceData): string[] {
	return data.expenses
		.map(readBill)
		.filter((b) => b.frequency === "One-time" && b.status !== "Paid" && b.name)
		.map((b) => b.name)
		.slice(0, 15);
}

