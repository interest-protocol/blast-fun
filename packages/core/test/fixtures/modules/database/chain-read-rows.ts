/**
 * Recorded rows for the fixture `chain_read_v1` presale and activity views
 * (role-fixtures.ts `CHAIN_FIXTURE`, the real blast-infra shapes where they
 * exist), and the helpers that load them. Test-only,
 * like role-fixtures.ts. Each row type mirrors its view's columns by name, so
 * a row is what a reader selects from the view; amounts are numeric atoms as
 * decimal strings, times are milliseconds and addresses are 66-character
 * lowercase hex. `activity_id` is not stored: the view derives it from
 * `<checkpoint>:<tx_slot>:<event_slot>:<part>`.
 */

export type ChainActivityRow = Readonly<{
  checkpoint: number;
  tx_slot: number;
  event_slot: number;
  part: number;
  timestamp_ms: number;
  digest: string;
  kind: string;
  product: "presale" | "market" | "launchpad" | "boosts";
  actor: string;
  tx_sender: string;
  presale_id: string | null;
  coin_type: string | null;
  quote_type: string;
  quote_amount: string;
  coin_amount: string | null;
  quote_refund: string | null;
  usd_value: string | null;
  usd_price_as_of_ms: number | null;
  venue: string | null;
  participants_after: number | null;
  total_commitments_after: string | null;
}>;

export type ChainPresaleLifecycleRow = Readonly<{
  presale_id: string;
  state: "opened" | "funded" | "migrated" | "cancelled";
  digest: string;
  timestamp_ms: number;
  checkpoint: number;
}>;

/**
 * A `chain_read_v1.presales` row (blast-infra T-034). The sale coin's
 * metadata (`sale_*`) is null until blast-infra has seen it, and the quote's
 * (`quote_*`) for a quote its quote table does not list; `venue` is null for
 * a migration witness other than Cetus's or Bluefin's. `start_ms` and
 * `end_ms` are 0 until the sale opens. An allowlisted sale has
 * `min_commitment` "1" (any positive amount) and no `wallet_cap` (each
 * wallet's cap is its allowlist leaf's).
 */
export type ChainPresaleRow = Readonly<{
  presale_id: string;
  /** PresaleCreated transaction sender, when the source has indexed it. */
  creator?: string | null;
  partner_id?: string | null;
  created_at_ms?: number;
  sale_token: string;
  quote_type: string;
  sale_symbol: string | null;
  sale_name: string | null;
  sale_icon_url: string | null;
  sale_decimals: number | null;
  quote_symbol: string | null;
  quote_decimals: number | null;
  lifecycle: "pending" | "open" | "funded" | "migrated" | "cancelled";
  start_ms: number;
  end_ms: number;
  raise_target: string;
  min_commitment: string;
  wallet_cap: string | null;
  total_commitments: string;
  participants: number;
  /** The migration witness's venue; `aftermath` for the Aftermath DAO-pool vendor's (contracts ADR 0104). */
  venue: "cetus" | "bluefin" | "aftermath" | null;
  pool_id: string | null;
  updated_checkpoint: number;
}>;

/** A `chain_read_v1.presale_positions` row; `last_commit_ms` is null for a wallet known only from its claim. */
export type ChainPresalePositionRow = Readonly<{
  presale_id: string;
  wallet: string;
  commitment: string;
  last_commit_ms: number | null;
  claim_digest: string | null;
  claimed_tokens: string | null;
  claimed_quote_refund: string | null;
  claimed_ms: number | null;
  claimable_tokens?: string | null;
  claimable_quote_refund?: string | null;
  participant_vesting?: Readonly<{ cliffMs: string; periodMs: string; periods: string }> | null;
  claim_vesting_id?: string | null;
}>;

export type ChainCoinBalanceRow = Readonly<{
  coin_type: string;
  owner: string;
  balance: string;
  updated_checkpoint: number;
}>;

export type ChainCoinHolderHistoryRow = Readonly<{
  coin_type: string;
  checkpoint: number;
  timestamp_ms: number;
  holders: number;
}>;

/**
 * A `chain_read_v1.prices` row: a quote coin's Pyth price (`as_of_ms` is
 * Pyth's publish time, whole seconds); sale coins' pool prices (`pool`) come
 * with blast-infra T-037.
 */
export type ChainPriceRow = Readonly<{
  coin_type: string;
  usd_price: string;
  as_of_ms: number;
  source: "pyth" | "pool";
}>;

/**
 * A `chain_read_v1.vesting_schedules` row (blast-infra T-036, OA-18): nothing
 * vests before `start_ms + cliff_ms`, then `periods` steps of `period_ms`, all
 * of it by `end_ms`. `cliff_ms`, `end_ms` and the steps are NUMERIC (they may
 * exceed BIGINT), so decimal strings; no steps reads as a straight line.
 */
export type ChainVestingScheduleRow = Readonly<{
  share?: "token" | "raise" | "participant";
  asset?: "sale_token" | "quote";
  schedule_id: string;
  presale_id: string;
  beneficiary: string;
  total: string;
  claimed: string;
  start_ms: number;
  cliff_ms: string;
  end_ms: string;
  period_ms?: string;
  periods?: string;
}>;

/**
 * A `chain_read_v1.price_history` row (blast-infra R3-20): the last price in
 * one bucket of a tier, `as_of_ms` that price's own time (inside the bucket).
 */
export type ChainPriceHistoryRow = Readonly<{
  coin_type: string;
  resolution: "5m" | "1h" | "1d";
  bucket_ms: number;
  usd_price: string;
  as_of_ms: number;
  source: "pyth" | "pool";
}>;

/**
 * A holder-reward payout row (OA-45), the shape tests seed into
 * `vault_reward_payouts`: one claim, paid to `beneficiary`, sent by `relayed_by` (the rewards relayer, or
 * the wallet itself). `index` and the amounts are NUMERIC (decimal strings);
 * `round_number` counts from 0.
 */
export type ChainRewardPayoutRow = Readonly<{
  presale_id: string;
  round_id: string;
  round_number: number;
  index: string;
  beneficiary: string;
  meme_amount: string;
  quote_amount: string;
  digest: string;
  timestamp_ms: number;
  relayed_by: string;
  checkpoint: number;
  tx_slot: number;
  event_slot: number;
}>;

/** Shared chain coin metadata; missing fields remain null until resolved. */
export type ChainCoinMetadataRow = Readonly<{
  coin_type: string;
  name: string | null;
  symbol: string | null;
  description: string | null;
  icon_url: string | null;
  decimals: number | null;
}>;

/**
 * A `chain_read_v1.pool_reserves` row (redesign data gap 8): a tracked sale
 * pool's reserves in atoms, the coin's and the quote's, and the checkpoint and
 * time of the transaction that set them. One row per coin.
 */
export type ChainPoolReservesRow = Readonly<{
  coin_type: string;
  quote_type: string;
  presale_id: string;
  pool_id: string;
  venue: "cetus" | "bluefin" | "aftermath";
  coin_reserve: string;
  quote_reserve: string;
  checkpoint: number;
  timestamp_ms: number;
}>;

/** Rows per `chain_read_v1` view, keyed by the view's name. */
export type ChainReadRows = Readonly<{
  activity?: readonly ChainActivityRow[];
  presale_lifecycle?: readonly ChainPresaleLifecycleRow[];
  presales?: readonly ChainPresaleRow[];
  coin_metadata?: readonly ChainCoinMetadataRow[];
  presale_positions?: readonly ChainPresalePositionRow[];
  coin_balances?: readonly ChainCoinBalanceRow[];
  coin_holder_history?: readonly ChainCoinHolderHistoryRow[];
  prices?: readonly ChainPriceRow[];
  vesting_schedules?: readonly ChainVestingScheduleRow[];
  price_history?: readonly ChainPriceHistoryRow[];
  pool_reserves?: readonly ChainPoolReservesRow[];
}>;

const CHAIN_READ_TABLES = [
  "activity", "presale_lifecycle", "presales", "presale_positions", "coin_balances", "coin_holder_history",
  "prices", "vesting_schedules", "price_history", "coin_metadata", "pool_reserves",
] as const satisfies readonly (keyof ChainReadRows)[];

type Queryable = { query(text: string, values?: unknown[]): Promise<unknown> };

/** blast-infra indexing `rows`: appends them to the views' fixture tables. */
export async function seedChainRead(admin: Queryable, rows: ChainReadRows): Promise<void> {
  for (const table of CHAIN_READ_TABLES) {
    const tableRows = rows[table];
    if (!tableRows?.length) continue;
    await admin.query(
      `INSERT INTO blast_infra_fixture.${table}
       SELECT * FROM jsonb_populate_recordset(NULL::blast_infra_fixture.${table}, $1::jsonb)`,
      [JSON.stringify(table === "vesting_schedules" ? tableRows.map((row) => ({ share: "token", asset: "sale_token", ...row })) : tableRows)],
    );
  }
}

/** blast-infra rebuilding its index from the chain: every view holds exactly `rows` afterwards. */
export async function rebuildChainRead(admin: Queryable, rows: ChainReadRows = CHAIN_READ_ROWS): Promise<void> {
  await admin.query(`TRUNCATE ${CHAIN_READ_TABLES.map((table) => `blast_infra_fixture.${table}`).join(", ")}`);
  await seedChainRead(admin, rows);
}

/** A 66-character address (or object id) ending in `tag`. */
function address(tag: string): string {
  return `0x${tag.padStart(64, "0")}`;
}

/** A checkpoint's timestamp: one second per checkpoint after the fixture's coin (checkpoint 900). */
function at(checkpoint: number): number {
  return 1_790_000_000_000 + (checkpoint - 900) * 1_000;
}

export const FIXTURE_QUOTE_TYPE = `${address("2")}::sui::SUI`;
/** A presale that filled, migrated to Cetus and was claimed from. */
export const FIXTURE_PRESALE_ID = address("a11ce5a1e");
/** A presale cancelled before it filled. */
export const FIXTURE_CANCELLED_PRESALE_ID = address("ca5ce11ed");
export const FIXTURE_SALE_COIN_TYPE = `${address("b1a57")}::blast::BLAST`;
export const FIXTURE_WALLETS = {
  alice: address("a1"),
  bob: address("b0b"),
  carol: address("ca201"),
} as const;

/** A transaction digest-shaped string (base58, 44 characters) starting with `seed`. */
function digest(seed: string): string {
  return seed.padEnd(44, "1");
}

function activity(
  checkpoint: number,
  row: Pick<ChainActivityRow, "kind" | "product" | "actor" | "quote_amount"> & Partial<ChainActivityRow>,
): ChainActivityRow {
  return {
    tx_slot: 0,
    event_slot: 0,
    part: 0,
    timestamp_ms: at(checkpoint),
    digest: digest(`Act${checkpoint}`),
    tx_sender: row.actor,
    presale_id: FIXTURE_PRESALE_ID,
    coin_type: FIXTURE_SALE_COIN_TYPE,
    quote_type: FIXTURE_QUOTE_TYPE,
    coin_amount: null,
    quote_refund: null,
    usd_value: null,
    usd_price_as_of_ms: null,
    venue: null,
    participants_after: null,
    total_commitments_after: null,
    ...row,
    checkpoint,
  };
}

/**
 * One story across every view: two wallets commit to a presale that fills,
 * migrates to Cetus and is claimed from, then its coin trades; another
 * presale opens, takes one commitment and is cancelled.
 */
export const CHAIN_READ_ROWS = {
  activity: [
    activity(1_000, {
      kind: "presale_commit", product: "presale", actor: FIXTURE_WALLETS.alice, quote_amount: "5000000000",
      usd_value: "17.50", usd_price_as_of_ms: at(999), participants_after: 1, total_commitments_after: "5000000000",
    }),
    activity(1_001, {
      kind: "presale_commit", product: "presale", actor: FIXTURE_WALLETS.bob, quote_amount: "15000000000",
      usd_value: "52.50", usd_price_as_of_ms: at(999), participants_after: 2, total_commitments_after: "20000000000",
    }),
    activity(1_002, {
      kind: "presale_commit", product: "presale", actor: FIXTURE_WALLETS.alice, quote_amount: "1000000000",
      presale_id: FIXTURE_CANCELLED_PRESALE_ID, coin_type: null, participants_after: 1, total_commitments_after: "1000000000",
    }),
    activity(1_100, {
      kind: "presale_claim", product: "presale", actor: FIXTURE_WALLETS.alice, quote_amount: "0",
      coin_amount: "250000000000", quote_refund: "0",
    }),
    activity(1_200, {
      kind: "trade_buy", product: "market", actor: FIXTURE_WALLETS.carol, quote_amount: "2000000000",
      coin_amount: "90000000000", usd_value: "7.10", usd_price_as_of_ms: at(1_199), venue: "cetus",
    }),
    // One transaction whose sell event the indexer splits into two parts.
    activity(1_201, {
      tx_slot: 3, event_slot: 1, part: 0, kind: "trade_sell", product: "market", actor: FIXTURE_WALLETS.bob,
      quote_amount: "1000000000", coin_amount: "40000000000", venue: "cetus",
    }),
    activity(1_201, {
      tx_slot: 3, event_slot: 1, part: 1, kind: "trade_sell", product: "market", actor: FIXTURE_WALLETS.bob,
      quote_amount: "500000000", coin_amount: "20000000000", venue: "cetus",
    }),
  ],
  presale_lifecycle: [
    { presale_id: FIXTURE_PRESALE_ID, state: "opened", digest: digest("Open1"), timestamp_ms: at(990), checkpoint: 990 },
    { presale_id: FIXTURE_PRESALE_ID, state: "funded", digest: digest("Fund1"), timestamp_ms: at(1_050), checkpoint: 1_050 },
    { presale_id: FIXTURE_PRESALE_ID, state: "migrated", digest: digest("Migr1"), timestamp_ms: at(1_150), checkpoint: 1_150 },
    { presale_id: FIXTURE_CANCELLED_PRESALE_ID, state: "opened", digest: digest("Open2"), timestamp_ms: at(995), checkpoint: 995 },
    { presale_id: FIXTURE_CANCELLED_PRESALE_ID, state: "cancelled", digest: digest("Canc2"), timestamp_ms: at(1_060), checkpoint: 1_060 },
  ],
  presales: [
    {
      presale_id: FIXTURE_PRESALE_ID, sale_token: FIXTURE_SALE_COIN_TYPE, quote_type: FIXTURE_QUOTE_TYPE,
      sale_symbol: "BLAST", sale_name: "Blast", sale_icon_url: "https://i/blast.png", sale_decimals: 9,
      quote_symbol: "SUI", quote_decimals: 9, lifecycle: "migrated", start_ms: at(990), end_ms: at(1_050),
      raise_target: "20000000000", min_commitment: "1000000000", wallet_cap: "15000000000",
      total_commitments: "20000000000", participants: 2, venue: "cetus", pool_id: address("c0e75"),
      updated_checkpoint: 1_150,
    },
    {
      presale_id: FIXTURE_CANCELLED_PRESALE_ID, sale_token: `${address("dead")}::gone::GONE`, quote_type: FIXTURE_QUOTE_TYPE,
      sale_symbol: "GONE", sale_name: "Gone", sale_icon_url: "https://i/gone.png", sale_decimals: 6,
      quote_symbol: "SUI", quote_decimals: 9, lifecycle: "cancelled", start_ms: at(995), end_ms: at(1_100),
      raise_target: "50000000000", min_commitment: "1000000000", wallet_cap: null,
      total_commitments: "1000000000", participants: 1, venue: "bluefin", pool_id: null, updated_checkpoint: 1_060,
    },
  ],
  presale_positions: [
    {
      presale_id: FIXTURE_PRESALE_ID, wallet: FIXTURE_WALLETS.alice, commitment: "5000000000", last_commit_ms: at(1_000),
      claim_digest: digest("Act1100"), claimed_tokens: "250000000000", claimed_quote_refund: "0", claimed_ms: at(1_100),
    },
    {
      presale_id: FIXTURE_PRESALE_ID, wallet: FIXTURE_WALLETS.bob, commitment: "15000000000", last_commit_ms: at(1_001),
      claim_digest: null, claimed_tokens: null, claimed_quote_refund: null, claimed_ms: null,
    },
    {
      presale_id: FIXTURE_CANCELLED_PRESALE_ID, wallet: FIXTURE_WALLETS.alice, commitment: "1000000000",
      last_commit_ms: at(1_002), claim_digest: null, claimed_tokens: null, claimed_quote_refund: null, claimed_ms: null,
    },
  ],
  coin_balances: [
    { coin_type: FIXTURE_SALE_COIN_TYPE, owner: FIXTURE_WALLETS.alice, balance: "250000000000", updated_checkpoint: 1_100 },
    { coin_type: FIXTURE_SALE_COIN_TYPE, owner: FIXTURE_WALLETS.bob, balance: "690000000000", updated_checkpoint: 1_201 },
    { coin_type: FIXTURE_SALE_COIN_TYPE, owner: FIXTURE_WALLETS.carol, balance: "90000000000", updated_checkpoint: 1_200 },
  ],
  coin_holder_history: [
    { coin_type: FIXTURE_SALE_COIN_TYPE, checkpoint: 1_150, timestamp_ms: at(1_150), holders: 2 },
    { coin_type: FIXTURE_SALE_COIN_TYPE, checkpoint: 1_200, timestamp_ms: at(1_200), holders: 3 },
  ],
  prices: [
    { coin_type: FIXTURE_QUOTE_TYPE, usd_price: "3.5", as_of_ms: at(1_199), source: "pyth" },
    { coin_type: FIXTURE_SALE_COIN_TYPE, usd_price: "0.0789", as_of_ms: at(1_201), source: "pool" },
  ],
  vesting_schedules: [
    {
      schedule_id: address("7e57"), presale_id: FIXTURE_PRESALE_ID, beneficiary: FIXTURE_WALLETS.carol,
      total: "100000000000", claimed: "0", start_ms: at(1_150), cliff_ms: String(30 * 86_400_000),
      end_ms: String(at(1_150) + 180 * 86_400_000),
    },
  ],
} as const satisfies ChainReadRows;
