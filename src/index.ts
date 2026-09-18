import { Env, ChatMessage } from "./types";

const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";
const NOTION_VERSION = "2026-03-11";

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
You have access to financial information retrieved from the user's Notion workspace.

Use the Notion financial data provided in the conversation context when answering questions.

Never invent financial numbers.

If the relevant financial data is unavailable, clearly say that you don't have that information yet.

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

		// Test Notion connection and discover accessible content
		if (url.pathname === "/api/notion/test" && request.method === "GET") {
			return handleNotionTest(env);
		}

		// Chat endpoint
		if (url.pathname === "/api/chat" && request.method === "POST") {
			return handleChat(request, env);
		}

		// Serve website
		return env.ASSETS.fetch(request);
	},
};

/**
 * Search Notion for pages/databases the integration can access.
 */
async function searchNotion(env: Env): Promise<any[]> {
	const response = await fetch("https://api.notion.com/v1/search", {
		method: "POST",
		headers: NOTION_HEADERS(env),
		body: JSON.stringify({
			page_size: 100,
		}),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new Error(`Notion search failed: ${response.status} ${error}`);
	}

	const data = await response.json();

	return data.results ?? [];
}

/**
 * Retrieve database metadata, including its data sources.
 */
async function getDatabase(
	env: Env,
	databaseId: string,
): Promise<any> {
	const response = await fetch(
		`https://api.notion.com/v1/databases/${databaseId}`,
		{
			method: "GET",
			headers: NOTION_HEADERS(env),
		},
	);

	if (!response.ok) {
		return null;
	}

	return await response.json();
}

/**
 * Query a Notion data source for its entries.
 */
async function queryDataSource(
	env: Env,
	dataSourceId: string,
): Promise<any[]> {
	const response = await fetch(
		`https://api.notion.com/v1/data_sources/${dataSourceId}/query`,
		{
			method: "POST",
			headers: NOTION_HEADERS(env),
			body: JSON.stringify({
				page_size: 100,
			}),
		},
	);

	if (!response.ok) {
		return [];
	}

	const data = await response.json();

	return data.results ?? [];
}

/**
 * Convert Notion properties into readable text for the AI.
 */
function simplifyProperties(properties: any): Record<string, any> {
	const simplified: Record<string, any> = {};

	for (const [name, property] of Object.entries(properties ?? {})) {
		const p = property as any;

		switch (p.type) {
			case "title":
				simplified[name] =
					p.title?.map((x: any) => x.plain_text).join("") ?? "";
				break;

			case "rich_text":
				simplified[name] =
					p.rich_text?.map((x: any) => x.plain_text).join("") ?? "";
				break;

			case "number":
				simplified[name] = p.number;
				break;

			case "select":
				simplified[name] = p.select?.name ?? null;
				break;

			case "multi_select":
				simplified[name] =
					p.multi_select?.map((x: any) => x.name) ?? [];
				break;

			case "date":
				simplified[name] = p.date?.start ?? null;
				break;

			case "checkbox":
				simplified[name] = p.checkbox;
				break;

			case "url":
				simplified[name] = p.url;
				break;

			case "email":
				simplified[name] = p.email;
				break;

			case "formula":
				simplified[name] = p.formula;
				break;

			case "status":
				simplified[name] = p.status?.name ?? null;
				break;

			case "people":
				simplified[name] =
					p.people?.map((x: any) => x.name ?? x.id) ?? [];
				break;

			case "relation":
				simplified[name] =
					p.relation?.map((x: any) => x.id) ?? [];
				break;

			default:
				simplified[name] = null;
		}
	}

	return simplified;
}

/**
 * Retrieve finance-related data from Notion.
 */
async function getFinancialContext(env: Env): Promise<string> {
	try {
		const results = await searchNotion(env);

		const financeKeywords = [
			"incomes",
			"income",
			"expenses",
			"expense",
			"budget",
			"month",
			"week",
			"bills",
			"debt",
			"savings",
			"financial",
			"finance",
		];

		const relevantResults = results.filter((item: any) => {
			const title =
				item.properties?.title?.title
					?.map((x: any) => x.plain_text)
					.join("") ??
				item.properties?.Name?.title
					?.map((x: any) => x.plain_text)
					.join("") ??
				"";

			const normalizedTitle = title.toLowerCase();

			return financeKeywords.some((keyword) =>
				normalizedTitle.includes(keyword),
			);
		});

		const databases = [];

		for (const item of relevantResults) {
			if (item.object !== "database") {
				continue;
			}

			const database = await getDatabase(env, item.id);

			if (!database) {
				continue;
			}

			const dataSources = database.data_sources ?? [];

			for (const source of dataSources) {
				const rows = await queryDataSource(env, source.id);

				const simplifiedRows = rows.map((row: any) => ({
					id: row.id,
					properties: simplifyProperties(row.properties),
				}));

				databases.push({
					name: source.name ?? database.title?.[0]?.plain_text ?? "Database",
					database_id: database.id,
					data_source_id: source.id,
					entries: simplifiedRows,
				});
			}
		}

		if (databases.length === 0) {
			return "No financial databases were found in the accessible Notion content.";
		}

		return JSON.stringify(databases, null, 2);
	} catch (error) {
		console.error("Financial context error:", error);

		return "Financial data could not be retrieved from Notion.";
	}
}

/**
 * Test endpoint.
 *
 * Open /api/notion/test to see what financial databases
 * the integration can discover.
 */
async function handleNotionTest(env: Env): Promise<Response> {
	try {
		const results = await searchNotion(env);

		const databases = [];

		for (const item of results) {
			if (item.object !== "database") {
				continue;
			}

			const database = await getDatabase(env, item.id);

			if (!database) {
				continue;
			}

			databases.push({
				id: database.id,
				title:
					database.title?.map((x: any) => x.plain_text).join("") ?? "",
				data_sources: database.data_sources ?? [],
			});
		}

		return new Response(
			JSON.stringify(
				{
					success: true,
					search_results: results.length,
					databases,
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

		// Retrieve current financial information from Notion.
		const financialContext = await getFinancialContext(env);

		const contextualSystemPrompt = `
${SYSTEM_PROMPT}

CURRENT NOTION FINANCIAL DATA:

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
