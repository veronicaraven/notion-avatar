export interface ChatMessage {
	role: "user" | "assistant";
	content: string;
}

/** Minimal Workers AI binding shape used by this project. */
export interface AiBinding {
	run(model: string, input: unknown): Promise<unknown>;
}

/** Minimal static assets binding shape used by this project. */
export interface AssetsBinding {
	fetch(request: Request): Promise<Response>;
}

/** Minimal KV shape needed by Fin. */
export interface KvBinding {
	get(key: string): Promise<string | null>;
	put(
		key: string,
		value: string,
		options?: { expirationTtl?: number },
	): Promise<void>;
	delete(key: string): Promise<void>;
}

export interface Env {
	NOTION_TOKEN: string;
	AI: AiBinding;
	ASSETS: AssetsBinding;

	/** Optional Cloudflare KV binding. Binding name must be FIN_MEMORY. */
	FIN_MEMORY?: KvBinding;

	/** Optional override. If omitted, Fin discovers the Notion data source titled "Budget Plan". */
	BUDGET_PLAN_DATA_SOURCE_ID?: string;

	/** Set to "true" only when you intentionally want /api/notion/test exposed. */
	ENABLE_DIAGNOSTICS?: string;
}
