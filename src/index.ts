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
} from "./logging";
import type { ChatMessage, Env } from "./types";

const FIN_PERSONA = `
You are Fin, Veronica's friendly financial familiar: a small whimsical wizard-like companion who lives alongside her Notion financial planner. Your job is to make money feel understandable, calm, and manageable. You help her track purchases and income, plan for future purchases, notice upcoming bills, work toward savings goals, and make spending decisions using the actual numbers in her planner.

PERSONALITY
- Warm, gentle, curious, grounded, and quietly encouraging.
- You feel like a cozy storybook companion, not a banker, accountant, or motivational coach.
- Do not use Halloween language, spooky jokes, "coins", "haunting", "boo-dget", or seasonal gimmicks.
- Never shame spending, forgotten bills, inconsistent logging, or impulse purchases.
- Celebrate concrete progress without overpraising.
- Use occasional nature/book/familiar imagery very lightly when it feels natural, never in every reply.

HOW TO ANSWER
- Lead with the useful answer in one or two short sentences.
- Usually add no more than three short lines of supporting detail.
- Prefer one to three meaningful numbers instead of dumping the whole planner.
- Make numbers concrete: "$18 a day through Sunday" is better than a vague percentage.
- End with at most one small next step when a next step is actually useful.
- Use plain language. No tables unless Veronica explicitly asks for one.

MEMORY AND CONVERSATION
- You may receive earlier conversation turns. Use them naturally when relevant.
- Do not pretend to remember something that is not present in the conversation or finance snapshot.
- If an earlier message conflicts with current Notion data, current Notion data wins for financial amounts and statuses.
- Do not repeatedly announce that you remember something; simply use context naturally.

FINANCIAL DATA
- FINANCE SNAPSHOT below is computed by code from Veronica's Notion planner. It is the source of truth for financial numbers.
- Never invent missing balances, transactions, bill amounts, dates, or goals.
- Purchases and income she states may be written to Notion before you answer. The JUST HANDLED section tells you what was actually changed.
- There is no bank-account balance in this planner. "Money left" means logged income minus logged bills and purchases unless the snapshot explicitly says otherwise.
- Her income can vary, so avoid assuming every week will match a strong recent week.

WEEKLY ROOM AND PLANNED PURCHASES
- weekly_budget.spendable_rest_of_this_week is flexible room for the rest of the current week after bills and planned-purchase set-asides.
- weekly_budget.per_day_rest_of_week is that amount spread across the remaining days.
- planned_purchases contains future one-time costs and weekly_set_aside values.
- If weekly room is negative, say the plan is tight or stretched. Offer one or two practical options without lecturing.

WHEN ASKED "CAN I AFFORD X?"
1. Check weekly_budget.spendable_rest_of_this_week.
2. Check this_month.flexible_money_left_after_unpaid_bills.
3. Check overdue / soon-due bills and planned purchases.
4. Give a direct, calm answer such as "Yes, that fits comfortably", "It fits, but it would use most of this week's room", or "I wouldn't fit that into this week yet."
5. For discretionary wants, a 24-hour wait can be offered as an option, not a rule.

FINANCIAL GUIDANCE
- Essentials and required payments come before flexible spending.
- Known future costs are best handled as sinking funds / weekly set-asides.
- For debt, always protect minimum payments; extra payments commonly go to the highest interest rate first unless motivation makes a snowball strategy more sustainable.
- For variable income, avoid building fixed spending around unusually high weeks.
- 50/30/20 is only a rough framework, never a requirement.
- For taxes, investing, loans, or other high-stakes decisions, distinguish general planning help from professional or official guidance.

DATA RULES
- Amounts are US dollars, formatted like $12.34.
- Prefer precomputed snapshot values over mental arithmetic.
- Income questions should use this_week.income_logged / this_week.income_entries and this_month.income_logged.
- Mention overdue bills or bills due very soon when relevant, but do not nag about the same item repeatedly.
- Never claim something was saved, changed, removed, or marked paid unless JUST HANDLED confirms it.
`.trim();

interface ChatRequestBody {
	messages?: ChatMessage[];
	timezone?: string;
	conversationId?: string;
	clientId?: string;
	memoryKey?: string;
}

interface StoredConversation {
	version: 1;
	updatedAt: string;
	messages: ChatMessage[];
}

function buildSystemPrompt(snapshot: unknown, handled: string | null, problems: string[]): string {
	const parts = [FIN_PERSONA, `FINANCE SNAPSHOT (JSON):\n${JSON.stringify(snapshot)}`];
	if (handled) parts.push(handled);
	if (problems.length) {
		parts.push(
			`SOME NOTION DATA COULDN'T BE READ. Mention it kindly and briefly, and don't guess those numbers:\n- ${problems.join("\n- ")}`,
		);
	}
	return parts.join("\n\n");
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/api/notion/test" && request.method === "GET") {
			if (env.ENABLE_DIAGNOSTICS !== "true") {
				return json({ error: "Diagnostics are disabled." }, 404);
			}
			return handleNotionTest(env, url);
		}

		if (url.pathname === "/api/dashboard" && request.method === "GET") {
			return handleDashboard(env, url);
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
				budget_categories: data.categories.length,
				months: data.months.length,
				weeks: data.weeks.length,
				savings_goals: data.savings.length,
				debts: data.debts.length,
			},
			problems: data.errors,
		};
		if (url.searchParams.has("snapshot")) body.snapshot = buildSnapshot(data, today, true);
		return json(body, 200);
	} catch (error) {
		console.error("Notion diagnostics error:", error);
		return json({ success: false, error: "Diagnostics failed." }, 500);
	}
}

async function handleDashboard(env: Env, url: URL): Promise<Response> {
	try {
		const today = todayIn(safeTimezone(url.searchParams.get("tz")));
		const data = await loadFinanceData(env, today);
		return json({
			success: data.errors.length === 0,
			snapshot: buildSnapshot(data, today, false),
			problems: data.errors,
		}, 200, { "cache-control": "private, max-age=30" });
	} catch (error) {
		console.error("Dashboard error:", error);
		return json({ success: false, error: "Fin couldn't load the planner just now." }, 500);
	}
}

async function handleChat(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	try {
		const body = (await request.json()) as ChatRequestBody;
		const memoryId = cleanMemoryId(body.conversationId || body.clientId || body.memoryKey);
		const browserMessages = sanitizeMessages(body.messages);
		const storedMessages = memoryId ? await readMemory(env, memoryId) : [];
		const messages = mergeConversation(storedMessages, browserMessages);

		const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
		if (!lastUser) {
			return json({ error: "Please send a message to Fin." }, 400);
		}

		const today = todayIn(safeTimezone(body.timezone));
		const data = await loadFinanceData(env, today);

		const extraction = await extractActions(
			env,
			lastUser,
			today,
			weekdayName(today),
			plannedNamesOf(data),
		);

		const report = emptyReport();
		await syncLinks(env, data, today, report);

		if (hasActions(extraction)) {
			await applyActions(env, data, extraction, today, report);
		}

		const snapshot = buildSnapshot(data, today, false);
		const system = buildSystemPrompt(snapshot, reportForModel(report), data.errors);

		const aiStream = (await env.AI.run(CHAT_MODEL_ID, {
			messages: [{ role: "system", content: system }, ...messages.slice(-20)],
			stream: true,
			max_tokens: 700,
		} as any)) as ReadableStream;

		const fullStream = withPrefix(formatReport(report), aiStream);
		const [clientStream, memoryStream] = fullStream.tee();

		if (memoryId && env.FIN_MEMORY) {
			ctx.waitUntil(
				captureSseText(memoryStream)
					.then((assistantText) => {
						if (!assistantText.trim()) return;
						const finalMessages = [
							...messages,
							{ role: "assistant", content: assistantText.trim() } as ChatMessage,
						].slice(-MEMORY_MESSAGE_LIMIT);
						return writeMemory(env, memoryId, finalMessages);
					})
					.catch((error) => console.error("Fin memory save failed:", error)),
			);
		} else {
			// Nobody reads the second tee branch when KV isn't configured.
			ctx.waitUntil(memoryStream.cancel().catch(() => undefined));
		}

		return new Response(clientStream, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache, no-store",
				connection: "keep-alive",
				"x-accel-buffering": "no",
			},
		});
	} catch (error) {
		console.error("Chat error:", error);
		return json({ error: "Fin couldn't reach the planner just now. Please try again." }, 500);
	}
}

function sanitizeMessages(value: unknown): ChatMessage[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter(
			(m): m is ChatMessage =>
				!!m &&
				(m.role === "user" || m.role === "assistant") &&
				typeof m.content === "string" &&
				m.content.trim().length > 0,
		)
		.slice(-MEMORY_MESSAGE_LIMIT)
		.map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
}

/**
 * Browser history is normally the freshest copy. KV is mainly useful when the
 * browser history is missing/short (reloads on a different context, cleared
 * localStorage, etc.). Avoid concatenating identical histories twice.
 */
function mergeConversation(stored: ChatMessage[], browser: ChatMessage[]): ChatMessage[] {
	if (browser.length === 0) return stored.slice(-MEMORY_MESSAGE_LIMIT);
	if (stored.length === 0) return browser.slice(-MEMORY_MESSAGE_LIMIT);

	const browserSerialized = browser.map(messageKey);
	const storedSerialized = stored.map(messageKey);

	// If browser history ends with / contains the same recent server history,
	// trust the browser copy because it includes the current user message.
	const storedTail = storedSerialized.slice(-Math.min(storedSerialized.length, browserSerialized.length));
	const browserPrefix = browserSerialized.slice(0, storedTail.length);
	if (storedTail.join("\u0000") === browserPrefix.join("\u0000")) {
		return browser.slice(-MEMORY_MESSAGE_LIMIT);
	}

	// Otherwise append only browser messages that occur after the longest common suffix/prefix.
	let overlap = 0;
	const max = Math.min(stored.length, browser.length);
	for (let n = max; n >= 1; n--) {
		const a = storedSerialized.slice(-n).join("\u0000");
		const b = browserSerialized.slice(0, n).join("\u0000");
		if (a === b) {
			overlap = n;
			break;
		}
	}

	return [...stored, ...browser.slice(overlap)].slice(-MEMORY_MESSAGE_LIMIT);
}

function messageKey(message: ChatMessage): string {
	return `${message.role}:${message.content}`;
}

function cleanMemoryId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const cleaned = value.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 120);
	return cleaned.length >= 8 ? cleaned : null;
}

function memoryKey(id: string): string {
	return `conversation:v1:${id}`;
}

async function readMemory(env: Env, id: string): Promise<ChatMessage[]> {
	if (!env.FIN_MEMORY) return [];
	try {
		const raw = await env.FIN_MEMORY.get(memoryKey(id));
		if (!raw) return [];
		const parsed = JSON.parse(raw) as Partial<StoredConversation>;
		return sanitizeMessages(parsed.messages);
	} catch (error) {
		console.error("Fin memory read failed:", error);
		return [];
	}
}

async function writeMemory(env: Env, id: string, messages: ChatMessage[]): Promise<void> {
	if (!env.FIN_MEMORY) return;
	const stored: StoredConversation = {
		version: 1,
		updatedAt: new Date().toISOString(),
		messages: sanitizeMessages(messages).slice(-MEMORY_MESSAGE_LIMIT),
	};
	await env.FIN_MEMORY.put(memoryKey(id), JSON.stringify(stored), {
		expirationTtl: MEMORY_TTL_SECONDS,
	});
}

function safeTimezone(value: unknown): string {
	if (typeof value !== "string" || value.length > 80) return DEFAULT_TZ;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
		return value;
	} catch {
		return DEFAULT_TZ;
	}
}

/** Adds code-generated save confirmations before the model's streamed words. */
function withPrefix(prefix: string, stream: ReadableStream): ReadableStream {
	if (!prefix) return stream;
	const encoder = new TextEncoder();
	const { readable, writable } = new TransformStream();
	(async () => {
		const writer = writable.getWriter();
		await writer.write(encoder.encode(`data: ${JSON.stringify({ response: prefix })}\n\n`));
		writer.releaseLock();
		await stream.pipeTo(writable);
	})().catch((e) => console.error("Stream error:", e));
	return readable;
}

async function captureSseText(stream: ReadableStream): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let text = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true }).replace(/\r/g, "");
		let end: number;
		while ((end = buffer.indexOf("\n\n")) !== -1) {
			const event = buffer.slice(0, end);
			buffer = buffer.slice(end + 2);
			const data = event
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");
			if (!data || data === "[DONE]") continue;
			try {
				const parsed = JSON.parse(data);
				if (typeof parsed.response === "string") text += parsed.response;
				else if (typeof parsed.choices?.[0]?.delta?.content === "string") {
					text += parsed.choices[0].delta.content;
				}
			} catch {
				// Ignore malformed/non-JSON SSE events.
			}
		}
	}
	return text;
}

function json(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
	});
}
