/**
 * Shared settings for Fin.
 */

/**
 * The model used for BOTH reading your message (to spot purchases/income to
 * log) and for chatting. The 70B model is much better at doing money math and
 * at pulling exact amounts out of a message than the 8B one.
 *
 * To save Workers AI usage you can switch to the smaller model:
 *   "@cf/meta/llama-3.1-8b-instruct-fp8"
 * but expect more mistakes when logging and doing math.
 */
export const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * Used only if the browser doesn't send its timezone. Dates like "today" and
 * "yesterday" depend on this. Any IANA name works, e.g. "America/New_York".
 */
export const DEFAULT_TZ = "America/Denver";
