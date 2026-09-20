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

/**
 * Your Week and Month pages only total up entries that are LINKED to them
 * (Week -> Incomes / Daily Purchases, and Income -> Month). Entries typed
 * straight into a database often aren't linked, so Notion's own totals come out
 * too low. When this is true, Fin links any unlinked income/purchase rows for the
 * current week (and income rows to their Month) so those Notion totals are right.
 * It only ever ADDS links; it never removes or edits anything else.
 */
export const AUTO_LINK_IN_NOTION = true;
