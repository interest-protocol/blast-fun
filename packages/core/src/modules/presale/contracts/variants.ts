import { FUNDED_PROJECTION, PRESALE_EXAMPLES } from "./examples.ts";
import type { PresaleProjectionPayload, PresaleSummary } from "./read-path.ts";
import type { PresaleSchemaName, PresaleSchemaTypes } from "./routes.ts";

/**
 * Typed payloads for every schema branch the one example per schema does not
 * reach: the other side of each nullable field and union, and every value of
 * each hand-written enum. Each is typed by its schema's type, and the contract
 * test validates each against its schema and checks that the examples and
 * variants together reach every `anyOf`/`oneOf` alternative and every member
 * of an enum not tied to an SDK list, so a type and its schema cannot drift on
 * any branch (Q-001, Q-009).
 */

const hex = (byte: string) => byte.repeat(32);
const POOL = `0x${hex("9f")}`;
const RELAYER = `0x${hex("e5")}`;
const DIGEST = "9GmKpXv3uRbT7wYc2LhNq5sDfE8jZa4oiP6Bt1Vy3nWx";
const BLUEFIN = `0x${hex("b7")}::bluefin::Venue`;
const AFTERMATH_VENDOR = `0x${hex("af")}`;
const AFTERMATH_TREASURY = `0x${hex("a7")}`;
const POOL_CREATION = `0x${hex("a2")}`;
const DAO_FEE_POOL = `0x${hex("a3")}`;
const LP_TYPE = `0x${hex("a1")}::af_lp::AF_LP`;

const projection = PRESALE_EXAMPLES["presale-projection"];
const SPONSOR_EXAMPLE = PRESALE_EXAMPLES["sponsor-request"] as Extract<PresaleSchemaTypes["sponsor-request"], { presale_id: string }>;
const lifecycleExample = PRESALE_EXAMPLES["ws-presale-lifecycle"];
const funded = FUNDED_PROJECTION;
const [summary] = PRESALE_EXAMPLES["presale-list"].presales;
const wallet = PRESALE_EXAMPLES["presale-wallet"];
const quote = PRESALE_EXAMPLES["bridge-quote-response"];
const transfer = PRESALE_EXAMPLES["bridge-transfer-status-response"];

/** Migrated: allowlisted eligibility, uncapped for the eligible, a Bluefin pool, and the migration. */
const migrated: PresaleProjectionPayload = {
  ...funded,
  lifecycle: "migrated",
  eligibility: { kind: "allowlisted", root: hex("4c"), leaf_count: "2" },
  uncapped: { starts_after_ms: 72_000_000, access: "eligible" },
  hard_cap: null,
  windows: { ...funded.windows, uncapped_from_ms: 1_790_272_000_000, hard_cap_from_ms: null },
  venue: { kind: "bluefin", venue: BLUEFIN },
  custody: { ...funded.custody, quote: "0", liquidity_tokens: "0", recipient_tokens: "0", protocol_tokens: "0" },
  migration: {
    digest: DIGEST,
    timestamp_ms: 1_790_290_000_000,
    pool_id: null,
    protocol_quote: "37500000000",
    protocol_tokens: "10000000000000",
  },
  delivery: { claimed_wallets: 12, remaining_wallets: 400 },
};

/** Cancelled after missing the raise, with no uncapped phase, before its venue's tier was indexed (ADR 0111). */
const cancelled: PresaleProjectionPayload = {
  ...projection,
  lifecycle: "cancelled",
  uncapped: null,
  totals: { ...projection.totals, refundable_quote: "750000000000" },
  cancellation: { digest: DIGEST, timestamp_ms: 1_790_286_500_000, reason: "raise_missed" },
};

/**
 * Migrated through the Aftermath DAO-pool vendor (contracts ADR 0104): its
 * pool and DAO-fee pool, no CLMM tier, and the vendor's treasury taking every
 * LP fee with no holder rewards.
 */
const aftermathMigrated: PresaleProjectionPayload = {
  ...migrated,
  venue: {
    kind: "aftermath",
    vendor_package_id: AFTERMATH_VENDOR,
    pool_creation_id: POOL_CREATION,
    lp_type: LP_TYPE,
    pool_id: POOL,
    dao_fee_pool_id: DAO_FEE_POOL,
  },
  fee_split: { routes: [{ destination: { kind: "address", address: AFTERMATH_TREASURY }, bps: "10000" }] },
  migration: { ...migrated.migration!, pool_id: POOL },
  // Closed early once full under a hard cap that closes when filled (ADR 0110): the windows are the actual
  // ones `PresaleFunded` carried, the end 10 h before the scheduled one and the LP deadline counted from it.
  hard_cap: { starts_after_ms: 0, closes_when_filled: true },
  windows: { start_ms: 1_790_200_000_000, end_ms: 1_790_250_400_000, liquidity_deadline_ms: 1_790_854_000_000, uncapped_from_ms: null, hard_cap_from_ms: 1_790_200_000_000 },
};

/** A funded Aftermath sale as the lifecycle relayer lists it: bound to its `PoolCreation`, not yet migrated. */
const aftermathFundedSummary: PresaleSummary = {
  ...summary,
  lifecycle: "funded",
  venue: { kind: "aftermath", vendor_package_id: AFTERMATH_VENDOR, pool_creation_id: POOL_CREATION, lp_type: LP_TYPE, pool_id: null, dao_fee_pool_id: null },
};

/** An Aftermath sale whose `PoolCreationReserved` is not indexed yet. */
const aftermathUnboundSummary: PresaleSummary = {
  ...summary,
  venue: { kind: "aftermath", vendor_package_id: AFTERMATH_VENDOR, pool_creation_id: null, lp_type: null, pool_id: null, dao_fee_pool_id: null },
};

const migratedSummary: PresaleSummary = {
  ...summary,
  lifecycle: "migrated",
  windows: migrated.windows,
  eligibility_kind: "allowlisted",
  venue: { kind: "bluefin", venue: BLUEFIN },
  totals: migrated.totals,
};
/** Cancelled when the liquidity deadline passed after funding. */
const deadlineCancelled: PresaleProjectionPayload = {
  ...funded,
  lifecycle: "cancelled",
  cancellation: { digest: DIGEST, timestamp_ms: 1_790_890_100_000, reason: "liquidity_deadline" },
};

const cancelledSummary: PresaleSummary = { ...summary, lifecycle: "cancelled", cancellation_reason: "raise_missed" };
const deadlineSummary: PresaleSummary = { ...summary, lifecycle: "cancelled", cancellation_reason: "liquidity_deadline" };

const vestingTerms = { cliff_delay_ms: "0", period_duration_ms: "86400000", periods: "30" } as const;
const schedule = {
  vesting_id: DAO_FEE_POOL,
  presale_id: projection.presale_id,
  beneficiary: RELAYER,
  coin_type: projection.sale_token,
  total: "90000000000000",
  released: "0",
  start_ms: 1_790_290_000_000,
  cliff_ms: "0",
  period_ms: "86400000",
  periods: "30",
  end_ms: "1792882000000",
  closed: false,
  created: { digest: DIGEST, timestamp_ms: 1_790_290_000_000, checkpoint: 326_300_000 },
  last_claim: null,
} as const;
const policy = PRESALE_EXAMPLES["presale-policy"];
const pending = { delay_ms: "86400000", ready_at_ms: "1790386400000" } as const;

export const PRESALE_VARIANTS: { readonly [Name in PresaleSchemaName]?: readonly PresaleSchemaTypes[Name][] } = {
  "presale-projection": [
    migrated,
    cancelled,
    deadlineCancelled,
    aftermathMigrated,
    {
      ...migrated,
      participant_vesting: vestingTerms,
      partner: { partner_id: RELAYER, paid: { meme: "0", quote: "1", sui: "0" } },
      fee_split: {
        routes: [
          { destination: { kind: "owner" }, bps: "5000" },
          { destination: { kind: "auto_lp" }, bps: "2500" },
          { destination: { kind: "burn" }, bps: "2500" },
        ],
      },
      vault: { vault_id: POOL },
      ledger: { origin_id: projection.presale_id },
      pool_tier: { venue: BLUEFIN },
      supply: {
        ...migrated.supply,
        recipients: [{
          ...migrated.supply.recipients[0],
          vesting: { terms: vestingTerms, schedule: { ...schedule, asset: "sale_token", share: "token" } },
        }],
      },
      raise: {
        ...migrated.raise,
        recipients: [{
          ...migrated.raise.recipients[0],
          vesting: { terms: vestingTerms, schedule: { ...schedule, asset: "quote", share: "raise", last_claim: { digest: DIGEST, timestamp_ms: schedule.created.timestamp_ms, amount: "1" } } },
        }],
      },
    },
    {
      ...projection,
      expected_vault_id: null,
      partner: { partner_id: RELAYER, paid: null },
      supply: {
        ...projection.supply,
        recipients: [
          { ...projection.supply.recipients[0], vesting: { terms: vestingTerms, schedule: null } },
          { ...projection.supply.recipients[0], vesting: { terms: vestingTerms, schedule: { ...schedule, asset: "sale_token", share: "participant" } } },
        ],
      },
    },
  ],
  "presale-policy": [
    {
      ...policy,
      fee_policy: { in_force: null, delay_ms: "86400000", pending },
      creation_policy: {
        ...policy.creation_policy,
        venues: { members: [BLUEFIN], delay_ms: "86400000", pending },
        partners: [{ partner_id: RELAYER, accepted_until_ms: pending.ready_at_ms }],
      },
      provenance: {
        ...policy.provenance,
        network: "testnet",
        deployment_fingerprint: null,
        checkpoint: null,
        timestamp_ms: null,
        lag_ms: null,
      },
    },
    {
      ...policy,
      creation_policy_id: null,
      fee_policy_id: null,
      fee_policy: null,
      creation_policy: { venues: null, quotes: [], partners: [] },
      provenance: { ...policy.provenance, network: "devnet" },
    },
    { ...policy, provenance: { ...policy.provenance, network: "localnet" } },
  ],
  "presale-list": [
    {
      ...PRESALE_EXAMPLES["presale-list"],
      presales: [
        migratedSummary,
        cancelledSummary,
        deadlineSummary,
        aftermathFundedSummary,
        aftermathUnboundSummary,
      ],
      next_cursor: null,
    },
  ],
  "presale-commitments": [{ ...PRESALE_EXAMPLES["presale-commitments"], commitments: [], next_cursor: null }],
  "presale-wallet": [
    {
      ...wallet,
      commitment: null,
      claim: { digest: DIGEST, timestamp_ms: 1_790_291_000_000, tokens: "1666666666666", quote_refund: "0", relayed_by: RELAYER, vesting_id: null },
      eligibility: { eligible: false, wallet_cap: null, source: "allowlist" },
    },
    { ...wallet, eligibility: { eligible: true, wallet_cap: null, source: "uncapped" } },
    { ...wallet, claim: { digest: DIGEST, timestamp_ms: 1_790_291_000_000, tokens: "1", quote_refund: "0", relayed_by: RELAYER, vesting_id: DAO_FEE_POOL } },
  ],
  "wallet-presales": [{ ...PRESALE_EXAMPLES["wallet-presales"], next_cursor: "cG9zaXRpb25zLTI" }],
  "ws-presale-snapshot-unavailable": [{ ...PRESALE_EXAMPLES["ws-presale-snapshot-unavailable"], reason: "unavailable" }],
  "ws-presale-lifecycle": [
    { ...lifecycleExample, lifecycle: "migrated", projection: migrated },
    // CL-26: replayed on resume, without its projection.
    {
      type: "lifecycle",
      cursor: lifecycleExample.cursor,
      checkpoint: lifecycleExample.checkpoint,
      timestamp_ms: lifecycleExample.timestamp_ms,
      presale_id: lifecycleExample.presale_id,
      lifecycle: lifecycleExample.lifecycle,
      replayed: true,
    },
  ],
  "execute-response": [{ digest: DIGEST, effects: { status: "failure", gas_used: "-1200" } }],
  "allowlist-entries-response": [
    { ...PRESALE_EXAMPLES["allowlist-entries-response"], source: null },
    { ...PRESALE_EXAMPLES["allowlist-entries-response"], source: { file_name: "crew.csv", uploaded_count: 1, include_blast_holders: true, added_count: 1, holder_cap: "5000000000" } },
  ],
  "allowlist-response": [
    { ...PRESALE_EXAMPLES["allowlist-response"], warnings: [{ code: "quote_not_allowed", message: "USDT is not an allowed Quote." }] },
  ],
  "bridge-quote-response": [{ ...quote, fast: null, forwarding: "blast", destination_caller: RELAYER, hook_data: "0x00ab" }],
  "bridge-transfer-status-response": [
    { ...transfer, status: "sent", timestamps: { ...transfer.timestamps, attested_ms: null } },
    {
      ...transfer,
      status: "minted",
      timestamps: { ...transfer.timestamps, minted_ms: 1_790_235_040_000 },
      sui_digest: DIGEST,
    },
    {
      ...transfer,
      status: "failed",
      timestamps: { sent_ms: 1_790_235_000_000, attested_ms: null, minted_ms: null, failed_ms: 1_790_238_600_000 },
      error: "attestation_timeout",
    },
  ],
  "account-settings-response": [
    { explorer: "suiscan", theme: "dark", saved: true },
    { explorer: "suivision", theme: "light", saved: true },
  ],
  "account-settings-request": [
    { explorer: "suivision", theme: "system" },
    { explorer: "suiscan", theme: "light" },
  ],
  "sponsor-request": [
    ...(["claim", "settle", "cancel", "reward_claim"] as const).map((intent) => ({
      presale_id: SPONSOR_EXAMPLE.presale_id,
      sender: SPONSOR_EXAMPLE.sender,
      transaction_kind_bytes: SPONSOR_EXAMPLE.transaction_kind_bytes,
      intent,
    })),
    // Social UI-14: a withdrawal names no presale.
    { sender: SPONSOR_EXAMPLE.sender, transaction_kind_bytes: SPONSOR_EXAMPLE.transaction_kind_bytes, intent: "withdraw" as const },
  ],
  "bridge-transfer-request": (["solana", "arbitrum", "ethereum"] as const).map((source) => ({
    ...PRESALE_EXAMPLES["bridge-transfer-request"],
    source,
    tx_hash: source === "solana" ? "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW" : `0x${hex("cd")}`,
  })),
  "outcome-response": [{ status: "duplicate" }],
  "reward-allocations-response": [
    {
      allocations: [
        {
          ...PRESALE_EXAMPLES["reward-allocations-response"].allocations[0],
          index: "1",
          meme_amount: "3",
          quote_amount: "0",
          delivery: "self_claim",
        },
      ],
    },
  ],
  "errors/dry_run_failed": [
    { error: { code: "dry_run_failed", message: "The transaction costs more than the gas cap.", move_abort: null, reason: "gas_cap_exceeded" } },
    { error: { code: "dry_run_failed", message: "The swap would abort.", move_abort: null, reason: "external_abort" } },
  ],
  // CL-25: the open-reservation cap, beside the example's daily limit.
  "errors/budget_exceeded": [
    { error: { code: "budget_exceeded", message: "Two sponsored transactions are already waiting for a signature.", reason: "open_reservations" } },
  ],
  // CL-18: an unknown bridge transfer id.
  "errors/not_found": [{ error: { code: "not_found", message: "No bridge transfer has this id." } }],
};
