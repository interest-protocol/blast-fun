import { randomUUID } from "node:crypto";

import type { ModuleTransaction } from "@blast/core/modules/database/transaction.ts";
import type { SocialPrivacy } from "@blast/core/modules/social/contracts/me.ts";
import type {
  SocialOnboardingCompleteResponse,
  SocialOnboardingFollow,
  SocialOnboardingFollowSource,
} from "@blast/core/modules/social/contracts/onboarding.ts";

type Social = ModuleTransaction<"social">;

type MarkerRow = {
  profile_id: string | null;
  onboarded: boolean;
  default_follows_applied: boolean;
  launch_code_follow_applied: boolean;
};

type StateRow = { privacy: SocialPrivacy; sharing_since_ms: string | null };

type FollowRow = {
  account_id: string;
  callsign: string;
  display_name: string | null;
  avatar_url: string | null;
  x_handle: string | null;
  source: SocialOnboardingFollowSource;
};

/** Locks the account's row for the rest of the transaction, so concurrent calls apply follows once. */
const LOCK_ACCOUNT = `
  SELECT
    profile_id,
    onboarded_at IS NOT NULL AS onboarded,
    default_follows_applied_at IS NOT NULL AS default_follows_applied,
    launch_code_follow_applied_at IS NOT NULL AS launch_code_follow_applied
  FROM social_accounts
  WHERE account_id = $1
  FOR UPDATE`;

/** The configured defaults at this moment, never the account itself. */
const APPLY_DEFAULT_FOLLOWS = `
  INSERT INTO social_follows (follower_account_id, target_kind, target_id, source)
  SELECT $1, 'account', d.account_id::text, 'default'
  FROM social_default_accounts d
  WHERE d.account_id <> $1
  ORDER BY d.position
  ON CONFLICT DO NOTHING`;

/**
 * The owner of the `member` code the profile joined with. `sticky`, `team`
 * and `creator` codes have no owning member, so they make no follow.
 */
const LAUNCH_CODE_REFERRER = `
  SELECT r.referrer_profile_id
  FROM mission_control_referrals r
  JOIN mission_control_invitation_codes c ON c.code_id = r.source_code_id
  WHERE r.recruited_profile_id = $1 AND c.code_kind = 'member' AND c.owner_profile_id = r.referrer_profile_id`;

/** The referrer's account row, created as account resolution would create it. */
const ENSURE_MEMBER_ACCOUNT = `
  INSERT INTO social_accounts (account_id, profile_id) VALUES ($1, $2)
  ON CONFLICT DO NOTHING`;

const MEMBER_ACCOUNT = "SELECT account_id FROM social_accounts WHERE profile_id = $1";

const APPLY_LAUNCH_CODE_FOLLOW = `
  INSERT INTO social_follows (follower_account_id, target_kind, target_id, source)
  SELECT $1, 'account', $2::uuid::text, 'launch_code'
  WHERE $2::uuid <> $1::uuid
  ON CONFLICT DO NOTHING`;

/** Both markers are set even when there was nothing to apply, so nothing is ever applied twice. */
const MARK_SHOWN = `
  UPDATE social_accounts SET
    onboarding_shown_at = COALESCE(onboarding_shown_at, now()),
    default_follows_applied_at = COALESCE(default_follows_applied_at, now()),
    launch_code_follow_applied_at = COALESCE(launch_code_follow_applied_at, now())
  WHERE account_id = $1`;

const ONBOARDING_FOLLOWS = `
  SELECT
    i.account_id::text AS account_id,
    i.callsign,
    i.display_name,
    i.avatar_url,
    i.x_handle,
    f.source
  FROM social_follows f
  JOIN social_account_identities i ON i.account_id::text = f.target_id
  LEFT JOIN social_default_accounts d ON d.account_id = i.account_id
  WHERE f.follower_account_id = $1
    AND f.target_kind = 'account'
    AND f.source IN ('launch_code', 'default')
    AND i.callsign IS NOT NULL
  ORDER BY f.source = 'default', d.position NULLS LAST, f.created_at, f.target_id`;

/** Completion of an account that has not finished; one that has keeps its state (`a.onboarded_at` guard). */
const COMPLETE = `
  UPDATE social_accounts AS a SET
    onboarded_at = now(),
    privacy = CASE WHEN $2::boolean THEN 'private' ELSE 'public' END,
    sharing_since = CASE WHEN $2::boolean THEN NULL ELSE now() END
  WHERE a.account_id = $1 AND a.onboarded_at IS NULL`;

const CURRENT_STATE = `
  SELECT privacy, floor(extract(epoch FROM sharing_since) * 1000)::bigint AS sharing_since_ms
  FROM social_accounts
  WHERE account_id = $1`;

async function lockAccount(social: Social, accountId: string): Promise<MarkerRow> {
  const row = (await social.read<MarkerRow>(LOCK_ACCOUNT, [accountId])).rows[0];
  if (!row) throw new Error("The onboarding account row is missing.");
  return row;
}

/**
 * The shown step on a locked account: the default follows and the
 * launch-code follow, each at most once in the account's life (its marker),
 * then `onboarding_shown_at` and both markers. Existing follows win
 * (`ON CONFLICT DO NOTHING`), so a target that is both a default and the
 * referrer keeps the first source written.
 */
async function applyShownStep(social: Social, accountId: string, markers: MarkerRow, createId: () => string): Promise<void> {
  if (!markers.default_follows_applied) {
    await social.write("social_follows", APPLY_DEFAULT_FOLLOWS, [accountId]);
  }
  if (!markers.launch_code_follow_applied && markers.profile_id) {
    const referrer = (await social.read<{ referrer_profile_id: string }>(LAUNCH_CODE_REFERRER, [markers.profile_id])).rows[0];
    if (referrer) {
      await social.write("social_accounts", ENSURE_MEMBER_ACCOUNT, [createId(), referrer.referrer_profile_id]);
      const target = (await social.read<{ account_id: string }>(MEMBER_ACCOUNT, [referrer.referrer_profile_id])).rows[0];
      if (!target) throw new Error("The referrer's account row is missing.");
      await social.write("social_follows", APPLY_LAUNCH_CODE_FOLLOW, [accountId, target.account_id]);
    }
  }
  await social.write("social_accounts", MARK_SHOWN, [accountId]);
}

export type OnboardingRepositoryOptions = Readonly<{ createId?: () => string }>;

/**
 * `onboarding/shown` in the caller's transaction: applies the shown step
 * when it has not run, then answers the account's current `launch_code` and
 * `default` follows. A follow the account removed stays removed: the markers
 * never let the step run again.
 */
export async function markOnboardingShown(
  social: Social,
  accountId: string,
  options: OnboardingRepositoryOptions = {},
): Promise<SocialOnboardingFollow[]> {
  const markers = await lockAccount(social, accountId);
  await applyShownStep(social, accountId, markers, options.createId ?? randomUUID);
  return onboardingFollows(social, accountId);
}

/** The account's current follows whose source is `launch_code` or `default`, with each target's identity. */
export async function onboardingFollows(social: Social, accountId: string): Promise<SocialOnboardingFollow[]> {
  const { rows } = await social.read<FollowRow>(ONBOARDING_FOLLOWS, [accountId]);
  return rows.map((row) => ({
    account_id: row.account_id,
    callsign: row.callsign,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    x_handle: row.x_handle,
    source: row.source,
  }));
}

/**
 * `onboarding/complete` in the caller's transaction. An account that already
 * finished keeps its state. Otherwise the shown step runs first when it has
 * not (both markers checked, so it is a no-op after `shown`), then
 * `onboarded_at`, `privacy` and `sharing_since` (the transaction's time, or
 * null when private) are set.
 */
export async function completeOnboarding(
  social: Social,
  accountId: string,
  makePrivate: boolean,
  options: OnboardingRepositoryOptions = {},
): Promise<SocialOnboardingCompleteResponse> {
  const markers = await lockAccount(social, accountId);
  if (!markers.onboarded) {
    await applyShownStep(social, accountId, markers, options.createId ?? randomUUID);
    await social.write("social_accounts", COMPLETE, [accountId, makePrivate]);
  }
  const state = (await social.read<StateRow>(CURRENT_STATE, [accountId])).rows[0];
  if (!state) throw new Error("The onboarding account row is missing.");
  return {
    onboarding: { shown: true, completed: true },
    privacy: state.privacy,
    sharing_since_ms: state.sharing_since_ms === null ? null : Number(state.sharing_since_ms),
  };
}
