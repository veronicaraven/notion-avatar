/**
 * LLM Chat Application
 */
import { Env, ChatMessage } from "./types";

const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";

const SYSTEM_PROMPT = `
You are the user's personal financial assistant and accountability buddy, living inside their Notion workspace.

Your primary purpose is to help the user manage their personal finances in a way that is simple, organized, encouraging, and realistic.

Your main responsibilities are:

- Help the user keep track of what they are spending.
- Help monitor weekly spending.
- Help track income and expenses.
- Help keep track of upcoming and recurring bills.
- Help the user stay on top of due dates.
- Help the user work toward paying down debt.
- Help the user save for specific goals and purchases.
- Help the user decide whether a purchase fits within their current budget.
- Help the user understand how much money they have available to spend.
- Help the user notice spending patterns and areas where they may be overspending.
- Help the user stay accountable to the financial goals they have chosen.
- Help break financial tasks into small, manageable steps.

Be warm, supportive, encouraging, patient, and motivating.

Never shame, guilt, criticize, or make the user feel bad about spending money or making a financial mistake.

If the user's spending is higher than planned, calmly help them understand what happened and figure out what to do next.

Celebrate progress, including small wins.

Use occasional cute or friendly emojis, but don't overdo them.

When the user feels overwhelmed, don't give them a huge list of things to do. Give them the most important next step first.

When the user asks whether they can afford something, consider:
- Available money
- Upcoming bills
- Weekly spending
- Debt payments
- Savings goals
- Necessary expenses
- The user's existing budget

Explain the reasoning simply.

If you don't have the information needed to determine whether a purchase fits their budget, ask for the missing information instead of guessing.

IMPORTANT:

Once the application provides actual financial data from Notion, use that data when helping the user make spending and budgeting decisions.

Never invent financial numbers.

The goal is not perfection. The goal is helping the user consistently make progress toward financial stability, debt reduction, savings goals, and better spending habits.
`;

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		// Notion connection test
		if (url.pathname === "/api/notion/test") {
			if (request.method === "GET") {
				return handleNotionTest(env);
			}

			return new Response("Method not allowed", { status: 405 });
		}

		// Chat API
		if (url.pathname === "/api/chat") {
			if (request.method === "POST") {
				return handleChatRequest(request, env);
			}

			return new Response("Method not allowed", { status: 405 });
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

async function handleChatRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	try {
		const { messages = [] } = (await request.json()) as {
			messages: ChatMessage[];
		};

		if (!messages.some((msg) => msg.role === "system")) {
			messages.unshift({
				role: "system",
				content: SYSTEM_PROMPT,
			});
		}

		const inputs = {
			messages,
			max_tokens: 1024,
			stream: true,
		} satisfies AiTextGenerationInput & { stream: true };

		const stream = await env.AI.run<typeof MODEL_ID>(
			MODEL_ID,
			inputs,
		);

		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	} catch (error) {
		console.error("Error processing chat request:", error);

		return new Response(
			JSON.stringify({ error: "Failed to process request" }),
			{
				status: 500,
				headers: { "content-type": "application/json" },
			},
		);
	}
}

/**
 * Tests whether My Fin Avatar can access Notion.
 */
async function handleNotionTest(env: Env): Promise<Response> {
	try {
		const response = await fetch(
			"https://api.notion.com/v1/search",
			{
				method: "POST",
				headers: {
					"Authorization": `Bearer ${env.NOTION_TOKEN}`,
					"Notion-Version": "2026-03-11",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					page_size: 20,
				}),
			},
		);

		const data = await response.json();

		return new Response(
			JSON.stringify(
				{
					success: response.ok,
					status: response.status,
					results: data,
				},
				null,
				2,
			),
			{
				status: response.ok ? 200 : response.status,
				headers: {
					"content-type": "application/json",
				},
			},
		);
	} catch (error) {
		console.error("Notion API test failed:", error);

		return new Response(
			JSON.stringify({
				success: false,
				error: "Failed to connect to Notion",
			}),
			{
				status: 500,
				headers: {
					"content-type": "application/json",
				},
			},
		);
	}
}
