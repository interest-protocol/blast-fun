import type { ModuleTransaction } from "@blast/core/modules/database/transaction.ts";
import { WHY_RECORDS_PER_ITEM } from "@blast/core/modules/social/whys/validate.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
type Social = ModuleTransaction<"social">;
type WhyState = "active" | "deleted" | "removed";

/**
 * The refusal an item's existing why records mean for a new one, or null:
 * an active why is `why_exists`, a removed one `why_removed`, and three
 * records in any state `why_limit`.
 */
export function itemWhyRefusal(
  states: readonly WhyState[],
): "why_exists" | "why_removed" | "why_limit" | null {
  if (states.includes("active")) return "why_exists";
  if (states.includes("removed")) return "why_removed";
  if (states.length >= WHY_RECORDS_PER_ITEM) return "why_limit";
  return null;
}

/** The item's transaction lock: every writer of a why takes it before reading the item's records. */
export const WHY_ITEM_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('social_why:' || $1))";
/** Every why record of one item, in any state (`social_whys_entry_idx`). */
export const WHY_ITEM_RECORDS_SQL = "SELECT state FROM social_whys WHERE entry_id = $1";
export const WHY_INSERT_SQL =
  "INSERT INTO social_whys (why_id, entry_id, author_account_id, text) VALUES ($1, $2, $3, $4)";
/**
 * One why by its id, with its row locked for this transaction: the author's
 * delete reads it and then writes it, so two deletes of one why cannot both
 * see it active. `FOR NO KEY UPDATE` (the delete never changes `why_id`) lets
 * a report of the same why check its foreign key meanwhile.
 */
export const WHY_FOR_UPDATE_SQL =
  "SELECT author_account_id, state FROM social_whys WHERE why_id = $1 FOR NO KEY UPDATE";
/** One why by its id (the report route only reads it). */
export const WHY_BY_ID_SQL = "SELECT author_account_id, state FROM social_whys WHERE why_id = $1";
/** The author's retraction. `state = 'active'` makes a repeated delete write nothing. */
export const WHY_DELETE_SQL =
  "UPDATE social_whys SET state = 'deleted', deleted_at = now() WHERE why_id = $1 AND state = 'active'";
/** One report per account per why: its primary key makes a repeat a no-op, so retrying is harmless. */
export const WHY_REPORT_SQL =
  "INSERT INTO social_why_reports (why_id, reporter_account_id, reason) VALUES ($1, $2, $3) ON CONFLICT (why_id, reporter_account_id) DO NOTHING";

export async function createWhy(
  social: Social,
  input: Readonly<{
    whyId: string;
    entryId: string;
    accountId: string;
    text: string;
  }>,
): Promise<void> {
  await social.read(WHY_ITEM_LOCK_SQL, [input.entryId]);
  const { rows } = await social.read<{ state: WhyState }>(WHY_ITEM_RECORDS_SQL, [input.entryId]);
  const refusal = itemWhyRefusal(rows.map((row) => row.state));
  if (refusal) throw new SocialRouteError(refusal);
  await social.write("social_whys", WHY_INSERT_SQL, [
    input.whyId,
    input.entryId,
    input.accountId,
    input.text,
  ]);
}

export async function retractWhy(social: Social, whyId: string, accountId: string): Promise<void> {
  const { rows } = await social.read<{
    author_account_id: string;
    state: WhyState;
  }>(WHY_FOR_UPDATE_SQL, [whyId]);
  const why = rows[0];
  if (!why) throw new SocialRouteError("not_found");
  if (why.author_account_id !== accountId) throw new SocialRouteError("not_author");
  if (why.state === "deleted") return;
  if (why.state === "removed") throw new SocialRouteError("why_removed");
  await social.write("social_whys", WHY_DELETE_SQL, [whyId]);
}

export async function reportWhy(
  social: Social,
  whyId: string,
  accountId: string,
  reason: string | undefined,
): Promise<boolean> {
  const { rows } = await social.read<{
    author_account_id: string;
    state: WhyState;
  }>(WHY_BY_ID_SQL, [whyId]);
  const why = rows[0];
  if (!why || why.state !== "active") throw new SocialRouteError("not_found");
  if (why.author_account_id === accountId) throw new SocialRouteError("cannot_report_self");
  const written = await social.write("social_why_reports", WHY_REPORT_SQL, [
    whyId,
    accountId,
    reason || null,
  ]);
  return written.rowCount === 1;
}
