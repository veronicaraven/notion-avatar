import { Env, ChatMessage } from "./types";

const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";

const SYSTEM_PROMPT = `
You are the user's personal financial assistant and accountability buddy, living inside their Notion workspace.

Your primary job is to help the user:
- Track spending
- Understand income and expenses
- Stay on top of bills
- Pay down debt
- Build savings
- Stay consistent with their financial goals
- Decide whether they can afford purchases
- Understand their weekly and monthly spending
- Organize their finances

Your personality:
- Warm
- Encouraging
- Supportive
- Practical
- Never judgmental or shaming
- Honest and realistic
- Motivating without being pushy

IMPORTANT:
Once the application provides actual financial data from Notion, use that data when helping the user make spending and budgeting decisions.

Never invent financial numbers.

If financial data is unavailable, clearly say that you don't have the relevant data yet rather than making assumptions.

When helping the user decide whether they can afford something, consider:
- Available money
- Upcoming bills
- Recent spending
- Weekly spending
- Debt payments
- Savings goals
- Necessary expenses
- Their budget

When you have actual Notion data, use it instead of asking the user to manually provide information that is already available.

The goal is to help the user make informed financial decisions while keeping the experience encouraging and easy to understand.
`;

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		// Test Notion connection/database
		if (url.pathname === "/api/notion/test" && request.method === "GET") {
			return handleNotionTest(env);
		}

		// Chat endpoint
		if (url.pathname === "/api/chat" && request.method === "POST") {
			return handleChat(request, env);
		}

		// Serve the website
		return env.ASSETS.fetch(request);
	},
};

async function handleNotionTest(env: Env): Promise<Response> {
	const databaseId = "90f9563c575183f791dd81c85e73133c";

	const response = await fetch(
		`https://api.notion.com/v1/databases/${databaseId}`,
		{
			method: "GET",
			headers: {
				Authorization: `Bearer ${env.NOTION_TOKEN}`,
				"Notion-Version": "2026-03-11",
				"Content-Type": "application/json",
			},
		},
	);

	const data = await response.json();

	return new Response(
		JSON.stringify(
			{
				success: response.ok,
				status: response.status,
				database: data,
			},
			null,
			2,
		),
		{
			status: response.status,
			headers: {
				"Content-Type": "application/json",
			},
		},
	);
}

async function handleChat(
	request: Request,
	env: Env,
): Promise<Response> {
	try {
		const body = (await request.json()) as {
			messages?: ChatMessage[];
		};

		const messages = body.messages ?? [];

		const aiMessages: ChatMessage[] = [
			{
				role: "system",
				content: SYSTEM_PROMPT,
			},
			...messages,
		];

		const stream = await env.AI.run(MODEL_ID, {
			messages: aiMessages,
			stream: true,
		});

		return new Response(stream as ReadableStream, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				"connection": "keep-alive",
			},
		});
	} catch (error) {
		console.error("Chat error:", error);

		return new Response(
			JSON.stringify({
				error: "Something went wrong while talking to the assistant.",
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
