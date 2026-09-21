/**
 * Small Notion API client + helpers for reading property values.
 */
import type { Env } from "./types";

export const NOTION_VERSION = "2026-03-11";
const API = "https://api.notion.com/v1";

export interface NotionPage {
	id: string;
	url?: string;
	created_time?: string;
	properties: Record<string, any>;
}

export class NotionError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = "NotionError";
		this.status = status;
	}
}

async function call(
	env: Env,
	path: string,
	method: "GET" | "POST" | "PATCH",
	body?: unknown,
	attempt = 0,
): Promise<any> {
	const res = await fetch(`${API}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${env.NOTION_TOKEN}`,
			"Notion-Version": NOTION_VERSION,
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});

	// Notion rate-limits to ~3 requests/second. Wait and retry a couple of times.
	if (res.status === 429 && attempt < 2) {
		const wait = Number(res.headers.get("Retry-After")) || 1;
		await new Promise((r) => setTimeout(r, Math.min(wait, 5) * 1000));
		return call(env, path, method, body, attempt + 1);
	}

	if (!res.ok) {
		const text = await res.text();
		throw new NotionError(
			res.status,
			`${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`,
		);
	}
	return res.json();
}

/** Query a data source, following pagination up to `maxPages` (100 rows each). */
export async function queryAll(
	env: Env,
	dataSourceId: string,
	opts: { filter?: unknown; sorts?: unknown[]; maxPages?: number } = {},
): Promise<NotionPage[]> {
	const pages: NotionPage[] = [];
	let cursor: string | undefined;
	const maxPages = opts.maxPages ?? 1;

	for (let i = 0; i < maxPages; i++) {
		const data = await call(env, `/data_sources/${dataSourceId}/query`, "POST", {
			page_size: 100,
			...(opts.filter ? { filter: opts.filter } : {}),
			...(opts.sorts ? { sorts: opts.sorts } : {}),
			...(cursor ? { start_cursor: cursor } : {}),
		});
		pages.push(...((data.results ?? []) as NotionPage[]));
		if (!data.has_more || !data.next_cursor) break;
		cursor = data.next_cursor;
	}
	return pages;
}

export function createPage(
	env: Env,
	dataSourceId: string,
	properties: Record<string, unknown>,
): Promise<NotionPage> {
	return call(env, "/pages", "POST", {
		parent: { type: "data_source_id", data_source_id: dataSourceId },
		properties,
	});
}

export function getPage(env: Env, pageId: string): Promise<NotionPage> {
	return call(env, `/pages/${pageId}`, "GET");
}

export function updatePage(env: Env, pageId: string, body: unknown): Promise<NotionPage> {
	return call(env, `/pages/${pageId}`, "PATCH", body);
}

/** Moves a page to Notion's trash (recoverable from Trash for 30 days). */
export function trashPage(env: Env, pageId: string): Promise<NotionPage> {
	return updatePage(env, pageId, { in_trash: true });
}

/**
 * Adds one page to a relation property without losing the ones already there.
 * (Notion replaces the whole relation list on update, so we read it first.)
 */
export async function appendRelation(
	env: Env,
	pageId: string,
	propertyName: string,
	newId: string,
): Promise<void> {
	const page = await getPage(env, pageId);
	const prop = page.properties?.[propertyName];
	if (!prop || prop.type !== "relation") {
		throw new Error(`"${propertyName}" isn't a relation property on that page`);
	}

	let ids: string[] = (prop.relation ?? []).map((r: { id: string }) => r.id);

	// A page response only includes the first 25 relations; fetch the rest.
	if (prop.has_more) {
		ids = [];
		let cursor: string | undefined;
		do {
			const qs = new URLSearchParams({ page_size: "100" });
			if (cursor) qs.set("start_cursor", cursor);
			const data = await call(
				env,
				`/pages/${pageId}/properties/${encodeURIComponent(prop.id)}?${qs.toString()}`,
				"GET",
			);
			for (const item of data.results ?? []) {
				if (item.relation?.id) ids.push(item.relation.id);
			}
			cursor = data.has_more ? data.next_cursor : undefined;
		} while (cursor);
	}

	if (ids.includes(newId)) return;

	await updatePage(env, pageId, {
		properties: {
			[propertyName]: { relation: [...ids, newId].map((id) => ({ id })) },
		},
	});
}

/* ---------------- Reading property values ---------------- */

/** Turns any Notion property into a simple value (string, number, array...). */
export function plain(prop: any): any {
	if (!prop) return null;
	switch (prop.type) {
		case "title":
			return (prop.title ?? []).map((t: any) => t.plain_text).join("");
		case "rich_text":
			return (prop.rich_text ?? []).map((t: any) => t.plain_text).join("");
		case "number":
			return prop.number;
		case "select":
			return prop.select?.name ?? null;
		case "status":
			return prop.status?.name ?? null;
		case "multi_select":
			return (prop.multi_select ?? []).map((o: any) => o.name);
		case "date":
			if (!prop.date) return null;
			return prop.date.end ? `${prop.date.start} to ${prop.date.end}` : prop.date.start;
		case "checkbox":
			return prop.checkbox;
		case "url":
		case "email":
		case "phone_number":
			return prop[prop.type] ?? null;
		case "created_time":
			return prop.created_time;
		case "last_edited_time":
			return prop.last_edited_time;
		case "relation":
			return (prop.relation ?? []).map((r: any) => r.id);
		case "formula":
			return plainFormula(prop.formula);
		case "rollup":
			return plainRollup(prop.rollup);
		default:
			return null;
	}
}

function plainFormula(f: any): any {
	if (!f) return null;
	if (f.type === "date") return f.date?.start ?? null;
	return f[f.type] ?? null;
}

function plainRollup(r: any): any {
	if (!r) return null;
	if (r.type === "array") return (r.array ?? []).map((item: any) => plain(item));
	if (r.type === "date") return r.date?.start ?? null;
	return r[r.type] ?? null;
}

/** The page's title text, whatever the title property is called. */
export function titleOf(page: NotionPage): string {
	for (const prop of Object.values(page.properties ?? {})) {
		if ((prop as any)?.type === "title") return plain(prop) ?? "";
	}
	return "";
}

/* ---------------- Building property values for writes ---------------- */

export const P = {
	title: (text: string) => ({ title: [{ text: { content: text.slice(0, 200) } }] }),
	number: (n: number) => ({ number: n }),
	select: (name: string) => ({ select: { name } }),
	status: (name: string) => ({ status: { name } }),
	date: (iso: string) => ({ date: { start: iso } }),
	relation: (ids: string[]) => ({ relation: ids.map((id) => ({ id })) }),
};
