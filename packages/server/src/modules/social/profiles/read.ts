import type { ModuleTransaction, ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { SocialConfig } from "@blast/core/modules/social/contracts/config.ts";
import type { AsOf } from "@blast/core/modules/social/contracts/items.ts";
import type { SocialProfile, SocialProfileItemsPage } from "@blast/core/modules/social/contracts/profiles.ts";
import { nextItemCursor, readAsOf, toItems } from "@blast/server/modules/social/items/index.ts";
import { personEntriesOf, type EntryCursor } from "@blast/server/modules/social/read-model/index.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";

/**
 * The reads behind a public profile, shared by its two routes and the
 * server-rendered `/crew/<callsign>` page so all three answer the same. Every
 * read takes one database (the replica in production) and touches public
 * relations only: `social_account_callsigns` and `social_account_identities`
 * for the identity, `social_accounts` for the bio and visibility flags, and
 * the read model's person selection for the items. No portfolio relation is read.
 */

type ProfileRow = Readonly<{
  account_id: string;
  callsign: string;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  x_handle: string | null;
  verified: boolean;
  private: boolean;
  portfolio_public: boolean;
}>;

/**
 * The account holding `callsign` (a member's profile callsign or a new
 * account's own). The callsign is resolved through `social_account_callsigns`
 * (0059: a unique-index lookup per branch), then the identity by account id,
 * so no branch computes every account's callsign (UI-07's flag on T-018).
 */
const PROFILE_SQL = `SELECT i.account_id::text AS account_id, i.callsign, i.display_name, a.bio, i.avatar_url, i.x_handle,
    i.verified, a.privacy = 'private' AS private, a.portfolio_public AND a.privacy = 'public' AS portfolio_public
  FROM social_account_callsigns c
  JOIN social_accounts a ON a.account_id = c.account_id
  JOIN social_account_identities i ON i.account_id = c.account_id
  WHERE c.callsign = $1`;

async function profileRow(db: ReadableDatabase, callsign: string): Promise<ProfileRow | null> {
  return (await db.read<ProfileRow>(PROFILE_SQL, [callsign])).rows[0] ?? null;
}

/**
 * A Mission Control member holding `callsign` who never opened Blast has no
 * account row yet (T-015's release backfill covers members who joined before
 * the release; this covers the ones after). Creates it exactly as `GET /me`
 * would (`onboarded_at` null, public, not sharing: it names nothing) with
 * `ON CONFLICT DO NOTHING`, so concurrent first reads create one row. Answers
 * whether a member holds the callsign. Runs on the primary (`social` module).
 */
const ENSURE_MEMBER_ACCOUNT = `
  INSERT INTO social_accounts (account_id, profile_id)
  SELECT gen_random_uuid(), p.profile_id FROM mission_control_profiles p WHERE p.callsign = $1
  ON CONFLICT DO NOTHING`;

export async function ensureMemberAccount(social: ModuleTransaction<"social">, callsign: string): Promise<void> {
  await social.write("social_accounts", ENSURE_MEMBER_ACCOUNT, [callsign]);
}

/** Check the primary before opening a write transaction for a replica miss. */
export async function memberProfileExists(db: ReadableDatabase, callsign: string): Promise<boolean> {
  const result = await db.read<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM mission_control_profiles WHERE callsign = $1) AS exists`,
    [callsign],
  );
  return result.rows[0]?.exists === true;
}

/** The account at `callsign` and whether it is private, or null. */
export async function readProfileAccount(
  db: ReadableDatabase,
  callsign: string,
): Promise<Readonly<{ accountId: string; private: boolean }> | null> {
  const row = await profileRow(db, callsign);
  return row ? { accountId: row.account_id, private: row.private } : null;
}

/** A readable watermark, or `service_unavailable`: without it the data's freshness is unknown. */
function asOfOrUnavailable(asOf: AsOf | null): AsOf {
  if (!asOf) throw new SocialRouteError("service_unavailable");
  return asOf;
}

/**
 * The public identity at `callsign`, or null when no Blast Account holds it.
 * `private` is the account's own setting; whether an item names the account
 * stays the read model's decision.
 */
export async function readProfile(db: ReadableDatabase, callsign: string, includeBio = false): Promise<SocialProfile | null> {
  const [row, asOf] = await Promise.all([profileRow(db, callsign), readAsOf(db)]);
  if (!row) return null;
  return {
    callsign: row.callsign,
    display_name: row.display_name,
    ...(includeBio && row.bio !== null ? { bio: row.bio } : {}),
    avatar_url: row.avatar_url,
    x_handle: row.x_handle,
    verified: row.verified === true,
    private: row.private,
    portfolio_public: row.portfolio_public === true,
    as_of: asOfOrUnavailable(asOf),
  };
}

/**
 * One page of the named items of the account at `callsign` (null when no
 * account holds it). The items are the read model's person selection for
 * that account (`personEntriesOf`): only entries the naming rule attributes
 * to it now, so a private account, an account not sharing yet and an item
 * from before sharing began give nothing. Mapped by the item mapper; the
 * cursor follows the selection.
 */
export async function readProfileItemsPage(
  db: ReadableDatabase,
  callsign: string,
  request: Readonly<{ config: SocialConfig; nowMs: number; limit: number; before: EntryCursor | null }>,
): Promise<SocialProfileItemsPage | null> {
  const { config, nowMs, limit, before } = request;
  const [row, asOf] = await Promise.all([profileRow(db, callsign), readAsOf(db)]);
  if (!row) return null;
  const entries = await personEntriesOf(db, [row.account_id], { limit, before });
  return {
    items: await toItems(db, entries, { nowMs, config }),
    next_cursor: nextItemCursor(entries, limit),
    as_of: asOfOrUnavailable(asOf),
  };
}
