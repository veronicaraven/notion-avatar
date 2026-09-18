import { Env, ChatMessage } from "./types";

const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";
const NOTION_VERSION = "2026-03-11";

const EXPENSES_DATA_SOURCE_ID =
	"bc89563c-5751-82a7-8836-87c7be4dae11";

const SYSTEM_PROMPT = `
You are the user's personal financial assistant and accountability buddy, living inside their Notion workspace.

Your primary job is to help the user:
- Track spending
- Understand income and expenses
- Stay on top of bills
- Pay down debt
- Build savings
- Stay consistent with financial goals
- Decide whether they can afford purchases
- Understand weekly and monthly spending
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
You have access to the user's Expenses database in Notion.

Use the financial data provided to you when answering questions.

Never invent financial numbers.

If the relevant data is unavailable, clearly say that you don't have that information yet.

When helping the user decide whether they can afford something, consider relevant information such as:
- Available money
- Income
- Upcoming bills
- Recent spending
- Weekly spending
- Debt payments
- Savings goals
- Necessary expenses
- Budget

When actual Notion data is available, use it instead of asking the user to manually provide information that is already available.

Explain financial information in a simple, easy-to-understand way.

The goal is to help the user make informed financial decisions while keeping the experience encouraging and easy to understand.
`;

const NOTION_HEADERS = (env: Env) => ({
	Authorization: `Bearer ${env.NOTION_TOKEN}`,
	"Notion-Version": NOTION_VERSION,
	"Content-Type": "application/json",
});

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/api/notion/test" && request.method === "GET") {
			return handleNotionTest(env);
		}

		if (url.pathname === "/api/chat" && request.method === "POST") {
			return handleChat(request, env);
		}

		return env.ASSETS.fetch(request);
	},
};

/**
 * Get the actual rows from the Expenses data source.
 */
async function getExpenses(env: Env): Promise<any[]> {
	const response = await fetch(
		`https://api.notion.com/v1/data_sources/${EXPENSES_DATA_SOURCE_ID}/query`,
		{
			method: "POST",
			headers: NOTION_HEADERS(env),
			body: JSON.stringify({
				page_size: 100,
			}),
		},
	);

	if (!response.ok) {
		const error = await response.text();
		throw new Error(
			`Expenses query failed: ${response.status} ${error}`,
		);
	}

	const data = await response.json();

	return data.results ?? [];
}

/**
 * Convert Notion properties into simple readable values.
 */
function simplifyProperties(
	properties: Record<string, any>,
): Record<string, any> {
	const simplified: Record<string, any> = {};

	for (const [name, property] of Object.entries(properties ?? {})) {
		switch (property.type) {
			case "title":
				simplified[name] =
					property.title
						?.map((item: any) => item.plain_text)
						.join("") ?? "";
				break;

			case "rich_text":
				simplified[name] =
					property.rich_text
						?.map((item: any) => item.plain_text)
						.join("") ?? "";
				break;

			case "number":
				simplified[name] = property.number;
				break;

			case "select":
				simplified[name] =
					property.select?.name ?? null;
				break;

			case "multi_select":
				simplified[name] =
					property.multi_select?.map(
						(item: any) => item.name,
					) ?? [];
				break;

			case "date":
				simplified[name] =
					property.date?.start ?? null;
				break;

			case "checkbox":
				simplified[name] = property.checkbox;
				break;

			case "status":
				simplified[name] =
					property.status?.name ?? null;
				break;

			case "formula":
				simplified[name] = property.formula;
				break;

			case "url":
				simplified[name] = property.url;
				break;

			case "email":
				simplified[name] = property.email;
				break;

			case "people":
				simplified[name] =
					property.people?.map(
						(item: any) => item.name ?? item.id,
					) ?? [];
				break;

			case "relation":
				simplified[name] =
					property.relation?.map(
						(item: any) => item.id,
					) ?? [];
				break;

			default:
				simplified[name] = null;
		}
	}

	return simplified;
}

/**
 * Test endpoint.
 *
 * This now retrieves the actual Expenses entries.
 */
async function handleNotionTest(env: Env): Promise<Response> {
	try {
		const expenses = await getExpenses(env);

		const simplifiedExpenses = expenses.map((expense: any) => ({
			id: expense.id,
			properties: simplifyProperties(expense.properties),
		}));

		return new Response(
			JSON.stringify(
				{
					success: true,
					count: simplifiedExpenses.length,
					expenses: simplifiedExpenses,
				},
				null,
				2,
			),
			{
				status: 200,
				headers: {
					"Content-Type": "application/json",
				},
			},
		);
	} catch (error) {
		return new Response(
			JSON.stringify(
				{
					success: false,
					error:
						error instanceof Error
							? error.message
							: String(error),
				},
				null,
				2,
			),
			{
				status: 500,
				headers: {
					"Content-Type": "application/json",
				},
			},
		);
	}
}

/**
 * Build financial context for the AI.
 */
async function getFinancialContext(env: Env): Promise<string> {
	try {
		const expenses = await getExpenses(env);

		const simplifiedExpenses = expenses.map((expense: any) => ({
			id: expense.id,
			properties: simplifyProperties(expense.properties),
		}));

		return JSON.stringify(
			{
				expenses: simplifiedExpenses,
			},
			null,
			2,
		);
	} catch (error) {
		console.error("Financial context error:", error);

		return "The Expenses database could not be retrieved.";
	}
}

/**
 * Chat with the financial assistant.
 */
async function handleChat(
	request: Request,
	env: Env,
): Promise<Response> {
	try {
		const body = (await request.json()) as {
			messages?: ChatMessage[];
		};

		const messages = body.messages ?? [];

		const financialContext = await getFinancialContext(env);

		const contextualSystemPrompt = `
${SYSTEM_PROMPT}

CURRENT EXPENSES DATA FROM NOTION:

${financialContext}

Use this data when relevant to the user's question.
`;

		const aiMessages: ChatMessage[] = [
			{
				role: "system",
				content: contextualSystemPrompt,
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
				error:
					"Something went wrong while talking to the assistant.",
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
