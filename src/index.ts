/**
 * LLM Chat Application Template
 *
 * A simple chat application using Cloudflare Workers AI.
 * This template demonstrates how to implement an LLM-powered chat interface with
 * streaming responses using Server-Sent Events (SSE).
 *
 * @license MIT
 */
import { Env, ChatMessage } from "./types";

// Model ID for Workers AI model
// https://developers.cloudflare.com/workers-ai/models/
const MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";

// Default system prompt

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

The user can sometimes struggle with staying organized and consistent with finances. Be especially helpful by reducing overwhelm, keeping information simple, and turning large financial tasks into small actionable steps.

PERSONALITY:

Be warm, supportive, encouraging, patient, and motivating.

Never shame, guilt, criticize, or make the user feel bad about spending money or making a financial mistake.

If the user's spending is higher than planned, calmly help them understand what happened and figure out what to do next.

Celebrate progress, including small wins.

Use occasional cute or friendly emojis, but don't overdo them.

When the user feels overwhelmed, don't give them a huge list of things to do. Give them the most important next step first.

PURCHASE DECISIONS:

When the user asks whether they can afford something, don't simply answer yes or no without considering their financial situation.

Consider factors such as:
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

You do not currently have access to the user's Notion databases.

Never claim that you read, created, changed, deleted, or tracked anything in Notion unless the application actually provides you with that information.

Never invent financial numbers.

Once the application provides actual financial data from Notion, use that data when helping the user make spending and budgeting decisions.

The goal is not perfection. The goal is helping the user consistently make progress toward financial stability, debt reduction, savings goals, and better spending habits.
`;
export default {
	/**
	 * Main request handler for the Worker
	 */
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		// Handle static assets (frontend)
		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		// API Routes
		if (url.pathname === "/api/chat") {
			// Handle POST requests for chat
			if (request.method === "POST") {
				return handleChatRequest(request, env);
			}

			// Method not allowed for other request types
			return new Response("Method not allowed", { status: 405 });
		}

		// Handle 404 for unmatched routes
		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

/**
 * Handles chat API requests
 */
async function handleChatRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	try {
		// Parse JSON request body
		const { messages = [] } = (await request.json()) as {
			messages: ChatMessage[];
		};

		// Add system prompt if not present
		if (!messages.some((msg) => msg.role === "system")) {
			messages.unshift({ role: "system", content: SYSTEM_PROMPT });
		}

		const inputs = {
			messages,
			max_tokens: 1024,
			stream: true,
		} satisfies AiTextGenerationInput & { stream: true };

		const stream = await env.AI.run<typeof MODEL_ID>(MODEL_ID, inputs, {
			// Uncomment to use AI Gateway
			// gateway: {
			//   id: "YOUR_GATEWAY_ID", // Replace with your AI Gateway ID
			//   skipCache: false,      // Set to true to bypass cache
			//   cacheTtl: 3600,        // Cache time-to-live in seconds
			// },
		});

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
