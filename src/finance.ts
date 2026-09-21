/**
 * Everything about reading the Financial Planner in Notion and turning
 * it into numbers Fin can trust.
 *
 * Important accuracy rule:
 * We intentionally load recent purchase/income rows by created_time and filter
 * by their effective Date in code. Filtering Notion by the Date property would
 * silently exclude rows whose Date is blank even though Fin can safely fall
 * back to created_time for those rows.
 */
import type { Env } from "./types";
import { NotionError, plain, queryAll, titleOf, type NotionPage } from "./notion";

export const DS = {
	purchases: "5592e80b-ca38-46c7-b22a-208a67f838bf",
	expenses: "bc89563c-5751-82a7-8836-87c7be4dae11",
	incomes: "1b89563c-5751-8333-9e55-0775f5324fba",
	categories: "0c19563c-5751-82f4-bfb9-070a31bb4ab3",
	months: "3d69563c-5751-8345-a39c-87bf3c5a1dd9",
	weeks: "591e9663-ff4d-4a2b-b113-3a1a794457db",
	savings: "9b516336-2578-47fe-b551-b30d401d9ba2",
	debts: "84919463-2d56-4fd8-9a37-1ea7aee10450",
} as const;

export const PURCHASE_CATEGORIES = ["Eating Out", "Coffee", "Groceries", "Fun", "Other"];
export const INCOME_SOURCES = ["Wages", "Tips", "Rover", "Babysitting/Sitting", "Other"];

const DAY_MS = 86_400_000;
const MONTH_NAMES = [
	"January", "February", "March", "April", "May", "June",
	"July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function todayIn(tz: string, now = new Date()): string {
	try {
		return new Intl.DateTimeFormat("en-CA", {
			timeZone: tz,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).format(now);
	} catch {
		return now.toISOString().slice(0, 10);
	}
}

function toUtc(iso: string): number {
	const [y, m, d] = iso.split("-").map(Number);
	return Date.UTC(y, m - 1, d);
}

export function addDays(iso: string, n: number): string {
	return new Date(toUtc(iso) + n * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
	return Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
}

export function weekdayName(iso: string): string {
	return WEEKDAYS[new Date(toUtc(iso)).getUTCDay()];
}

export function friendlyDate(iso: string, today: string): string {
	if (iso === today) return "today";
	if (iso === addDays(today, -1)) return "yesterday";
	const [, m, d] = iso.split("-").map(Number);
	return `${weekdayName(iso).slice(0, 3)} ${MONTH_NAMES[m - 1].slice(0, 3)} ${d}`;
}

function lastDayOfMonth(iso: string): string {
	const [y, m] = iso.split("-").map(Number);
	return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function mondayWeek(iso: string): { start: string; end: string } {
	const dow = new Date(toUtc(iso)).getUTCDay();
	const start = addDays(iso, -((dow + 6) % 7));
	return { start, end: addDays(start, 6) };
}

function dateOnly(v: unknown): string | null {
	return typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
}

function monthIndex(name: string): number {
	return MONTH_NAMES.findIndex((m) => m.slice(0, 3).toLowerCase() === name.slice(0, 3).toLowerCase());
}

function iso(y: number, m0: number, d: number): string {
	return new Date(Date.UTC(y, m0, d)).toISOString().slice(0, 10);
}

export function parseWeekTitle(title: string): { start: string; end: string } | null {
	const m = title.match(
		/^\s*([A-Za-z]+)\.?\s+(\d{1,2})\s*[–—-]\s*(?:([A-Za-z]+)\.?\s+)?(\d{1,2}),?\s*(\d{4})\s*$/,
	);
	if (!m) return null;
	const [, m1, d1, m2, d2, yStr] = m;
	const startMonth = monthIndex(m1);
	const endMonth = m2 ? monthIndex(m2) : startMonth;
	if (startMonth < 0 || endMonth < 0) return null;
	const y = Number(yStr);
	const startYear = startMonth > endMonth ? y - 1 : y;
	return { start: iso(startYear, startMonth, Number(d1)), end: iso(y, endMonth, Number(d2)) };
}

export interface WeekInfo {
	id: string;
	title: string;
	range: { start: string; end: string };
	page: NotionPage;
}

export function findWeekFor(weeks: NotionPage[], date: string): WeekInfo | null {
	for (const page of weeks) {
		const title = titleOf(page);
		const range = parseWeekTitle(title);
		if (range && date >= range.start && date <= range.end) {
			return { id: page.id, title, range, page };
		}
	}
	return null;
}

export interface MonthInfo {
	id: string;
	title: string;
	page: NotionPage;
}

export function findMonthFor(months: NotionPage[], date: string): MonthInfo | null {
	const [y, m] = date.split("-").map(Number);
	for (const page of months) {
		const title = titleOf(page);
		const t = title.match(/^\s*([A-Za-z]+)\s+(\d{4})\s*$/);
		if (t && monthIndex(t[1]) === m - 1 && Number(t[2]) === y) {
			return { id: page.id, title, page };
		}
		const start = dateOnly(plain(page.properties["Date"]));
		if (start && start.slice(0, 7) === date.slice(0, 7)) {
			return { id: page.id, title, page };
		}
	}
	return null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const r2 = (n: number): number => Math.round(n * 100) / 100;
const sum = (xs: number[]): number => r2(xs.reduce((a, b) => a + b, 0));

export interface Purchase {
	id: string;
	item: string;
	amount: number;
	category: string;
	date: string | null;
	needOrWant: string | null;
	createdTime: string | null;
}

export function readPurchase(p: NotionPage): Purchase {
	const pr = p.properties;
	return {
		id: p.id,
		item: plain(pr["Item"]) ?? "",
		amount: num(plain(pr["Amount"])),
		category: plain(pr["Category"]) ?? "Other",
		date: dateOnly(plain(pr["Date"])) ?? dateOnly(p.created_time),
		needOrWant: plain(pr["Need or Want"]),
		createdTime: p.created_time ?? null,
	};
}

export interface Income {
	id: string;
	title: string;
	amount: number;
	source: string | null;
	date: string | null;
	monthIds: string[];
	createdTime: string | null;
}

export function readIncome(p: NotionPage): Income {
	const pr = p.properties;
	return {
		id: p.id,
		title: plain(pr["Income"]) ?? "",
		amount: num(plain(pr["Amount"])),
		source: plain(pr["income"]),
		date: dateOnly(plain(pr["Date"])) ?? dateOnly(p.created_time),
		monthIds: plain(pr["Month"]) ?? [],
		createdTime: p.created_time ?? null,
	};
}

export interface Bill {
	id: string;
	name: string;
	amount: number;
	status: string | null;
	due: string | null;
	frequency: string | null;
	categoryIds: string[];
	monthIds: string[];
}

export function readBill(p: NotionPage): Bill {
	const pr = p.properties;
	return {
		id: p.id,
		name: plain(pr["Expense"]) ?? "",
		amount: num(plain(pr["Amount"])),
		status: plain(pr["Status"]),
		due: dateOnly(plain(pr["Next Due Date"])) ?? dateOnly(plain(pr["Due Date"])),
		frequency: plain(pr["Frequency"]),
		categoryIds: plain(pr["Category"]) ?? [],
		monthIds: plain(pr["Month"]) ?? [],
	};
}

export interface FinanceData {
	purchases: NotionPage[];
	expenses: NotionPage[];
	incomes: NotionPage[];
	categories: NotionPage[];
	months: NotionPage[];
	weeks: NotionPage[];
	savings: NotionPage[];
	debts: NotionPage[];
	errors: string[];
}

function explain(e: unknown): string {
	if (e instanceof NotionError) {
		if (e.status === 404 || e.status === 403) {
			return "Notion can't see this database. Open it in Notion, choose ••• → Connections, and add the integration.";
		}
		return e.message;
	}
	return e instanceof Error ? e.message : String(e);
}

export function explainWriteError(e: unknown): string {
	if (e instanceof NotionError) {
		if (e.status === 403 || e.status === 404) {
			return "the integration can't edit this database (check Connections and Insert content / Update content permissions)";
		}
		if (e.status === 400) return `Notion didn't accept the entry (${e.message.slice(0, 160)})`;
		return e.message.slice(0, 160);
	}
	return e instanceof Error ? e.message : String(e);
}

export async function loadFinanceData(env: Env, today: string): Promise<FinanceData> {
	const errors: string[] = [];
	const run = async (label: string, job: Promise<NotionPage[]>): Promise<NotionPage[]> => {
		try {
			return await job;
		} catch (e) {
			errors.push(`${label}: ${explain(e)}`);
			return [];
		}
	};

	const recentCreated = [{ timestamp: "created_time", direction: "descending" }];

	/*
	 * Accuracy fix:
	 * Do NOT filter purchases/incomes by their Notion Date property here.
	 * Rows with blank Date values would disappear before readPurchase/readIncome
	 * gets the chance to fall back to created_time.
	 */
	const [purchases, expenses, incomes, categories, months, weeks, savings, debts] =
		await Promise.all([
			run("What I Bought Today", queryAll(env, DS.purchases, {
				sorts: recentCreated,
				maxPages: 5,
			})),
			run("Expenses", queryAll(env, DS.expenses, { maxPages: 3 })),
			run("Incomes", queryAll(env, DS.incomes, {
				sorts: recentCreated,
				maxPages: 4,
			})),
			run("Budget Database", queryAll(env, DS.categories, { maxPages: 2 })),
			run("Month", queryAll(env, DS.months, { sorts: recentCreated, maxPages: 2 })),
			run("Week", queryAll(env, DS.weeks, { sorts: recentCreated, maxPages: 2 })),
			run("Saving For Something Big", queryAll(env, DS.savings, { maxPages: 2 })),
			run("Debt Tracker", queryAll(env, DS.debts, { maxPages: 2 })),
		]);

	return { purchases, expenses, incomes, categories, months, weeks, savings, debts, errors };
}

function pick(page: NotionPage | undefined, names: string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (!page) return out;
	for (const n of names) {
		if (page.properties[n] !== undefined) out[n] = plain(page.properties[n]);
	}
	return out;
}

function groupSum(items: Purchase[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const p of items) out[p.category] = r2((out[p.category] ?? 0) + p.amount);
	return out;
}

export function buildSnapshot(data: FinanceData, today: string, includeNotionCalcs: boolean) {
	const purchases = data.purchases.map(readPurchase);
	const incomes = data.incomes.map(readIncome);
	const bills = data.expenses.map(readBill);

	const weekInfo = findWeekFor(data.weeks, today);
	const monthInfo = findMonthFor(data.months, today);
	const range = weekInfo?.range ?? mondayWeek(today);
	const monthStart = `${today.slice(0, 7)}-01`;
	const monthEnd = lastDayOfMonth(today);
	const inRange = (d: string | null, a: string, b: string) => !!d && d >= a && d <= b;

	const validPurchases = purchases.filter((p) => p.amount > 0 && p.date);
	const validIncomes = incomes.filter((i) => i.amount > 0 && i.date);

	const weekPurchases = validPurchases.filter((p) => inRange(p.date, range.start, range.end));
	const lastWeekTotal = sum(
		validPurchases
			.filter((p) => inRange(p.date, addDays(range.start, -7), addDays(range.start, -1)))
			.map((p) => p.amount),
	);
	const weekIncome = sum(
		validIncomes.filter((i) => inRange(i.date, range.start, range.end)).map((i) => i.amount),
	);
	const daysLeftInWeek = Math.max(daysBetween(today, range.end) + 1, 1);

	const monthPurchases = validPurchases.filter((p) => inRange(p.date, monthStart, monthEnd));
	const monthIncomes = incomes.filter(
		(i) =>
			i.amount > 0 &&
			(inRange(i.date, monthStart, monthEnd) || (monthInfo && i.monthIds.includes(monthInfo.id))),
	);
	const monthBills = bills.filter(
		(b) => (monthInfo && b.monthIds.includes(monthInfo.id)) || inRange(b.due, monthStart, monthEnd),
	);

	const incomeMonth = sum(monthIncomes.map((i) => i.amount));
	const purchasesMonth = sum(monthPurchases.map((p) => p.amount));
	const billsTotal = sum(monthBills.map((b) => b.amount));
	const billsPaid = sum(monthBills.filter((b) => b.status === "Paid").map((b) => b.amount));
	const billsUnpaid = r2(Math.max(billsTotal - billsPaid, 0));

	const need = sum(monthPurchases.filter((p) => p.needOrWant === "Need").map((p) => p.amount));
	const want = sum(monthPurchases.filter((p) => p.needOrWant === "Want").map((p) => p.amount));

	const last14 = validPurchases.filter((p) => inRange(p.date, addDays(today, -13), today));

	const unpaid = bills.filter((b) => b.status !== "Paid");
	const briefBill = (b: Bill) => ({
		name: b.name,
		amount: b.amount,
		due: b.due,
		days_until_due: b.due ? daysBetween(today, b.due) : null,
		frequency: b.frequency,
	});
	const overdue = unpaid.filter((b) => b.due && b.due < today);
	const dueSoon = unpaid.filter((b) => b.due && b.due >= today && b.due <= addDays(today, 7));
	const dueThisWeek = unpaid.filter((b) => inRange(b.due, today, range.end));

	const planned = unpaid
		.filter((b) => b.frequency === "One-time" && b.due && b.due >= today)
		.sort((a, b) => (a.due! < b.due! ? -1 : 1))
		.map((b) => {
			const daysUntil = daysBetween(today, b.due!);
			const weeksLeft = Math.max(1, Math.ceil(daysUntil / 7));
			const dueThisWeekAlready = b.due! <= range.end;
			return {
				name: b.name,
				amount: b.amount,
				due: b.due,
				days_until: daysUntil,
				weeks_left: weeksLeft,
				weekly_set_aside: dueThisWeekAlready ? b.amount : r2(b.amount / weeksLeft),
				due_after_this_month: b.due! > monthEnd,
			};
		});

	const setAsideLater = sum(planned.filter((p) => p.due_after_this_month).map((p) => p.weekly_set_aside));
	const setAsideAll = sum(planned.filter((p) => p.days_until > daysLeftInWeek - 1).map((p) => p.weekly_set_aside));

	/*
	 * Two separate numbers, intentionally:
	 * cash_flow_so_far = money actually logged in - paid bills - purchases
	 * flexible_left_after_all_month_bills = the above - still-unpaid month bills
	 */
	const cashFlowSoFar = r2(incomeMonth - billsPaid - purchasesMonth);
	const flexibleLeftMonth = r2(cashFlowSoFar - billsUnpaid);
	const weeksLeftInMonth = Math.max(1, Math.ceil((daysBetween(today, monthEnd) + 1) / 7));
	const spendableRestOfWeek = r2(flexibleLeftMonth / weeksLeftInMonth - setAsideLater);

	const categories = data.categories.map((c) => ({
		name: titleOf(c),
		monthly_limit: plain(c.properties["Monthly Budget Limit"]),
		bills_this_month: sum(monthBills.filter((b) => b.categoryIds.includes(c.id)).map((b) => b.amount)),
		notion_this_month: plain(c.properties["This Month"]),
		notion_spending: plain(c.properties["Spending"]),
	}));

	const savings = data.savings.map((s) => {
		const target = num(plain(s.properties["Target Amount"]));
		const saved = num(plain(s.properties["Saved So Far"]));
		return {
			goal: titleOf(s),
			target,
			saved,
			remaining: r2(Math.max(target - saved, 0)),
			percent_saved: target > 0 ? Math.round((saved / target) * 100) : null,
			priority: plain(s.properties["Priority"]),
			notes: plain(s.properties["Notes"]) || undefined,
		};
	});

	const debts = data.debts.map((d) => ({
		name: titleOf(d),
		type: plain(d.properties["Type"]),
		balance: num(plain(d.properties["Balance"])),
		minimum_payment: num(plain(d.properties["Minimum Payment"])),
		interest_rate_percent: plain(d.properties["Interest Rate %"]),
		due: dateOnly(plain(d.properties["Due Date"])),
		status: plain(d.properties["Status"]),
	}));
	const activeDebts = debts.filter((d) => d.status !== "Paid Off");
	const priciest = [...activeDebts].sort(
		(a, b) => num(b.interest_rate_percent) - num(a.interest_rate_percent),
	)[0];

	const recentPurchases = [...validPurchases]
		.sort((a, b) => ((b.date ?? "") + (b.createdTime ?? "")).localeCompare((a.date ?? "") + (a.createdTime ?? "")))
		.slice(0, 15)
		.map((p) => ({ date: p.date, item: p.item, amount: p.amount, category: p.category, need_or_want: p.needOrWant }));

	const recentIncomes = incomes
		.filter((i) => i.amount > 0)
		.slice(0, 8)
		.map((i) => ({ date: i.date, source: i.source, note: i.title || undefined, amount: i.amount }));

	const purchaseRowsWithoutUsableDate = purchases.filter((p) => p.amount > 0 && !p.date).length;
	const purchaseRowsWithZeroAmount = purchases.filter((p) => p.amount <= 0).length;

	return {
		today,
		weekday: weekdayName(today),
		notes:
			"Fin computes totals from the rows he can read in Notion. 'Cash flow so far' means logged income minus paid bills and purchases. 'Flexible left after all month bills' also reserves unpaid bills still due this month. It is not a bank balance.",
		data_quality: {
			purchase_rows_loaded: purchases.length,
			purchase_rows_counted_this_month: monthPurchases.length,
			purchase_rows_without_usable_date: purchaseRowsWithoutUsableDate,
			purchase_rows_with_zero_amount: purchaseRowsWithZeroAmount,
			income_rows_loaded: incomes.length,
			expense_rows_loaded: bills.length,
		},
		this_week: {
			label: weekInfo?.title ?? `${range.start} to ${range.end}`,
			start: range.start,
			end: range.end,
			days_left_including_today: daysLeftInWeek,
			purchases_total: sum(weekPurchases.map((p) => p.amount)),
			purchases_count: weekPurchases.length,
			purchases_by_category: groupSum(weekPurchases),
			last_week_purchases_total: lastWeekTotal,
			income_logged: weekIncome,
			income_entries: validIncomes
				.filter((i) => inRange(i.date, range.start, range.end))
				.map((i) => ({ date: i.date, source: i.source, note: i.title || undefined, amount: i.amount })),
			bills_due_this_week: sum(dueThisWeek.map((b) => b.amount)),
			notion: includeNotionCalcs
				? pick(weekInfo?.page, [
						"Left to Spend This Week",
						"Weekly Message",
						"Eat Out Coach",
						"Incomes So Far This Week",
						"Total Expenses So Far This Week",
						"Daily Purchases Total",
						"Coffee So Far",
						"Eating Out So Far",
					])
				: undefined,
		},
		weekly_budget: {
			spendable_rest_of_this_week: spendableRestOfWeek,
			per_day_rest_of_week: r2(spendableRestOfWeek / daysLeftInWeek),
			weeks_left_in_month: weeksLeftInMonth,
			weekly_set_aside_for_planned_purchases: setAsideAll,
		},
		this_month: {
			label: monthInfo?.title ?? today.slice(0, 7),
			income_logged: incomeMonth,
			income_by_source: incomeBySource(monthIncomes),
			// New clearer names:
			purchases_total: purchasesMonth,
			purchases_count: monthPurchases.length,
			// Backward-compatible name used by older Fin prompts:
			daily_purchases_total: purchasesMonth,
			purchases_by_category: groupSum(monthPurchases),
			need_total: need,
			want_total: want,
			want_share_percent: need + want > 0 ? Math.round((want / (need + want)) * 100) : null,
			average_daily_spend_last_14_days: r2(sum(last14.map((p) => p.amount)) / 14),
			bills_total: billsTotal,
			bills_paid: billsPaid,
			bills_unpaid: billsUnpaid,
			cash_flow_so_far: cashFlowSoFar,
			flexible_left_after_all_month_bills: flexibleLeftMonth,
			// Backward-compatible names used by the current src/index.ts:
			money_after_bills_and_purchases_so_far: cashFlowSoFar,
			flexible_money_left_after_unpaid_bills: flexibleLeftMonth,
			calculation: {
				income_logged: incomeMonth,
				minus_paid_bills: billsPaid,
				minus_purchases: purchasesMonth,
				equals_cash_flow_so_far: cashFlowSoFar,
				minus_unpaid_bills: billsUnpaid,
				equals_flexible_left_after_all_month_bills: flexibleLeftMonth,
			},
			notion: includeNotionCalcs
				? pick(monthInfo?.page, [
						"Monthly Incomes",
						"Monthly Expenses",
						"Net",
						"Net So Far",
						"Incomes So Far",
						"Expenses So Far",
					])
				: undefined,
		},
		bills: {
			overdue: overdue.map(briefBill),
			due_in_next_7_days: dueSoon.map(briefBill),
			unpaid_count: unpaid.length,
		},
		planned_purchases: planned,
		budget_categories: categories,
		savings_goals: savings,
		debts: {
			active: activeDebts,
			total_balance: sum(activeDebts.map((d) => d.balance)),
			total_minimum_payments: sum(activeDebts.map((d) => d.minimum_payment)),
			highest_interest: priciest ? `${priciest.name} (${priciest.interest_rate_percent ?? "?"}%)` : null,
		},
		recent_purchases: recentPurchases,
		recent_incomes: recentIncomes,
	};
}

function incomeBySource(items: Income[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const i of items) {
		const k = i.source ?? "Other";
		out[k] = r2((out[k] ?? 0) + i.amount);
	}
	return out;
}
