import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";

/**
 * Shared SQL for the presale pages' reads. Every statement reads chain facts
 * through blast-infra's `chain_read_v1` views only (`chainViewsOnly` refuses
 * anything else before it reaches the database) and social facts from the
 * social relations the replica may read.
 */

/** `database`, refusing any statement that names chain data other than the `chain_read_v1` views. */
export function chainViewsOnly(database: ReadableDatabase): ReadableDatabase {
  return {
    read: (text, values) => {
      assertChainReadThroughViews(text);
      return database.read(text, values);
    },
  };
}

/** Numbered parameters: `add(value)` appends it and answers its placeholder. */
export class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** Whether the presale's exact quote type is in the bound list of one-dollar quotes. */
export function quoteAtParSql(parQuotes: string): string {
  return `(p.quote_type = ANY(${parQuotes}::text[]))`;
}

/** USD per whole quote coin of the presale aliased `p` (needs the `qp` price join). */
export function quoteUsdSql(parQuotes: string): string {
  return `(CASE WHEN ${quoteAtParSql(parQuotes)} THEN 1::numeric ELSE qp.usd_price END)`;
}

/** Quote atoms `atoms` of the presale aliased `p` in USD to two places, as text (null without a price). */
export function usdSql(atoms: string, parQuotes: string): string {
  return `round(${atoms} / (10::numeric ^ p.quote_decimals) * ${quoteUsdSql(parQuotes)}, 2)::text`;
}

/**
 * The account naming a wallet's position in a presale, or NULL: the wallet's
 * owner (`social_wallet_owners`) is public and shared both the account and the
 * wallet link no later than the wallet's first commit to the sale
 * (`firstCommitMs`), so the position reveals nothing committed before
 * sharing began. This is the feed's naming rule (`read-model/naming.ts`)
 * applied to every commit in the position.
 */
export function namedPositionSql(wallet: string, firstCommitMs: string): string {
  return `(SELECT position_owner.account_id
    FROM social_wallet_owners position_owner
    JOIN social_accounts position_account ON position_account.account_id = position_owner.account_id
    WHERE position_owner.address = ${wallet}
      AND position_account.privacy = 'public'
      AND position_account.sharing_since IS NOT NULL
      AND extract(epoch FROM position_account.sharing_since) * 1000 <= ${firstCommitMs}
      AND extract(epoch FROM position_owner.linked_at) * 1000 <= ${firstCommitMs})`;
}

/** The first commit of `wallet` to `presale` (activity `(actor, timestamp_ms)` index). */
export function firstCommitSql(wallet: string, presale: string): string {
  return `(SELECT min(first_commit.timestamp_ms) FROM chain_read_v1.activity first_commit
    WHERE first_commit.actor = ${wallet} AND first_commit.presale_id = ${presale} AND first_commit.kind = 'presale_commit')`;
}

/** A person's public identity columns from `social_account_identities` aliased `i`. */
export const PERSON_COLUMNS = `i.callsign AS person_callsign, i.display_name AS person_display_name,
  i.avatar_url AS person_avatar_url, (i.x_handle IS NOT NULL) AS person_verified`;

/** `social_account_identities` aliased `i` for the account `account` (an index lookup per row, never a scan of the view). */
export function identityJoinSql(account: string): string {
  return `LEFT JOIN LATERAL (
    SELECT ii.callsign, ii.display_name, ii.avatar_url, ii.x_handle FROM social_account_identities ii WHERE ii.account_id = ${account}
  ) i ON TRUE`;
}

/**
 * The activity row of an activity feed entry id (`a:<checkpoint>:<tx_slot>:<event_slot>:<part>`), by the view's key.
 * Every part is read as `bigint`: blast-infra's slots are u32 and T-038's trade rows carry `event_slot`
 * 4294967295, past `integer` (0098 fixes 0066's trigger function the same way).
 */
export function activityOfEntrySql(entry: string): string {
  return `a.checkpoint = split_part(${entry}, ':', 2)::bigint AND a.tx_slot = split_part(${entry}, ':', 3)::bigint
      AND a.event_slot = split_part(${entry}, ':', 4)::bigint AND a.part = split_part(${entry}, ':', 5)::bigint`;
}

/**
 * `activityOfEntrySql` for any entry id `entry` (a why's may name a post that is no activity row): an id not of the
 * activity form matches no row and is never cast.
 */
export function activityOfAnyEntrySql(entry: string): string {
  return activityOfEntrySql(`(CASE WHEN ${entry} ~ '^a:[0-9]{1,18}:[0-9]{1,10}:[0-9]{1,10}:[0-9]{1,10}$' THEN ${entry} END)`);
}

/**
 * The author's latest active thesis on the sale `presale` (`social_whys_presale_active_idx`, 0066): a why on one
 * of its commits. Since 0098 a why on a trade of the sale's coin carries the sale too, so each candidate is checked
 * against its activity row (one probe of the view's key) and only a `presale_commit`'s why is a thesis, as on the
 * sale page (`detail.ts` `readTheses`).
 */
export function latestThesisSql(presale: string, account: string): string {
  return `(SELECT w.text FROM social_whys w
    WHERE w.presale_id = ${presale} AND w.state = 'active' AND w.presale_id IS NOT NULL AND w.author_account_id = ${account}
      AND EXISTS (SELECT 1 FROM chain_read_v1.activity a WHERE ${activityOfEntrySql("w.entry_id")} AND a.kind = 'presale_commit')
    ORDER BY w.created_at DESC LIMIT 1)`;
}

export type PersonColumns = Readonly<{
  person_callsign: string | null;
  person_display_name: string | null;
  person_avatar_url: string | null;
  person_verified: boolean | null;
}>;

export function personOf(row: PersonColumns) {
  if (!row.person_callsign) return null;
  return {
    callsign: row.person_callsign,
    display_name: row.person_display_name,
    avatar_url: row.person_avatar_url,
    verified: row.person_verified === true,
  };
}

/**
 * The addresses of `accounts` (a uuid[] parameter) as `social_wallet_owners`
 * lists them, without computing that view for every wallet: candidates from
 * each source by the accounts' keys, kept only when no other account reaches
 * the address (each checked by address), with the earliest link timestamp.
 * The same rule as the public portfolio's `ADDRESSES_OF_ACCOUNT`, for many accounts.
 */
export function addressesOfAccountsSql(accounts: string): string {
  return `SELECT mine.account_id, mine.address, min(mine.linked_at) AS linked_at
  FROM (
    SELECT a.account_id, w.sui_address AS address, w.verified_at AS linked_at
    FROM social_accounts a JOIN mission_control_account_wallets w ON w.profile_id = a.profile_id
    WHERE a.account_id = ANY(${accounts})
    UNION ALL
    SELECT a.account_id, e.address, e.resolved_at
    FROM social_accounts a JOIN presale_embedded_wallets e ON e.privy_did = a.privy_did
    WHERE a.account_id = ANY(${accounts})
    UNION ALL
    SELECT a.account_id, e.address, e.resolved_at
    FROM social_accounts a
    JOIN mission_control_account_identities mi ON mi.profile_id = a.profile_id AND mi.provider = 'privy'
    JOIN presale_embedded_wallets e ON e.privy_did = mi.provider_subject
    WHERE a.account_id = ANY(${accounts})
    UNION ALL
    SELECT s.account_id, s.address, s.verified_at FROM social_account_wallets s WHERE s.account_id = ANY(${accounts})
  ) AS mine
  WHERE NOT EXISTS (
    SELECT 1 FROM mission_control_account_wallets w JOIN social_accounts o ON o.profile_id = w.profile_id
    WHERE w.sui_address = mine.address AND o.account_id <> mine.account_id
    UNION ALL
    SELECT 1 FROM presale_embedded_wallets e JOIN social_accounts o ON o.privy_did = e.privy_did
    WHERE e.address = mine.address AND o.account_id <> mine.account_id
    UNION ALL
    SELECT 1
    FROM presale_embedded_wallets e
    JOIN mission_control_account_identities mi ON mi.provider = 'privy' AND mi.provider_subject = e.privy_did
    JOIN social_accounts o ON o.profile_id = mi.profile_id
    WHERE e.address = mine.address AND o.account_id <> mine.account_id
    UNION ALL
    SELECT 1 FROM social_account_wallets s WHERE s.address = mine.address AND s.account_id <> mine.account_id
  )
  GROUP BY mine.account_id, mine.address`;
}
