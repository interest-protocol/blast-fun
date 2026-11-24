import { z } from "zod";
import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { withTransaction } from "@blast/core/modules/database/transaction.ts";
import { parseRecordId } from "@blast/server/modules/launchpad-social/contracts.ts";
import { type Visibility, VISIBILITIES } from "@blast/core/modules/launchpad-social/post-contract.ts";
import type { SocialLimits } from "@blast/core/modules/launchpad-social/limits.ts";
import {
  materializeSearchDocument,
  readRecord,
  removeSearchDocument,
  type PostRecord,
} from "@blast/server/modules/launchpad-social/repository.ts";

export type VisibilityChange = Readonly<{
  recordId: string;
  visibility: Visibility;
  /** A short code for why, such as `spam`; no thresholds are applied here. */
  reason: string;
  /** Who decided: an operator's label. */
  moderator: string;
}>;

/** A moderation reason: a short lowercase code such as `spam`. */
export const MODERATION_REASON = /^[a-z][a-z0-9_-]{0,63}$/;
const MODERATOR = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

/**
 * Hides a post record from, or restores it to, the public list and search.
 * The record and its author, text and provenance stay; only its visibility
 * changes, and every change appends a moderation action. Hiding removes its
 * search row; restoring materializes it again when the record is still its
 * post's current one (search re-joins the canonical launch at read time). A change to the visibility
 * a record already has does nothing. Null when there is no such record. One
 * transaction on the primary (`moderation` workload), as the web runtime.
 */
export async function setThesisVisibility(
  pool: Pool,
  change: VisibilityChange,
  options: Readonly<{ createId?: () => string; limits?: SocialLimits }> = {},
): Promise<PostRecord | null> {
  const recordId = parseRecordId(change.recordId);
  if (!(VISIBILITIES as readonly string[]).includes(change.visibility)) throw new TypeError("Unknown visibility.");
  if (!z.string().regex(MODERATION_REASON).safeParse(change.reason).success) throw new TypeError("A moderation reason is a short code.");
  if (!z.string().regex(MODERATOR).safeParse(change.moderator).success) throw new TypeError("A moderator is a short label.");
  const createId = options.createId ?? randomUUID;
  return withTransaction(pool, async (transaction) => {
    const social = transaction.forModule("launchpad-social");
    const record = await readRecord(social, recordId, { lock: true });
    if (!record || record.moderationState === change.visibility) return record;
    const updated = await social.write(
      "mission_control_launchpad_theses",
      `UPDATE mission_control_launchpad_theses
       SET visibility = $2, visibility_changed_at = NOW()
       WHERE record_id = $1
       RETURNING visibility_changed_at`,
      [recordId, change.visibility],
    );
    await social.write(
      "mission_control_launchpad_thesis_moderation",
      `INSERT INTO mission_control_launchpad_thesis_moderation (action_id, record_id, visibility, reason, moderator)
       VALUES ($1, $2, $3, $4, $5)`,
      [createId(), recordId, change.visibility, change.reason, change.moderator],
    );
    const changed: PostRecord = {
      ...record,
      moderationState: change.visibility,
      moderationChangedAt: (updated.rows[0].visibility_changed_at as Date).toISOString(),
    };
    if (change.visibility === "hidden") await removeSearchDocument(social, recordId);
    else await materializeSearchDocument(social, changed, options.limits);
    return changed;
  }, { label: "launchpad.thesis_visibility" });
}
