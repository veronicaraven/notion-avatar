import {
	CHAT_MODEL_ID,
	DEFAULT_TZ,
	MEMORY_MESSAGE_LIMIT,
	MEMORY_TTL_SECONDS,
} from "./config";
import { buildSnapshot, loadFinanceData, todayIn, weekdayName } from "./finance";
import {
	applyActions,
	emptyReport,
	extractActions,
	formatReport,
	hasActions,
	plannedNamesOf,
	reportForModel,
	syncLinks,
	type LogReport,
} from "./logging";
import type { ChatMessage, Env } from "./types";

const FIN_PERSONA = `
You are Fin, a friendly financial familiar who lives alongside the user's Notion Financial Planner. You are warm, playful, calm, practical, and a little wizardly without being childish or gimmicky.

SOURCE OF TRUTH — IMPORTANT
- The current FINANCE SNAPSHOT is freshly built from Notion and is authoritative for financial facts.
- Conversation memory is context only. If an older message conflicts with the current snapshot, ALWAYS use the current Notion value.
- Never invent transactions, balances, due dates, savings amounts, or statuses.
- Never say something was written, updated, deleted, or marked paid unless JUST HANDLED confirms it.

ANSWER STYLE
- Make answers visually easy to scan, similar to a polished assistant UI.
- Use a short heading when helpful: "### This week", "### Your bills", "### Japan goal".
- Use short bullets for multiple facts.
- Bold the one or two numbers that matter most.
- Use NOTE: for a useful calm callout and WATCH: only for something that needs attention.
- Keep paragraphs short. Avoid walls of text.
- Usually stay under 180 words unless the user explicitly asks for detail.
- Do not use markdown tables unless explicitly requested.

FINANCIAL INTERPRETATION
- There is no bank-account balance in this planner. Do not call a planner-derived number a bank balance.
- "cash flow so far" means logged income minus paid bills minus logged purchases.
- "flexible left after all month bills" additionally reserves unpaid bills due this month.
- Prefer values already computed in the snapshot rather than doing mental arithmetic.
- For affordability questions, consider the live Budget Plan first when it has relevant rows, then weekly room, unpaid/soon-due bills, savings goals, and planned purchases.
- BUDGET PLAN is the user's explicit spending plan in Notion. Compare actual purchases against it when helping with budgeting, and call out categories that are near/over plan without shaming.
- Mention uncertainty or missing Notion data rather than guessing.

TONE
- No shame, scolding, or moralizing about spending.
- Celebrate confirmed progress naturally.
- Occasional gentle magic/book language is fine, but usefulness comes first.
`.trim();

interface ChatRequestBody {
	messages?: ChatMessage[];
	timezone?: string;
	conversationId?: string;
	clientId?: string;
	memoryKey?: string;
	requestId?: string;
}

interface StoredConversation {
	version: 1;
	updatedAt: string;
	messages: ChatMessage[];
}

interface ProcessedRequest {
	version: 1;
	createdAt: string;
	confirmation: string;
}

type Visualization = {
	type: string;
	title: string;
	subtitle?: string;
	data: Record<string, unknown>;
};

function buildSystemPrompt(snapshot: unknown, handled: string | null, problems: string[]): string {
	const parts = [FIN_PERSONA, `FINANCE SNAPSHOT (JSON):\n${JSON.stringify(snapshot)}`];
	if (handled) parts.push(handled);
	if (problems.length) {
		parts.push(`NOTION READ ISSUES — do not guess affected values:\n- ${problems.join("\n- ")}`);
	}
	return parts.join("\n\n");
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/api/notion/test" && request.method === "GET") {
			if (env.ENABLE_DIAGNOSTICS !== "true") return json({ error: "Diagnostics are disabled." }, 404);
			return handleNotionTest(env, url);
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			return handleChat(request, env, ctx);
		}

		return env.ASSETS.fetch(request);
	},
};

async function handleNotionTest(env: Env, url: URL): Promise<Response> {
	try {
		const today = todayIn(safeTimezone(url.searchParams.get("tz")));
		const data = await loadFinanceData(env, today);
		const body: Record<string, unknown> = {
			success: data.errors.length === 0,
			today,
			rows_read: {
				purchases: data.purchases.length,
				expenses: data.expenses.length,
				incomes: data.incomes.length,
				savings_goals: data.savings.length,
				budget_plan: data.budgetPlan.length,
			},
			budget_plan_data_source_id: data.budgetPlanSourceId,
			problems: data.errors,
		};
		if (url.searchParams.has("snapshot")) body.snapshot = buildSnapshot(data, today, true);
		return json(body, 200);
	} catch (error) {
		console.error("Notion diagnostics error:", error);
		return json({ success: false, error: "Diagnostics failed." }, 500);
	}
}

async function handleChat(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	try {
		const body = (await request.json()) as ChatRequestBody;
		const memoryId = cleanId(body.conversationId || body.clientId || body.memoryKey);
		const requestId = cleanId(body.requestId);
		const browserMessages = sanitizeMessages(body.messages);
		const storedMessages = memoryId ? await readMemory(env, memoryId) : [];
		const messages = mergeConversation(storedMessages, browserMessages);
		const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
		if (!lastUser) return json({ error: "Please send a message to Fin." }, 400);

		// Best-effort idempotency in KV. The frontend also prevents double-submit,
		// while logging.ts performs content-level duplicate checks in Notion.
		if (requestId && env.FIN_MEMORY) {
			const prior = await readProcessed(env, requestId);
			if (prior) return oneShotSse(`${prior.confirmation}NOTE: That exact request was already processed, so I didn't write it to Notion again.`);
		}

		const today = todayIn(safeTimezone(body.timezone));
		const data = await loadFinanceData(env, today);
		const extraction = await extractActions(env, lastUser, today, weekdayName(today), plannedNamesOf(data));
		const report = emptyReport();

		await syncLinks(env, data, today, report);
		if (hasActions(extraction)) await applyActions(env, data, extraction, today, report);

		const confirmation = formatReport(report);
		if (requestId && env.FIN_MEMORY && (report.changed || confirmation)) {
			// Stored after Notion write confirmation. This protects normal retries and reloads.
			ctx.waitUntil(writeProcessed(env, requestId, confirmation));
		}

		// Rebuild from the in-memory rows after successful writes. Manual Notion edits
		// are already represented because loadFinanceData happens on every request.
		const snapshot = buildSnapshot(data, today, false) as any;
		const visualization = chooseVisualization(lastUser, snapshot);
		const system = buildSystemPrompt(snapshot, reportForModel(report), data.errors);

		const aiStream = (await env.AI.run(CHAT_MODEL_ID, {
			messages: [{ role: "system", content: system }, ...messages.slice(-20)],
			stream: true,
			max_tokens: 800,
		} as any)) as ReadableStream;

		const events: unknown[] = [];
		if (visualization) events.push({ type: "visualization", visualization });
		if (report.incomeSaved) events.push({ type: "animation", name: "income-success" });
		if (report.changed && !report.incomeSaved) events.push({ type: "animation", name: "notion-success" });
		if (confirmation) events.push({ response: confirmation });

		const fullStream = withEvents(events, aiStream);
		const [clientStream, memoryStream] = fullStream.tee();

		if (memoryId && env.FIN_MEMORY) {
			ctx.waitUntil(
				captureSseText(memoryStream)
					.then((assistantText) => {
						if (!assistantText.trim()) return;
						return writeMemory(env, memoryId, [...messages, { role: "assistant", content: assistantText.trim() } as ChatMessage].slice(-MEMORY_MESSAGE_LIMIT));
					})
					.catch((error) => console.error("Fin memory save failed:", error)),
			);
		} else {
			ctx.waitUntil(memoryStream.cancel().catch(() => undefined));
		}

		return new Response(clientStream, { headers: sseHeaders() });
	} catch (error) {
		console.error("Chat error:", error);
		return json({ error: "Fin couldn't reach the planner just now. Please try again." }, 500);
	}
}

function chooseVisualization(message: string, s: any): Visualization | null {
	const q = message.toLowerCase();
	const month = s?.this_month ?? {};
	const week = s?.this_week ?? {};
	const weekly = s?.weekly_budget ?? {};

	if (/spend|spent|purchase|bought|category|month/.test(q) && /how|show|breakdown|doing|much|where|month|spend/.test(q)) {
		return {
			type: "spending",
			title: `${month.label ?? "This month"} spending`,
			subtitle: "Current Notion snapshot",
			data: {
				total: month.purchases_total ?? month.daily_purchases_total ?? 0,
				count: month.purchases_count ?? 0,
				categories: month.purchases_by_category ?? {},
				need: month.need_total ?? 0,
				want: month.want_total ?? 0,
				dailyAverage: month.average_daily_spend_last_14_days ?? 0,
			},
		};
	}

	if (/bill|rent|subscription|due|payment/.test(q)) {
		return {
			type: "bills",
			title: "Bills & due dates",
			data: {
				total: month.bills_total ?? 0,
				paid: month.bills_paid ?? 0,
				unpaid: month.bills_unpaid ?? 0,
				overdue: s?.bills?.overdue ?? [],
				soon: s?.bills?.due_in_next_7_days ?? [],
			},
		};
	}

	if (/sav|goal|trip|japan|progress/.test(q) && Array.isArray(s?.savings_goals) && s.savings_goals.length) {
		const words = q.split(/\W+/).filter((x: string) => x.length > 2);
		const goal = s.savings_goals.find((g: any) => words.some((w: string) => String(g.goal).toLowerCase().includes(w))) ?? s.savings_goals[0];
		return { type: "savings", title: goal.goal, subtitle: "Savings goal", data: goal };
	}

	if (/income|paid|paycheck|earned|tips|wages/.test(q)) {
		return {
			type: "income",
			title: "Income",
			data: { month: month.income_logged ?? 0, week: week.income_logged ?? 0, sources: month.income_by_source ?? {}, recent: s?.recent_incomes ?? [] },
		};
	}

	if (/afford|room|left|budget|can i buy|can i spend/.test(q)) {
		return {
			type: "room",
			title: "Room in the plan",
			data: {
				thisWeek: weekly.spendable_rest_of_this_week ?? 0,
				perDay: weekly.per_day_rest_of_week ?? 0,
				flexibleMonth: month.flexible_left_after_all_month_bills ?? month.flexible_money_left_after_unpaid_bills ?? 0,
				planned: s?.planned_purchases ?? [],
				budgetPlan: s?.budget_plan ?? null,
			},
		};
	}

	return null;
}

function sanitizeMessages(value: unknown): ChatMessage[] {
	if (!Array.isArray(value)) return [];
	return value.filter((m): m is ChatMessage => !!m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim().length > 0)
		.slice(-MEMORY_MESSAGE_LIMIT).map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
}

function mergeConversation(stored: ChatMessage[], browser: ChatMessage[]): ChatMessage[] {
	if (!browser.length) return stored.slice(-MEMORY_MESSAGE_LIMIT);
	if (!stored.length) return browser.slice(-MEMORY_MESSAGE_LIMIT);
	const a = stored.map(messageKey), b = browser.map(messageKey);
	let overlap = 0;
	for (let n = Math.min(a.length, b.length); n >= 1; n--) {
		if (a.slice(-n).join("\u0000") === b.slice(0, n).join("\u0000")) { overlap = n; break; }
	}
	return [...stored, ...browser.slice(overlap)].slice(-MEMORY_MESSAGE_LIMIT);
}

const messageKey = (m: ChatMessage) => `${m.role}:${m.content}`;
function cleanId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const cleaned = value.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 120);
	return cleaned.length >= 8 ? cleaned : null;
}
const memoryKey = (id: string) => `conversation:v1:${id}`;
const processedKey = (id: string) => `processed:v1:${id}`;

async function readMemory(env: Env, id: string): Promise<ChatMessage[]> {
	if (!env.FIN_MEMORY) return [];
	try { const raw = await env.FIN_MEMORY.get(memoryKey(id)); return raw ? sanitizeMessages((JSON.parse(raw) as Partial<StoredConversation>).messages) : []; }
	catch (error) { console.error("Fin memory read failed:", error); return []; }
}

async function writeMemory(env: Env, id: string, messages: ChatMessage[]): Promise<void> {
	if (!env.FIN_MEMORY) return;
	const stored: StoredConversation = { version: 1, updatedAt: new Date().toISOString(), messages: sanitizeMessages(messages).slice(-MEMORY_MESSAGE_LIMIT) };
	await env.FIN_MEMORY.put(memoryKey(id), JSON.stringify(stored), { expirationTtl: MEMORY_TTL_SECONDS });
}

async function readProcessed(env: Env, id: string): Promise<ProcessedRequest | null> {
	if (!env.FIN_MEMORY) return null;
	try { const raw = await env.FIN_MEMORY.get(processedKey(id)); return raw ? JSON.parse(raw) as ProcessedRequest : null; }
	catch { return null; }
}

async function writeProcessed(env: Env, id: string, confirmation: string): Promise<void> {
	if (!env.FIN_MEMORY) return;
	const value: ProcessedRequest = { version: 1, createdAt: new Date().toISOString(), confirmation };
	await env.FIN_MEMORY.put(processedKey(id), JSON.stringify(value), { expirationTtl: 60 * 60 * 24 * 30 });
}

function safeTimezone(value: unknown): string {
	if (typeof value !== "string" || value.length > 80) return DEFAULT_TZ;
	try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(); return value; }
	catch { return DEFAULT_TZ; }
}

function withEvents(events: unknown[], stream: ReadableStream): ReadableStream {
	if (!events.length) return stream;
	const encoder = new TextEncoder();
	const { readable, writable } = new TransformStream();
	(async () => {
		const writer = writable.getWriter();
		for (const event of events) await writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
		writer.releaseLock();
		await stream.pipeTo(writable);
	})().catch((error) => console.error("Stream error:", error));
	return readable;
}

function oneShotSse(text: string): Response {
	const payload = `data: ${JSON.stringify({ response: text })}\n\ndata: [DONE]\n\n`;
	return new Response(payload, { headers: sseHeaders() });
}

function sseHeaders(): Record<string, string> {
	return { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-store", connection: "keep-alive", "x-accel-buffering": "no" };
}

async function captureSseText(stream: ReadableStream): Promise<string> {
	const reader = stream.getReader(); const decoder = new TextDecoder(); let buffer = "", text = "";
	while (true) {
		const { done, value } = await reader.read(); if (done) break;
		buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
		let end: number;
		while ((end = buffer.indexOf("\n\n")) !== -1) {
			const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
			const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
			if (!data || data === "[DONE]") continue;
			try { const parsed = JSON.parse(data); if (typeof parsed.response === "string") text += parsed.response; else if (typeof parsed.choices?.[0]?.delta?.content === "string") text += parsed.choices[0].delta.content; } catch {}
		}
	}
	return text;
}

function json(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
