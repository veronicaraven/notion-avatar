/** Shared settings for Fin. */

/** Main model used for Fin's financial conversation and reasoning. */
export const CHAT_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Smaller model used only to turn messages like "spent $8 on lunch" into
 * structured logging actions. Keeping extraction separate saves AI usage.
 */
export const EXTRACTION_MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8";

/** Fallback timezone when the browser does not send one. */
export const DEFAULT_TZ = "America/Denver";

/** Keep Notion Week/Month relations repaired when Fin handles a message. */
export const AUTO_LINK_IN_NOTION = true;

/** Number of user/assistant messages retained in server-side KV memory. */
export const MEMORY_MESSAGE_LIMIT = 30;

/** KV expiration: 180 days. */
export const MEMORY_TTL_SECONDS = 60 * 60 * 24 * 180;
