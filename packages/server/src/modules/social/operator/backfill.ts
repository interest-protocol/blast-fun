import { z } from "zod";
import type { ModuleTransaction } from "@blast/core/modules/database/transaction.ts";
import { socialOperatorCommand, type SocialOperatorLogEntry } from "./framework.ts";

/**
 * `backfill`: the release backfill. Every Mission Control profile gets its
 * `social_accounts` row (`onboarded_at` null), as account resolution would
 * create it. Every recruit who joined with a `member` code follows that
 * code's owner (`source = 'launch_code'`), and the recruit's
 * `launch_code_follow_applied_at` is set, so onboarding never re-adds the
 * follow after an unfollow. Referrals through `sticky`, `team` and `creator`
 * codes have no member owner and make no follow.
 *
 * Safe to re-run: rows are inserted with `ON CONFLICT DO NOTHING`, and a
 * recruit whose marker is set is skipped, so a second run creates nothing.
 * Work runs in bounded batches over primary-key ranges, each its own
 * transaction, so a copy of production (about 10,000 profiles) holds no
 * lock for long. Concurrent backfill batches are serialized by an advisory
 * lock; live account creation (`GET /me`) and onboarding interleave safely
 * (see the statements).
 */

export const SOCIAL_BACKFILL_BATCH_SIZE = 500;
export const SOCIAL_BACKFILL_MAX_BATCH_SIZE = 5_000;
const BATCH_SIZE_FLAG = "--batch-size";
const BEFORE_FIRST_UUID = "00000000-0000-0000-0000-000000000000";

export type SocialBackfillCounts = {
  profiles_scanned: number;
  accounts_created: number;
  member_referrals_scanned: number;
  recruits_marked: number;
  launch_code_follows_created: number;
  batches: number;
};

type Social = ModuleTransaction<"social">;

/** `[]` or `--batch-size <1..5000>`; anything else is refused. */
export function parseBackfillArgs(args: readonly string[]): { batchSize: number } | null {
  if (args.length === 0) return { batchSize: SOCIAL_BACKFILL_BATCH_SIZE };
  const parsed = z.tuple([z.literal(BATCH_SIZE_FLAG), z.string().regex(/^[1-9][0-9]{0,3}$/).transform(Number).pipe(z.number().max(SOCIAL_BACKFILL_MAX_BATCH_SIZE))]).safeParse(args);
  return parsed.success ? { batchSize: parsed.data[1] } : null;
}

/** One backfill batch at a time, across concurrent runs. */
const SERIALIZE = "SELECT pg_advisory_xact_lock(hashtext('social_backfill'))";

const PROFILES_AFTER = `
  SELECT profile_id
  FROM mission_control_profiles
  WHERE profile_id > $1
  ORDER BY profile_id
  LIMIT $2`;

/**
 * The profiles' account rows. A concurrent `GET /me` inserts the same row
 * with the same statement shape: whichever commits first wins, the other
 * waits for it and does nothing, so each profile has exactly one row.
 */
const ENSURE_ACCOUNTS = `
  INSERT INTO social_accounts (account_id, profile_id)
  SELECT gen_random_uuid(), batch.profile_id
  FROM unnest($1::uuid[]) AS batch (profile_id)
  ON CONFLICT DO NOTHING`;

/**
 * Recruits who joined with a `member` code, and that code's owner. The
 * same rule as onboarding's launch-code referrer.
 */
const MEMBER_REFERRALS_AFTER = `
  SELECT r.recruited_profile_id, r.referrer_profile_id
  FROM mission_control_referrals r
  JOIN mission_control_invitation_codes c ON c.code_id = r.source_code_id
  WHERE r.recruited_profile_id > $1
    AND c.code_kind = 'member'
    AND c.owner_profile_id = r.referrer_profile_id
  ORDER BY r.recruited_profile_id
  LIMIT $2`;

/**
 * Claims the recruits whose launch-code follow was never applied. Onboarding
 * holds the account row (`FOR UPDATE`) while it applies the same follow and
 * marker; this UPDATE waits for it and, under READ COMMITTED, re-checks the
 * marker on the committed row, so a recruit is claimed by exactly one of
 * them and a removed follow is never re-added.
 */
const CLAIM_RECRUITS = `
  UPDATE social_accounts AS a
  SET launch_code_follow_applied_at = now()
  FROM unnest($1::uuid[]) AS recruit (profile_id)
  WHERE a.profile_id = recruit.profile_id
    AND a.launch_code_follow_applied_at IS NULL
  RETURNING a.account_id, a.profile_id`;

const APPLY_LAUNCH_CODE_FOLLOWS = `
  INSERT INTO social_follows (follower_account_id, target_kind, target_id, source)
  SELECT claimed.account_id, 'account', referrer.account_id::text, 'launch_code'
  FROM unnest($1::uuid[], $2::uuid[]) AS claimed (account_id, referrer_profile_id)
  JOIN social_accounts referrer ON referrer.profile_id = claimed.referrer_profile_id
  WHERE referrer.account_id <> claimed.account_id
  ON CONFLICT DO NOTHING`;

async function ensureAccounts(social: Social, profileIds: readonly string[]): Promise<number> {
  const { rowCount } = await social.write("social_accounts", ENSURE_ACCOUNTS, [profileIds]);
  return rowCount ?? 0;
}

type Referral = { recruited_profile_id: string; referrer_profile_id: string };

/** The log entry for counts so far; `completed` is false while batches remain. */
function logEntry(counts: SocialBackfillCounts, completed: boolean): SocialOperatorLogEntry {
  return { action: "backfill", target: "*", before: null, after: { ...counts, completed } };
}

export const backfill = socialOperatorCommand<{ batchSize: number }>({
  path: ["backfill"],
  usage: `backfill [${BATCH_SIZE_FLAG} <1..${SOCIAL_BACKFILL_MAX_BATCH_SIZE}>]   (release: member accounts and launch-code follows; safe to re-run; default ${SOCIAL_BACKFILL_BATCH_SIZE} per batch)`,
  parse: parseBackfillArgs,
  runBatches: async ({ batchSize }, { batch, progress }) => {
    const counts: SocialBackfillCounts = {
      profiles_scanned: 0,
      accounts_created: 0,
      member_referrals_scanned: 0,
      recruits_marked: 0,
      launch_code_follows_created: 0,
      batches: 0,
    };
    /** Counts one committed batch transaction and records the totals so far. */
    const committed = () => {
      counts.batches += 1;
      progress(logEntry(counts, false));
    };

    // 1. Accounts, by profile id.
    for (let after = BEFORE_FIRST_UUID; ;) {
      const done = await batch(async (social) => {
        await social.read(SERIALIZE);
        const ids = (await social.read<{ profile_id: string }>(PROFILES_AFTER, [after, batchSize])).rows
          .map((row) => row.profile_id);
        if (ids.length === 0) return { scanned: 0, created: 0, last: null };
        return { scanned: ids.length, created: await ensureAccounts(social, ids), last: ids.at(-1)! };
      });
      if (!done.last) break;
      counts.profiles_scanned += done.scanned;
      counts.accounts_created += done.created;
      committed();
      after = done.last;
    }

    // 2. Launch-code follows, by recruit. The accounts a profile created
    // since step 1 are ensured and committed first, so the claim
    // transaction only takes row locks on recruits and never waits on an
    // account insert while holding them.
    for (let after = BEFORE_FIRST_UUID; ;) {
      const { referrals, created } = await batch(async (social) => {
        await social.read(SERIALIZE);
        const rows = (await social.read<Referral>(MEMBER_REFERRALS_AFTER, [after, batchSize])).rows;
        if (rows.length === 0) return { referrals: rows, created: 0 };
        const profiles = new Set(rows.flatMap((row) => [row.recruited_profile_id, row.referrer_profile_id]));
        return { referrals: rows, created: await ensureAccounts(social, [...profiles]) };
      });
      if (referrals.length === 0) break;
      counts.accounts_created += created;
      committed();
      const applied = await batch(async (social) => {
        await social.read(SERIALIZE);
        const claimed = (await social.write<{ account_id: string; profile_id: string }>(
          "social_accounts",
          CLAIM_RECRUITS,
          [referrals.map((row) => row.recruited_profile_id)],
        )).rows;
        if (claimed.length === 0) return { marked: 0, follows: 0 };
        const referrerOf = new Map(referrals.map((row) => [row.recruited_profile_id, row.referrer_profile_id]));
        const { rowCount } = await social.write("social_follows", APPLY_LAUNCH_CODE_FOLLOWS, [
          claimed.map((row) => row.account_id),
          claimed.map((row) => referrerOf.get(row.profile_id)),
        ]);
        return { marked: claimed.length, follows: rowCount ?? 0 };
      });
      counts.member_referrals_scanned += referrals.length;
      counts.recruits_marked += applied.marked;
      counts.launch_code_follows_created += applied.follows;
      committed();
      after = referrals.at(-1)!.recruited_profile_id;
    }

    return { result: { ...counts }, log: logEntry(counts, true) };
  },
});
