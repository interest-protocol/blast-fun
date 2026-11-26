import { tinyTradeSql } from "@blast/core/modules/social/read-model/trade-size.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { FeedItemBacker } from "@blast/core/modules/social/contracts/items.ts";
import { profilePagePath } from "@blast/core/modules/social/contracts/profiles.ts";
import { VIEWER_STATE_BACKER_FACES } from "@blast/core/modules/social/contracts/viewer-state.ts";
import { toUsd } from "@blast/core/modules/social/items/decimal.ts";
import {
  SHOWN_PRESALES,
  SHOWN_ACTIVITY,
  SHOWN_FEED_ENTRIES,
} from "@blast/core/modules/social/read-model/chain-presales.ts";
import { namedWalletsSql } from "@blast/core/modules/social/read-model/naming.ts";
const REACTIONS = `
  SELECT entry_id, array_agg(reaction ORDER BY reaction) AS reactions
  FROM social_reactions
  WHERE account_id = $1 AND entry_id = ANY($2::text[])
  GROUP BY entry_id`;

/** Followed accounts by their current callsign (a member's callsign is its profile's). */
const FOLLOWED_CALLSIGNS = `
  SELECT i.callsign
  FROM social_account_identities i
  JOIN social_follows f
    ON f.follower_account_id = $1 AND f.target_kind = 'account' AND f.target_id = i.account_id::text
  WHERE i.callsign = ANY($2::text[])`;

/**
 * Which of these accounts (by current callsign) follow the caller: one key lookup each.
 * Only public followers count: a private account's follows are never named, even to the
 * account it follows (the connections policy, `profiles/connections.ts`).
 */
export const FOLLOWERS_OF_CALLER = `
  SELECT c.callsign
  FROM social_account_callsigns c
  JOIN social_accounts a ON a.account_id = c.account_id AND a.privacy = 'public'
  JOIN social_follows f
    ON f.follower_account_id = c.account_id AND f.target_kind = 'account' AND f.target_id = $1::text
  WHERE c.callsign = ANY($2::text[]) AND c.account_id <> $1::uuid`;

const FOLLOWED_PRESALES = `
  SELECT target_id
  FROM social_follows
  WHERE follower_account_id = $1 AND target_kind = 'presale' AND target_id = ANY($2::text[])`;

/**
 * The named backers of each presale that the caller follows: the same rule
 * and order as a post's public backers (the items mapper), restricted to
 * followed accounts, with each presale's total and its largest few. The
 * presale ids come from the client, so a sale the web does not show (T-043's
 * hidden test sales) is dropped in the commits scan (inside the shared reader)
 * and answers no backers, like an unknown id.
 */
export const FOLLOWED_BACKERS_SQL = `
  SELECT backers.* FROM (
  WITH commits AS MATERIALIZED (
    SELECT e.presale_id, e.actor, e.usd_value, e.occurred_at_ms
    FROM ${SHOWN_FEED_ENTRIES} e
    WHERE e.source = 'activity' AND e.kind = 'presale_commit' AND e.presale_id = ANY($2::text[])
  ), named AS MATERIALIZED (
    ${namedWalletsSql(`named_account.account_id IN (
        SELECT f.target_id::uuid FROM social_follows f
        WHERE f.follower_account_id = $1 AND f.target_kind = 'account'
      )`)}
  )
  SELECT ranked.presale_id, ranked.rank, ranked.total::int AS total, ranked.usd::text AS usd,
    i.callsign, i.display_name, i.avatar_url, i.verified
  FROM (
    SELECT backed.*,
      row_number() OVER (PARTITION BY backed.presale_id ORDER BY backed.usd DESC NULLS LAST, backed.last_ms DESC, backed.account_id) AS rank,
      count(*) OVER (PARTITION BY backed.presale_id) AS total
    FROM (
      SELECT c.presale_id, n.account_id, sum(c.usd_value) AS usd, max(c.occurred_at_ms) AS last_ms
      FROM commits c
      JOIN named n ON n.address = c.actor AND n.named_from_ms <= c.occurred_at_ms
      GROUP BY c.presale_id, n.account_id
    ) backed
  ) ranked
  JOIN social_account_identities i ON i.account_id = ranked.account_id
  WHERE ranked.rank <= ${VIEWER_STATE_BACKER_FACES} AND i.callsign IS NOT NULL
  ) backers
  ORDER BY backers.presale_id, backers.rank`;

/** Followed buyers in the indexed last day; names obey the shared privacy and wallet-link rule. */
export const FOLLOWED_BUYERS_SQL = `
  SELECT buyers.* FROM (WITH clock AS (
    SELECT market_checkpoint AS checkpoint, least(market_timestamp_ms, $3::bigint) AS ms
    FROM chain_read_v1.watermark
  ), named AS MATERIALIZED (
    ${namedWalletsSql(`named_account.account_id IN (
      SELECT target_id::uuid FROM social_follows WHERE follower_account_id = $1 AND target_kind = 'account'
    )`)}
  ), bought AS (
    SELECT p.presale_id, n.account_id, max(a.timestamp_ms) AS last_ms, sum(a.usd_value) AS usd
    FROM ${SHOWN_PRESALES} p
    JOIN ${SHOWN_ACTIVITY} a ON a.coin_type = p.sale_token AND a.kind = 'trade_buy' AND NOT ${tinyTradeSql("a")}
    JOIN named n ON n.address = a.actor AND n.named_from_ms <= a.timestamp_ms
    CROSS JOIN clock
    WHERE p.presale_id = ANY($2::text[]) AND p.lifecycle = 'migrated'
      AND a.timestamp_ms > clock.ms - 86400000 AND a.timestamp_ms <= clock.ms
      AND a.checkpoint <= clock.checkpoint
    GROUP BY p.presale_id, n.account_id
  ), ranked AS (
    SELECT bought.*, row_number() OVER (PARTITION BY presale_id ORDER BY last_ms DESC, account_id) AS rank,
      count(*) OVER (PARTITION BY presale_id) AS total FROM bought
  )
  SELECT r.presale_id, r.total::int AS total, r.usd::text AS usd,
    i.callsign, i.display_name, i.avatar_url, i.verified
  FROM ranked r JOIN social_account_identities i ON i.account_id = r.account_id
  WHERE r.rank <= 3 AND i.callsign IS NOT NULL
  ORDER BY r.presale_id, r.rank) buyers`;

type FollowedBackerRow = {
  presale_id: string;
  total: number;
  usd: string | null;
  callsign: string;
  display_name: string | null;
  avatar_url: string | null;
  verified: boolean;
};

export async function readViewerState(
  social: ReadableDatabase,
  input: Readonly<{
    accountId: string;
    entryIds: string[];
    callsigns: string[];
    presaleIds: string[];
    backersOf: string[];
    buyersOf: string[];
    followsYouOf: string[];
    trading: boolean;
    nowMs: number;
  }>,
) {
  const { accountId, entryIds, callsigns, presaleIds, backersOf, buyersOf, followsYouOf } = input;
  const reactions = new Map<string, string[]>();
  if (entryIds.length > 0) {
    const rows = await social.read<{ entry_id: string; reactions: string[] }>(REACTIONS, [
      accountId,
      entryIds,
    ]);
    for (const row of rows.rows) reactions.set(row.entry_id, row.reactions);
  }
  const accounts = new Set<string>();
  if (callsigns.length > 0) {
    const rows = await social.read<{ callsign: string }>(FOLLOWED_CALLSIGNS, [
      accountId,
      callsigns,
    ]);
    for (const row of rows.rows) accounts.add(row.callsign);
  }
  const presales = new Set<string>();
  if (presaleIds.length > 0) {
    const rows = await social.read<{ target_id: string }>(FOLLOWED_PRESALES, [
      accountId,
      presaleIds,
    ]);
    for (const row of rows.rows) presales.add(row.target_id);
  }
  function backerMap(rows: readonly FollowedBackerRow[]) {
    const backers = new Map<string, { count: number; accounts: FeedItemBacker[] }>();
    for (const row of rows) {
      const entry = backers.get(row.presale_id) ?? {
        count: row.total,
        accounts: [],
      };
      entry.accounts.push({
        callsign: row.callsign,
        display_name: row.display_name,
        avatar_url: row.avatar_url,
        verified: row.verified === true,
        path: profilePagePath(row.callsign),
        usd: row.usd === null ? null : toUsd(row.usd),
      });
      backers.set(row.presale_id, entry);
    }
    return backers;
  }
  const backerRows =
    backersOf.length > 0
      ? (await social.read<FollowedBackerRow>(FOLLOWED_BACKERS_SQL, [accountId, backersOf])).rows
      : [];
  const backers = backerMap(backerRows);
  const buyerRows =
    buyersOf.length > 0 && input.trading
      ? (
          await social.read<FollowedBackerRow>(FOLLOWED_BUYERS_SQL, [
            accountId,
            buyersOf,
            input.nowMs,
          ])
        ).rows
      : [];
  const buyers = backerMap(buyerRows);
  const followers = new Set<string>();
  if (followsYouOf.length > 0) {
    const rows = await social.read<{ callsign: string }>(FOLLOWERS_OF_CALLER, [
      accountId,
      followsYouOf,
    ]);
    for (const row of rows.rows) followers.add(row.callsign);
  }
  return { reactions, accounts, presales, backers, buyers, followers };
}
