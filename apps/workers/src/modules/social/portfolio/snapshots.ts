import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { addressesOfAccountsSql } from "@blast/core/modules/social/presales/sql.ts";
import { SHOWN_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { readStepCursor, writeStepCursor, type SocialAlertDetails, type SocialWorkerReadSnapshot, type SocialWorkerStep, type SocialWorkerStepCommit } from "../worker/steps.ts";
import { PORTFOLIO_FULLNODE_TIMEOUT_MS, observeWalletBalances, type PortfolioBalanceObservation, type PortfolioFullnode } from "./balances.ts";
import { PORTFOLIO_COIN_TYPES, positionStatus } from "@blast/core/modules/social/portfolio/read.ts";
import { valuePortfolio, type SnapshotCoin, type SnapshotPosition, type SnapshotPrice, type SnapshotValue } from "./snapshot-value.ts";

/**
 * OA-25 Q16: the daily portfolio-value snapshot behind the gold card's 30-day
 * trend (R3-08), one social worker step, `portfolio-snapshot`, writing
 * `social_portfolio_snapshots` (0097). The owner's rule: the slot stays empty
 * until a month of snapshots exists (`trend.ts`), and the line is never
 * today's holdings at old prices.
 *
 * **What a day's value is.** The gold card's five parts, as the portfolio
 * reads them, for the account's wallets (`social_wallet_owners`, by the
 * batch rule `addressesOfAccountsSql`):
 *
 * - Committed and Claimable: the account's presale positions
 *   (`chain_read_v1.presale_positions`, summed per sale over its wallets,
 *   shown sales only): open/closed commitments at their quote price, and
 *   remaining claim tokens and refunds at their respective prices;
 * - Tokens: the sale coins its wallets hold (`chain_read_v1.coin_balances`)
 *   at each coin's price;
 * - USDC and SUI: the wallets' balances from the fullnode, exactly as
 *   `/me/portfolio` reads them (`readWalletBalances`, about two calls per
 *   wallet per day). `chain_read_v1` holds sale-coin balances only, and
 *   without the cash the series would not be the card's value: a sale for
 *   USDC would look like a loss. This one chain read outside `chain_read_v1`
 *   is the owner's decision (2026-10-06, approved as built).
 *
 * Prices are `chain_read_v1.prices` rows read in the same transaction as the
 * holdings, at most `PORTFOLIO_SNAPSHOT_PRICE_MAX_AGE_MS` older than the
 * chain clock the holdings were read at; USDC (cash, and a USDC sale's
 * commitments) counts at face value, as the card and the sale pages count it.
 * The arithmetic is exact and lives in `snapshot-value.ts`.
 *
 * **Never invented.** A held amount without a fresh price, or wallets the
 * fullnode did not answer for, make the day a skipped row
 * (`price_missing`, `balances_unavailable`) with no figures. Skipped rows
 * are retried every `PORTFOLIO_SNAPSHOT_RETRY_EVERY_MS` until the UTC day
 * ends; a valued row is final (0097's trigger). A day the job never reached
 * has no row: holdings are only ever read as they are now, so a missed day
 * is never backfilled.
 *
 * **When.** The day is the UTC day of the chain clock: the slower of the two
 * pipelines' watermark times (`chain_read_v1.watermark`). The step waits
 * while either pipeline is more than `PORTFOLIO_SNAPSHOT_MAX_LAG_MS` behind
 * the process clock, so the indexer's holdings and the fullnode's cash
 * stay within the accepted freshness bound. Cash observations retain their
 * own source and observation time (0108), rather than claiming historical
 * checkpoint balances. The first pass of a new UTC day starts the
 * day's sweep: keyset pages of `batchSize` accounts in primary-key order
 * (`after`, the cursor), each account with a wallet valued once per day
 * (`(account_id, day)` is the key, `ON CONFLICT` never writes a valued day
 * twice). When the sweep has passed every account, the skipped rows of the
 * day are retried in the same keyset way. A sweep that has not finished
 * `PORTFOLIO_SNAPSHOT_LATE_AFTER_MS` into the UTC day raises
 * `step_late:portfolio-snapshot` (`health`).
 *
 * **Cost.** Per pass: one page of the accounts' key, the batch's addresses
 * (index lookups), one statement each for its positions (blast-infra's
 * `presale_wallets_address`), its sale coins (`sale_coin_balances_owner`) and
 * their prices (the prices' key), two fullnode reads per wallet (at most
 * `PORTFOLIO_SNAPSHOT_FULLNODE_CONCURRENCY` accounts at a time, all inside
 * `PORTFOLIO_SNAPSHOT_FULLNODE_BUDGET_MS`) after releasing the primary
 * connection. A short final transaction rechecks the lease, selected cut,
 * cursor, chain day and mutable owner/privacy inputs before one upsert,
 * exact source-observation writes, cursor write and one retention
 * delete by the key. At the default 100 accounts a pass, 10,000 accounts are
 * a day's sweep of 100 passes (about ten minutes at one pass every five
 * seconds) and 100,000 accounts a thousand.
 */

export const PORTFOLIO_SNAPSHOT_STEP = "portfolio-snapshot";
/** The step waits while a pipeline's watermark is further than this behind the process clock. */
export const PORTFOLIO_SNAPSHOT_MAX_LAG_MS = 5 * 60_000;
/** Skipped rows are retried at most this often during their day. */
export const PORTFOLIO_SNAPSHOT_RETRY_EVERY_MS = 15 * 60_000;
/** A day's sweep not finished this long after 00:00 UTC raises `step_late:portfolio-snapshot`. */
export const PORTFOLIO_SNAPSHOT_LATE_AFTER_MS = 3 * 60 * 60_000;
/** Accounts whose fullnode balances are read at once. */
export const PORTFOLIO_SNAPSHOT_FULLNODE_CONCURRENCY = 16;
/** All provider reads complete within this budget, with no primary transaction held. */
export const PORTFOLIO_SNAPSHOT_FULLNODE_BUDGET_MS = 8_000;

const DAY_MS = 86_400_000;
const NO_ACCOUNT = "00000000-0000-0000-0000-000000000000";

/** The UTC day of `ms`, `YYYY-MM-DD`. */
export function utcDay(ms: number): string {
  return new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

/** 00:00 UTC of `day` (`YYYY-MM-DD`), in ms. */
export function utcDayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}


/** Both pipelines' watermarks: the chain clock is the slower one's. */
const WATERMARK_SQL = `SELECT market_checkpoint::text AS market_checkpoint, market_timestamp_ms::text AS market_timestamp_ms,
    presale_checkpoint::text AS presale_checkpoint, presale_timestamp_ms::text AS presale_timestamp_ms
  FROM chain_read_v1.watermark`;

/**
 * The sweep's next page: accounts after `$1` by the primary key, each with
 * whether day `$3` already has its row — one probe of 0097's key per account
 * of the page (the `LIMIT 1` keeps the probe per row, never a scan of the
 * day's rows).
 */
const PAGE_SQL = `SELECT p.account_id::text AS account_id, d.done IS NOT NULL AS done
  FROM (SELECT a.account_id FROM social_accounts a WHERE a.account_id > $1::uuid ORDER BY a.account_id LIMIT $2) p
  LEFT JOIN LATERAL (
    SELECT true AS done FROM social_portfolio_snapshots s WHERE s.account_id = p.account_id AND s.day = $3::date LIMIT 1
  ) d ON true
  ORDER BY p.account_id`;

/** The retry's next page: day `$1`'s skipped rows after account `$2` (the partial index). */
const RETRY_PAGE_SQL = `SELECT s.account_id::text AS account_id FROM social_portfolio_snapshots s
  WHERE s.day = $1::date AND s.skipped IS NOT NULL AND s.account_id > $2::uuid
  ORDER BY s.account_id
  LIMIT $3`;

/** The accounts' wallets, as `social_wallet_owners` lists them, by index lookups. */
const ADDRESSES_SQL = `SELECT o.account_id::text AS account_id, o.address FROM (${addressesOfAccountsSql("$1::uuid[]")}) o ORDER BY o.account_id, o.address`;

/** Each account's positions per shown sale, over its wallets (blast-infra's wallet index). */
const POSITIONS_SQL = `SELECT o.account_id::text AS account_id, pp.presale_id, sum(pp.commitment)::text AS commitment,
    bool_and(pp.claim_digest IS NOT NULL) AS all_claimed, p.lifecycle, p.start_ms::text AS start_ms, p.end_ms::text AS end_ms,
    p.quote_type, p.quote_decimals::int AS quote_decimals, p.sale_token, p.sale_decimals::int AS sale_decimals,
    CASE WHEN bool_and(to_jsonb(pp)->>'claimable_tokens' IS NOT NULL)
      THEN sum((to_jsonb(pp)->>'claimable_tokens')::numeric)::text END AS claimable_tokens,
    CASE WHEN bool_and(to_jsonb(pp)->>'claimable_quote_refund' IS NOT NULL)
      THEN sum((to_jsonb(pp)->>'claimable_quote_refund')::numeric)::text END AS claimable_quote_refund
  FROM unnest($1::uuid[], $2::text[]) AS o(account_id, address)
  JOIN chain_read_v1.presale_positions pp ON pp.wallet = o.address
  JOIN ${SHOWN_PRESALES} p ON p.presale_id = pp.presale_id
  GROUP BY o.account_id, pp.presale_id, p.lifecycle, p.start_ms, p.end_ms, p.quote_type, p.quote_decimals, p.sale_token, p.sale_decimals`;

/** Every non-cash coin counts, even when its metadata or price is unknown. */
const COINS_SQL = `SELECT o.account_id::text AS account_id, cb.coin_type, coalesce(m.decimals,p.sale_decimals)::int AS decimals,
    sum(cb.balance)::text AS balance
  FROM unnest($1::uuid[], $2::text[]) AS o(account_id, address)
  JOIN chain_read_v1.wallet_balances cb ON cb.owner = o.address AND cb.balance > 0
  LEFT JOIN chain_read_v1.coin_metadata m USING (coin_type)
  LEFT JOIN LATERAL (SELECT sale_decimals FROM ${SHOWN_PRESALES} p WHERE p.sale_token = cb.coin_type LIMIT 1) p ON TRUE
  WHERE cb.coin_type NOT IN ('${PORTFOLIO_COIN_TYPES.sui}', '${PORTFOLIO_COIN_TYPES.usdc}')
  GROUP BY o.account_id, cb.coin_type, m.decimals, p.sale_decimals`;

/** The prices of the coins the batch needs, by the prices' key. */
const PRICES_SQL = `SELECT coin_type, usd_price::text AS usd_price, as_of_ms::text AS as_of_ms
  FROM chain_read_v1.prices
  WHERE coin_type = ANY($1::text[])`;

for (const statement of [WATERMARK_SQL, POSITIONS_SQL, COINS_SQL, PRICES_SQL]) assertChainReadThroughViews(statement);

/**
 * The day's rows: a new account-day is inserted, a skipped one replaced by
 * the new attempt, a valued one never touched (`WHERE`, and 0097's trigger).
 * Returns one row per row written.
 */
const UPSERT_SQL = `INSERT INTO social_portfolio_snapshots (account_id, day, value_usd, committed_usd, claimable_usd, tokens_usd,
    usdc_usd, sui_usd, skipped, taken_at_ms, checkpoint, prices_as_of_ms)
  SELECT r.account_id, $1::date, r.value_usd, r.committed_usd, r.claimable_usd, r.tokens_usd, r.usdc_usd, r.sui_usd, r.skipped,
    $2::bigint, $3::bigint, r.prices_as_of_ms
  FROM unnest($4::uuid[], $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[], $9::numeric[], $10::numeric[], $11::text[], $12::bigint[])
    AS r(account_id, value_usd, committed_usd, claimable_usd, tokens_usd, usdc_usd, sui_usd, skipped, prices_as_of_ms)
  ON CONFLICT (account_id, day) DO UPDATE SET value_usd = EXCLUDED.value_usd, committed_usd = EXCLUDED.committed_usd,
    claimable_usd = EXCLUDED.claimable_usd, tokens_usd = EXCLUDED.tokens_usd, usdc_usd = EXCLUDED.usdc_usd,
    sui_usd = EXCLUDED.sui_usd, skipped = EXCLUDED.skipped, taken_at_ms = EXCLUDED.taken_at_ms,
    checkpoint = EXCLUDED.checkpoint, prices_as_of_ms = EXCLUDED.prices_as_of_ms
    WHERE social_portfolio_snapshots.skipped IS NOT NULL
  RETURNING account_id::text, skipped`;

/** Retention: the accounts' rows before day `$2`, a range of the key per account. */
const RETENTION_SQL = `DELETE FROM social_portfolio_snapshots WHERE account_id = ANY($1::uuid[]) AND day < $2::date`;

/** The step's statements, for EXPLAIN checks and the scale record. */
export const PORTFOLIO_SNAPSHOT_STATEMENTS = Object.freeze({
  watermark: WATERMARK_SQL,
  page: PAGE_SQL,
  retryPage: RETRY_PAGE_SQL,
  addresses: ADDRESSES_SQL,
  positions: POSITIONS_SQL,
  coins: COINS_SQL,
  prices: PRICES_SQL,
  upsert: UPSERT_SQL,
  retention: RETENTION_SQL,
});

type Holdings = Readonly<{ positions: SnapshotPosition[]; coins: SnapshotCoin[] }>;

/**
 * The batch's wallets, holdings and prices from the database, in the step's
 * transaction (so at one snapshot of the views). Accounts without a wallet
 * are absent from `wallets`.
 */
async function readBatch(
  db: ReadableDatabase,
  accounts: readonly string[],
  takenAtMs: number,
): Promise<Readonly<{ wallets: Map<string, string[]>; holdings: Map<string, Holdings>; prices: Map<string, SnapshotPrice>; ready: Set<string> }>> {
  const wallets = new Map<string, string[]>();
  const { rows: owned } = await db.read<{ account_id: string; address: string }>(ADDRESSES_SQL, [[...accounts]]);
  for (const row of owned) wallets.set(row.account_id, [...(wallets.get(row.account_id) ?? []), row.address]);
  const pairs = [...wallets].flatMap(([account, addresses]) => addresses.map((address) => [account, address] as const));
  const holdings = new Map<string, Holdings>();
  const ready = new Set<string>();
  const of = (account: string) => {
    let entry = holdings.get(account);
    if (!entry) holdings.set(account, (entry = { positions: [], coins: [] }));
    return entry;
  };
  const coinTypes = new Set<string>([PORTFOLIO_COIN_TYPES.sui, PORTFOLIO_COIN_TYPES.usdc]);
  if (pairs.length > 0) {
    const values = [pairs.map(([account]) => account), pairs.map(([, address]) => address)];
    const { rows: synced } = await db.read<{ account_id: string }>(`SELECT o.account_id::text
      FROM unnest($1::uuid[], $2::text[]) AS o(account_id, address)
      LEFT JOIN chain_read_v1.wallet_sync s ON s.owner = o.address
      GROUP BY o.account_id HAVING bool_and(coalesce(s.status = 'ready', false))`, values);
    for (const row of synced) ready.add(row.account_id);
    const { rows: positions } = await db.read<{
      account_id: string;
      commitment: string;
      all_claimed: boolean;
      lifecycle: string;
      start_ms: string;
      end_ms: string;
      quote_type: string;
      quote_decimals: number;
      sale_token: string;
      sale_decimals: number;
      claimable_tokens: string | null;
      claimable_quote_refund: string | null;
    }>(POSITIONS_SQL, values);
    const { rows: coins } = await db.read<{ account_id: string; coin_type: string; decimals: number | null; balance: string }>(COINS_SQL, values);
    for (const row of positions) {
      const status = positionStatus(
        { lifecycle: row.lifecycle, start_ms: Number(row.start_ms), end_ms: Number(row.end_ms), claimed: row.all_claimed },
        takenAtMs,
      );
      of(row.account_id).positions.push({
        commitment: row.commitment, status, quote_type: row.quote_type, quote_decimals: row.quote_decimals,
        claimable: { tokens: row.claimable_tokens, quote_refund: row.claimable_quote_refund, sale_type: row.sale_token, sale_decimals: row.sale_decimals },
      });
      if (status === "claimable") coinTypes.add(row.sale_token);
      coinTypes.add(row.quote_type);
    }
    for (const row of coins) {
      of(row.account_id).coins.push({ coin_type: row.coin_type, decimals: row.decimals, balance: row.balance });
      coinTypes.add(row.coin_type);
    }
  }
  const prices = new Map<string, SnapshotPrice>();
  const { rows: priced } = await db.read<{ coin_type: string; usd_price: string; as_of_ms: string }>(PRICES_SQL, [[...coinTypes]]);
  for (const row of priced) prices.set(row.coin_type, { usd_price: row.usd_price, as_of_ms: Number(row.as_of_ms) });
  return { wallets, holdings, prices, ready };
}

/**
 * Each account's SUI and USDC from the fullnode (`readWalletBalances`, the
 * portfolio's own read), at most `concurrency` accounts at a time and all
 * within `budgetMs`; null for an account whose read failed or did not start
 * in time.
 */
export async function readBatchCash(
  fullnode: PortfolioFullnode,
  wallets: ReadonlyMap<string, readonly string[]>,
  options: Readonly<{ concurrency?: number; budgetMs?: number; now?: () => number }> = {},
): Promise<Map<string, PortfolioBalanceObservation | null>> {
  const deadline = performance.now() + (options.budgetMs ?? PORTFOLIO_SNAPSHOT_FULLNODE_BUDGET_MS);
  const queue = [...wallets];
  const cash = new Map<string, PortfolioBalanceObservation | null>();
  const lane = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [account, addresses] = next;
      const left = Math.min(PORTFOLIO_FULLNODE_TIMEOUT_MS, Math.floor(deadline - performance.now()));
      if (left <= 0) {
        cash.set(account, null);
        continue;
      }
      try {
        cash.set(account, await observeWalletBalances(fullnode, addresses, left, options.now));
      } catch {
        cash.set(account, null);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? PORTFOLIO_SNAPSHOT_FULLNODE_CONCURRENCY, queue.length) }, lane));
  return cash;
}


/** The step's cursor (`social_worker_state`, name `portfolio-snapshot`). */
export type PortfolioSnapshotCursor = Readonly<{
  /** The UTC day being snapshotted. */
  day: string;
  /** The sweep's keyset position: the last account of the last page; null at the day's start. */
  after: string | null;
  /** The chain time the sweep passed the last account; null while it runs. */
  swept_ms: number | null;
  /** The retry round's keyset position over the day's skipped rows. */
  retry_after: string | null;
  /** The earliest chain time of the next retry round. */
  retry_at_ms: number | null;
}>;

export type PortfolioSnapshotConfig = Readonly<{
  /** Accounts per pass (`SOCIAL_PORTFOLIO_SNAPSHOT_BATCH`). */
  batchSize: number;
  /** Rows older than this many days are deleted (`SOCIAL_PORTFOLIO_SNAPSHOT_RETENTION_DAYS`). */
  retentionDays: number;
  /** The mainnet fullnode the cash is read from (`SuiGrpcClient.core`); resolved per pass. */
  fullnode: () => PortfolioFullnode;
  fullnodeConcurrency?: number;
  fullnodeBudgetMs?: number;
}>;

type WatermarkRow = {
  market_checkpoint: string | null;
  market_timestamp_ms: string | null;
  presale_checkpoint: string | null;
  presale_timestamp_ms: string | null;
};

/** The chain clock (the slower pipeline's time) and its checkpoint, or null while a pipeline has none. */
async function chainClock(db: ReadableDatabase): Promise<Readonly<{ ms: number; checkpoint: number }> | null> {
  const row = (await db.read<WatermarkRow>(WATERMARK_SQL)).rows[0];
  if (!row || row.market_timestamp_ms === null || row.presale_timestamp_ms === null || row.market_checkpoint === null || row.presale_checkpoint === null) {
    return null;
  }
  return {
    ms: Math.min(Number(row.market_timestamp_ms), Number(row.presale_timestamp_ms)),
    checkpoint: Math.min(Number(row.market_checkpoint), Number(row.presale_checkpoint)),
  };
}

/** Mutable privacy/account and owner evidence is compared again after the provider phase. */
const DEPENDENCIES_SQL = `SELECT a.account_id::text, to_jsonb(a) AS account,
    (SELECT to_jsonb(p) FROM social_notification_preferences p WHERE p.account_id = a.account_id) AS preferences
  FROM social_accounts a WHERE a.account_id = ANY($1::uuid[]) ORDER BY a.account_id`;

const BALANCE_OBSERVATION_SQL = `INSERT INTO social_portfolio_balance_observations
    (account_id, day, source, observed_at_ms, sui_atoms, usdc_atoms)
  VALUES ($1::uuid, $2::date, $3, $4::bigint, $5::numeric, $6::numeric)
  ON CONFLICT (account_id, day) DO UPDATE SET source = EXCLUDED.source, observed_at_ms = EXCLUDED.observed_at_ms,
    sui_atoms = EXCLUDED.sui_atoms, usdc_atoms = EXCLUDED.usdc_atoms`;

async function accountDependencies(db: ReadableDatabase, accounts: readonly string[]): Promise<string> {
  const accountsAnswer = await db.read(DEPENDENCIES_SQL, [[...accounts]]);
  const walletsAnswer = await db.read(ADDRESSES_SQL, [[...accounts]]);
  return JSON.stringify([accountsAnswer.rows, walletsAnswer.rows]);
}

/** Read one bounded page and immutable valuation inputs, release the connection, then observe current cash. */
async function prepareSnapshot(
  readSnapshot: SocialWorkerReadSnapshot,
  context: Readonly<{ now: () => number }>,
  config: PortfolioSnapshotConfig,
): Promise<SocialWorkerStepCommit> {
  const candidate = await readSnapshot(async (tx) => {
    const clock = await chainClock(tx);
    if (!clock || context.now() - clock.ms > PORTFOLIO_SNAPSHOT_MAX_LAG_MS) return null;
    const day = utcDay(clock.ms);
    const stored = await readStepCursor<PortfolioSnapshotCursor>(tx, PORTFOLIO_SNAPSHOT_STEP);
    if (stored && stored.day > day) return null;
    let cursor: PortfolioSnapshotCursor = stored && stored.day === day ? stored
      : { day, after: null, swept_ms: null, retry_after: null, retry_at_ms: null };
    let accounts: string[];
    let retention = false;
    if (cursor.swept_ms === null) {
      const { rows: page } = await tx.read<{ account_id: string; done: boolean }>(PAGE_SQL, [cursor.after ?? NO_ACCOUNT, config.batchSize, day]);
      accounts = page.filter((row) => !row.done).map((row) => row.account_id);
      retention = accounts.length > 0;
      cursor = page.length === 0
        ? { ...cursor, swept_ms: clock.ms, retry_after: null, retry_at_ms: clock.ms + PORTFOLIO_SNAPSHOT_RETRY_EVERY_MS }
        : { ...cursor, after: page[page.length - 1]!.account_id };
    } else if (cursor.retry_at_ms !== null && clock.ms >= cursor.retry_at_ms) {
      const { rows: page } = await tx.read<{ account_id: string }>(RETRY_PAGE_SQL, [day, cursor.retry_after ?? NO_ACCOUNT, config.batchSize]);
      accounts = page.map((row) => row.account_id);
      cursor = page.length === 0
        ? { ...cursor, retry_after: null, retry_at_ms: clock.ms + PORTFOLIO_SNAPSHOT_RETRY_EVERY_MS }
        : { ...cursor, retry_after: page[page.length - 1]!.account_id };
    } else return null;
    const batch = await readBatch(tx, accounts, clock.ms);
    const dependencies = await accountDependencies(tx, accounts);
    return { clock, day, stored, cursor, accounts, retention, batch, dependencies };
  });
  if (candidate === null) return async () => ({});
  const cash = await readBatchCash(config.fullnode(), candidate.batch.wallets, {
    concurrency: config.fullnodeConcurrency, budgetMs: config.fullnodeBudgetMs, now: context.now,
  });
  const rows = [...candidate.batch.wallets.keys()].map((account) => ({
    account,
    observation: cash.get(account) ?? null,
    value: valuePortfolio({
      positions: candidate.batch.holdings.get(account)?.positions ?? [],
      coins: candidate.batch.holdings.get(account)?.coins ?? [],
      cash: candidate.batch.ready.has(account) ? cash.get(account)?.balances ?? null : null,
      prices: candidate.batch.prices,
      takenAtMs: candidate.clock.ms,
    }),
  }));
  return async (tx) => {
    const current = await readStepCursor<PortfolioSnapshotCursor>(tx, PORTFOLIO_SNAPSHOT_STEP);
    // Freeze all canonical owner/privacy sources for the short final commit.
    // The helper grants locking without granting account mutation privileges.
    await tx.read("SELECT public.social_lock_portfolio_sources()");
    const currentClock = await chainClock(tx);
    if (JSON.stringify(current) !== JSON.stringify(candidate.stored)
      || await accountDependencies(tx, candidate.accounts) !== candidate.dependencies
      || context.now() - candidate.clock.ms > PORTFOLIO_SNAPSHOT_MAX_LAG_MS
      || currentClock === null || utcDay(currentClock.ms) !== candidate.day) return {};
    const valued = (pick: (value: Extract<SnapshotValue, { kind: "valued" }>) => string | number | null) =>
      rows.map(({ value }) => value.kind === "valued" ? pick(value) : null);
    const { rows: written } = await tx.write<{ account_id: string; skipped: string | null }>("social_portfolio_snapshots", UPSERT_SQL, [
      candidate.day, candidate.clock.ms, candidate.clock.checkpoint, rows.map((row) => row.account),
      valued((value) => value.value_usd), valued((value) => value.committed_usd), valued((value) => value.claimable_usd),
      valued((value) => value.tokens_usd), valued((value) => value.usdc_usd), valued((value) => value.sui_usd),
      rows.map(({ value }) => value.kind === "skipped" ? value.reason : null), valued((value) => value.prices_as_of_ms),
    ]);
    const writtenIds = new Set(written.map((row) => row.account_id));
    for (const row of rows) {
      if (!writtenIds.has(row.account)) continue;
      if (row.observation === null) {
        await tx.write("social_portfolio_balance_observations", "DELETE FROM social_portfolio_balance_observations WHERE account_id=$1::uuid AND day=$2::date", [row.account, candidate.day]);
        continue;
      }
      await tx.write("social_portfolio_balance_observations", BALANCE_OBSERVATION_SQL, [
        row.account, candidate.day, row.observation.source, row.observation.observedAtMs,
        row.observation.balances.sui, row.observation.balances.usdc,
      ]);
    }
    if (candidate.retention) {
      const keepFrom = utcDay(utcDayStart(candidate.day) - (config.retentionDays - 1) * DAY_MS);
      await tx.write("social_portfolio_snapshots", RETENTION_SQL, [candidate.accounts, keepFrom]);
    }
    await writeStepCursor(tx, PORTFOLIO_SNAPSHOT_STEP, candidate.cursor);
    return {
      snapshots_written: written.filter((row) => row.skipped === null).length,
      snapshots_skipped: written.filter((row) => row.skipped !== null).length,
    };
  };
}

/**
 * Whether today's sweep (by the process clock's UTC day) is late: not
 * finished `PORTFOLIO_SNAPSHOT_LATE_AFTER_MS` after 00:00 UTC. The cursor is
 * read without a lock (the minute check is not a step).
 */
export async function portfolioSnapshotLate(db: ReadableDatabase, nowMs: number): Promise<SocialAlertDetails | null> {
  const today = utcDay(nowMs);
  if (nowMs - utcDayStart(today) < PORTFOLIO_SNAPSHOT_LATE_AFTER_MS) return null;
  const { rows } = await db.read<{ value: PortfolioSnapshotCursor }>("SELECT value FROM social_worker_state WHERE name = $1", [PORTFOLIO_SNAPSHOT_STEP]);
  const cursor = rows[0]?.value ?? null;
  if (cursor && cursor.day === today && cursor.swept_ms !== null) return null;
  return { day: today, sweeping: cursor?.day ?? null, swept: false };
}

/** The daily portfolio snapshot (OA-25 Q16): one step, bounded by the market pipeline (prices, sale-coin balances). */
export function portfolioSnapshotSteps(config: PortfolioSnapshotConfig): readonly SocialWorkerStep[] {
  return Object.freeze([
    {
      name: PORTFOLIO_SNAPSHOT_STEP,
      pipeline: "market",
      requiredPipelines: ["market", "presale"],
      run: async () => { throw new Error("Portfolio snapshots require bounded preparation before commit."); },
      prepare: (readSnapshot, _bounds, context) => prepareSnapshot(readSnapshot, context, config),
      health: portfolioSnapshotLate,
    },
  ] satisfies SocialWorkerStep[]);
}
