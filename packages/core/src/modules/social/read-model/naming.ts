
/**
 * The social feed's naming rule and the entry predicates built on it, as SQL
 * fragments over `social_feed_entries` (0055), `social_wallet_owners` and
 * `social_accounts` (0054). The rule is evaluated at read time and no table
 * stores its result, so going private, onboarding state and wallet link times
 * take effect on the next uncached read. Feeds and profiles use these
 * fragments (or the selections in `entries.ts`) and never re-derive privacy.
 *
 * For an item with actor wallet `W` and time `T`:
 *
 *   owner = social_wallet_owners[W]                       -- none → not named
 *   named = owner exists
 *       AND account.privacy = 'public'
 *       AND account.sharing_since IS NOT NULL
 *       AND account.sharing_since <= T
 *       AND owner.linked_at <= T
 *
 * Times compare exactly: `extract(epoch …)` is numeric, so a `sharing_since`
 * half a millisecond after `T` is after it.
 */

/**
 * The person kinds: a commit, a claim or a trade. A person entry appears in
 * feeds and profiles only when it is named. Other activity kinds (launchpad,
 * boosts, kinds blast-infra adds later) stay in `social_feed_entries`
 * unchanged but are not person entries.
 */
export const PERSON_ENTRY_KINDS = ["presale_commit", "presale_claim", "trade_buy", "trade_sell"] as const;
export type PersonEntryKind = (typeof PERSON_ENTRY_KINDS)[number];

/** The activity kinds a big-trade presale post may be. */
export const TRADE_ENTRY_KINDS = ["trade_buy", "trade_sell"] as const;

const ALIAS = /^[a-z_][a-z0-9_]*$/;
const PARAMETER = /^\$[1-9][0-9]*$/;

function alias(entry: string): string {
  if (!ALIAS.test(entry)) throw new Error(`Not a SQL alias: ${JSON.stringify(entry)}.`);
  return entry;
}

function parameter(placeholder: string): string {
  if (!PARAMETER.test(placeholder)) throw new Error(`Not a SQL parameter: ${JSON.stringify(placeholder)}.`);
  return placeholder;
}

function list(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

/**
 * A scalar subquery that yields the account naming the entry aliased `entry`
 * (a `social_feed_entries` row), or NULL when the rule does not hold. Entries
 * without an actor (lifecycle, milestone) are never named.
 * `social_wallet_owners` holds at most one owner per address.
 */
export function namedOwnerSql(entry: string): string {
  const e = alias(entry);
  return `(SELECT named_owner.account_id
    FROM social_wallet_owners named_owner
    JOIN social_accounts named_account ON named_account.account_id = named_owner.account_id
    WHERE named_owner.address = ${e}.actor
      AND named_account.privacy = 'public'
      AND named_account.sharing_since IS NOT NULL
      AND extract(epoch FROM named_account.sharing_since) * 1000 <= ${e}.occurred_at_ms
      AND extract(epoch FROM named_owner.linked_at) * 1000 <= ${e}.occurred_at_ms)`;
}

/**
 * The same rule split for batch readers (the notification generator): for a
 * wallet (an address expression such as `w.actor`), a subquery yielding its
 * owner `account_id` and `named_from_ms`, the first time the rule names it
 * (the later of the account's `sharing_since` and the wallet's link), or no
 * row when nothing can name it (no single owner, or a private or never
 * sharing account). An entry by that wallet at time `T` is named exactly when
 * `T >= named_from_ms`, as `namedOwnerSql` decides; resolving it once per
 * distinct wallet spares a batch one owner lookup per entry.
 */
export function walletNamingSql(address: string): string {
  if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(address)) throw new Error(`Not a SQL column: ${JSON.stringify(address)}.`);
  return `(SELECT wallet_owner.account_id,
      greatest(extract(epoch FROM wallet_account.sharing_since), extract(epoch FROM wallet_owner.linked_at)) * 1000 AS named_from_ms
    FROM social_wallet_owners wallet_owner
    JOIN social_accounts wallet_account ON wallet_account.account_id = wallet_owner.account_id
    WHERE wallet_owner.address = ${address}
      AND wallet_account.privacy = 'public'
      AND wallet_account.sharing_since IS NOT NULL)`;
}

/**
 * The naming rule as a set, for reads that name many entries of one kind at
 * once (a presale's backers): `(address, account_id, named_from_ms)` for every
 * wallet whose owner is public and sharing. An entry with actor `W` and time
 * `T` is named by the row with `address = W` when `named_from_ms <= T`, which
 * is `namedOwnerSql` with its two time conditions folded into one. Hash-join
 * it to the entries (as a MATERIALIZED CTE) rather than evaluating
 * `namedOwnerSql` per row; `filter`, when given, is a SQL condition on
 * `named_owner` or `named_account` that narrows the set (a viewer's follows,
 * or `namedWalletsOfSql`'s addresses).
 */
export function namedWalletsSql(filter?: string): string {
  return `SELECT named_owner.address, named_owner.account_id,
      greatest(extract(epoch FROM named_account.sharing_since), extract(epoch FROM named_owner.linked_at)) * 1000 AS named_from_ms
    FROM social_wallet_owners named_owner
    JOIN social_accounts named_account ON named_account.account_id = named_owner.account_id
    WHERE named_account.privacy = 'public' AND named_account.sharing_since IS NOT NULL${filter ? `
      AND ${filter}` : ""}`;
}

/**
 * `namedWalletsSql` for the wallets in `addresses` only (a `text[]`
 * expression, such as `ARRAY(SELECT DISTINCT c.actor FROM commits c)`). The
 * condition is on the column `social_wallet_owners` partitions by, so Postgres
 * pushes it into each of the view's sources (index lookups by address) and
 * ranks those wallets alone, where the unfiltered set ranks every linked
 * wallet on each call (10,000 at launch scale). The rows for those addresses
 * are exactly the unfiltered set's.
 */
export function namedWalletsOfSql(addresses: string): string {
  return namedWalletsSql(`named_owner.address = ANY(${addresses})`);
}

/** True when the entry aliased `entry` is a person entry (named or not). */
export function personEntrySql(entry: string): string {
  const e = alias(entry);
  return `(${e}.source = 'activity' AND ${e}.kind IN (${list(PERSON_ENTRY_KINDS)}))`;
}

/**
 * True when the entry aliased `entry` is a presale post: a lifecycle entry
 * other than creation, a milestone, a commit worth at least `bigCommitUsd` or a trade worth at
 * least `bigTradeUsd` (numeric parameters such as `$2`), of a presale. A
 * post's actor need not be named; an unnamed one shows its address only.
 */
export function presalePostSql(entry: string, bigCommitUsd: string, bigTradeUsd: string): string {
  const e = alias(entry);
  return `(${e}.presale_id IS NOT NULL AND (
      (${e}.source IN ('lifecycle', 'milestone') AND ${e}.kind <> 'presale_created')
      OR (${e}.source = 'activity' AND ${e}.kind = 'presale_commit' AND ${e}.usd_value >= ${parameter(bigCommitUsd)}::numeric)
      OR (${e}.source = 'activity' AND ${e}.kind IN (${list(TRADE_ENTRY_KINDS)}) AND ${e}.usd_value >= ${parameter(bigTradeUsd)}::numeric)
    ))`;
}

/** The naming and size rules for entries already read through SHOWN_FEED_ENTRIES or SHOWN_ACTIVITY. */
export function visibleEntrySql(entry: string, bigCommitUsd: string, bigTradeUsd: string): string {
  return `((${personEntrySql(entry)} AND ${namedOwnerSql(entry)} IS NOT NULL) OR ${presalePostSql(entry, bigCommitUsd, bigTradeUsd)})`;
}
