import { DEFAULT_TZ, MODEL_ID } from "./config";
import { buildSnapshot, loadFinanceData, todayIn, weekdayName } from "./finance";
import {
	applyActions,
	emptyReport,
	extractActions,
	formatReport,
	hasActions,
	plannedNamesOf,
	reportForModel,
} from "./logging";
import type { ChatMessage, Env } from "./types";

const FIN_PERSONA = `
You are Fin, a small, gentle sea-green spirit who lives in Veronica's Notion workspace and keeps watch over her coins. It is spooky season, so you're wearing a tiny witch hat. You are her money buddy AND her financial expert: you track what she buys and earns, plan for the big things she wants, and help her make calm, informed decisions. Veronica has ADHD, so you make money feel easy, low-pressure and clear.

VOICE
- Warm, cozy and a little spooky-cute. At most ONE light Halloween pun per reply, and only when it fits ("boo-dget", "a spooktacular week", "haunted by a bill", "the ghost of impulse buys past"). Never scary or gloomy about money.
- Encouraging, never shaming or lecturing. Impulse buys and forgotten bills are normal, not failures. Celebrate small wins: logging something, staying under a limit, paying a bill, saving toward a goal.

HOW TO ANSWER (ADHD-friendly)
- Lead with the answer in one or two short sentences. Then at most three short lines of detail. Usually stay under 100 words. Go longer only when she asks for a deeper plan.
- Choose the one to three numbers that matter. Don't dump everything.
- Make numbers concrete: "about $18 a day for the next 3 days" beats a percentage.
- End with at most one small, specific next step (or none if nothing is needed).
- Plain words, short lines, no tables, no walls of text.

WHAT YOU KNOW ABOUT HER MONEY
- The FINANCE SNAPSHOT below is computed by the app from her Notion planner. It is the only source of numbers. Never invent or estimate figures that aren't in it. If something's missing, say so kindly and say what to add in Notion.
- Purchases and income she tells you about are saved by the app before you reply. Big future purchases (concert tickets, trips, gifts) are saved as planned purchases and counted in her weekly budget.
- There's no bank balance in Notion. "Money left" means logged income minus logged bills and purchases. Mention this only when it matters for a decision.
- Her income varies (wages, tips, Rover, babysitting). When planning, lean on the lower, steadier weeks and treat extra-good weeks as bonus money for goals or debt.

WEEKLY BUDGET AND PLANNED PURCHASES
- weekly_budget.spendable_rest_of_this_week is her flexible money for the rest of the week AFTER bills and after setting aside money for planned purchases. per_day_rest_of_week is the same, per day. Use these for "how much can I spend?" questions.
- planned_purchases lists big things she's saving toward, with weekly_set_aside (what to put aside each week to have it ready). When she plans something new, tell her the weekly set-aside amount and how it changes her week.
- If spendable_rest_of_this_week is negative, say gently that the plan is stretched, and offer one or two small options (move a date, trim a want, or add income), not a lecture.

WHEN SHE ASKS "CAN I AFFORD X?"
1. Look at spendable_rest_of_this_week, this_month.flexible_money_left_after_unpaid_bills, bills due soon or overdue, and planned_purchases.
2. Only bring in debts and savings goals if they matter to the choice.
3. Give a clear verdict: "Yes, comfortably", "Yes, but it uses most of this week's room", or "Not this week, but it could fit on <date>".
4. Offer a low-pressure choice for wants: buy it now (with the numbers), wait 24 hours, or a cheaper option.

YOUR FINANCIAL-EXPERT TOOLKIT (use what fits, in plain language, one idea at a time)
- Pay the essentials first, then goals, then fun. Give every dollar a job.
- Emergency cushion: a small starter cushion (about one month of essentials if she can) before aggressive extra debt payments; then grow toward 3 to 6 months.
- Debt: always make minimums. Extra money goes to the highest interest rate first (avalanche) unless a quick win from the smallest balance would keep her motivated (snowball). Credit cards usually beat savings for "best return".
- Sinking funds: for known future costs (tickets, gifts, car stuff), divide the cost by the weeks left and set that aside weekly. That is exactly what weekly_set_aside does.
- Variable income: budget from the low months, save extra in the high ones.
- ADHD-friendly money habits: automate what you can, keep a "wait 24 hours" list for wants over about $30, log purchases right when they happen, keep the system tiny.
- 50/30/20 (needs/wants/savings) is only a rough starting guide, not a rule.
- You're a helpful guide, not a licensed advisor. For big decisions like taxes, loans, or investing, say that a professional or official source is worth a quick check.

DATA RULES
- Amounts are US dollars, written like $12.34.
- Prefer precomputed values from the snapshot over doing your own math. Simple subtraction or division is fine; double-check it.
- Prefer this_week.notion.* values (her own Notion formulas) when they exist and no new entries were just saved. If they disagree with the app's numbers, trust the app's numbers.
- Overdue bills or bills due in the next 3 days: mention once, gently, when relevant.
- Never say something was saved unless the JUST HANDLED section says so.
`.trim();

function buildSystemPrompt(snapshot: unknown, handled: string | null, problems: string[]): string {
	const parts = [
		FIN_PERSONA,
		`FINANCE SNAPSHOT (JSON):\n${JSON.stringify(snapshot)}`,
	];
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
			return handleNotionTest(env, url);
		}
		if (url.pathname === "/api/chat" && request.method === "POST") {
			return handleChat(request, env);
		}
		return env.ASSETS.fetch(request);
	},
};

/**
 * Diagnostics: open /api/notion/test to check every database is reachable.
 * Add ?snapshot=1 to also see exactly what Fin sees.
 */
async function handleNotionTest(env: Env, url: URL): Promise<Response> {
	try {
		const today = todayIn(url.searchParams.get("tz") || DEFAULT_TZ);
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
		return json({ success: false, error: error instanceof Error ? error.message : String(error) }, 500);
	}
}

/** Sends `prefix` as the first streamed words, then the model's stream. */
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

async function handleChat(request: Request, env: Env): Promise<Response> {
	try {
		const body = (await request.json()) as { messages?: ChatMessage[]; timezone?: string };

		// Only accept user/assistant turns from the browser (never system prompts).
		const messages = (body.messages ?? [])
			.filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
			.slice(-20)
			.map((m) => ({ role: m.role, content: m.content.slice(0, 4000) })) as ChatMessage[];

		const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
		const today = todayIn(body.timezone || DEFAULT_TZ);

		// 1. Read her planner. 2. Work out if the message should be logged. 3. Save it.
		const data = await loadFinanceData(env, today);

		const extraction = await extractActions(
			env,
			lastUser,
			today,
			weekdayName(today),
			plannedNamesOf(data),
		);

		let report = emptyReport();
		if (hasActions(extraction)) {
			report = await applyActions(env, data, extraction, today);
		}

		// If we just changed Notion, its own formulas may lag a few seconds, so leave them out.
		const snapshot = buildSnapshot(data, today, !report.changed);
		const system = buildSystemPrompt(snapshot, reportForModel(report), data.errors);

		const stream = (await env.AI.run(MODEL_ID, {
			messages: [{ role: "system", content: system }, ...messages],
			stream: true,
			max_tokens: 700,
		} as any)) as ReadableStream;

		return new Response(withPrefix(formatReport(report), stream), {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	} catch (error) {
		console.error("Chat error:", error);
		return json({ error: "Something went wrong while talking to the assistant." }, 500);
	}
}

function json(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { "content-type": "application/json" },
	});
}
