import { accountIdOf, lockSocialAccount } from "../accounts/lookup.ts";
import {
  SOCIAL_FOLLOW_LIMIT,
  type SocialFollowTargetKind,
} from "@blast/core/modules/social/contracts/follows.ts";
import { ensureMemberAccount } from "../profiles/read.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { ModuleTransaction } from "@blast/core/modules/database/transaction.ts";
type Social = ModuleTransaction<"social">;

/**
 * The account at `callsign` to follow. A Mission Control member who never
 * opened Blast gets its account row first (as its profile's first read
 * creates it), so a member is followable before signing in.
 */
export async function followableAccountIdOf(
  social: Social,
  callsign: string,
): Promise<string | null> {
  const found = await accountIdOf(social, callsign);
  if (found !== null) return found;
  await ensureMemberAccount(social, callsign);
  return accountIdOf(social, callsign);
}

/**
 * Adds one follow, idempotently. The follower's account row is locked first
 * (`FOR NO KEY UPDATE`: it does not block references to the account), so
 * concurrent follows by one account count one at a time and the limit holds.
 * An existing follow is a success at any count and keeps its source.
 */
export async function follow(
  social: Social,
  followerId: string,
  kind: SocialFollowTargetKind,
  targetId: string,
): Promise<void> {
  await lockSocialAccount(social, followerId);
  const current = await social.read<{ total: number; present: boolean }>(
    `SELECT count(*)::int AS total, COALESCE(bool_or(target_kind = $2 AND target_id = $3), false) AS present
     FROM social_follows WHERE follower_account_id = $1`,
    [followerId, kind, targetId],
  );
  const { total, present } = current.rows[0]!;
  if (present) return;
  if (total >= SOCIAL_FOLLOW_LIMIT) throw new SocialRouteError("follow_limit");
  await social.write(
    "social_follows",
    `INSERT INTO social_follows (follower_account_id, target_kind, target_id, source)
     VALUES ($1, $2, $3, 'user') ON CONFLICT DO NOTHING`,
    [followerId, kind, targetId],
  );
}

export async function unfollow(
  social: Social,
  followerId: string,
  kind: SocialFollowTargetKind,
  targetId: string,
): Promise<void> {
  await social.write(
    "social_follows",
    "DELETE FROM social_follows WHERE follower_account_id = $1 AND target_kind = $2 AND target_id = $3",
    [followerId, kind, targetId],
  );
}
