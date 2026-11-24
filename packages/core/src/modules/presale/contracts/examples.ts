import type { PresaleErrorBodies } from "./errors.ts";
import type {
  PresaleCommitmentEntry,
  PresaleProjectionPayload,
  PresaleSummary,
  PresaleTotals,
  PresaleWalletView,
} from "./read-path.ts";
import type { PresaleSchemaTypes } from "./routes.ts";
import type { Freshness } from "./wire.ts";
import { USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";

/**
 * One example payload per schema. Each is typed by its schema's type, so
 * typecheck keeps the types and examples aligned, and the contract test keeps
 * the examples and schemas aligned.
 */

const hex = (byte: string) => byte.repeat(32);
const PRESALE = `0x${hex("a1")}`;
const PRESALE_CAP = `0x${hex("a2")}`;
const CREATOR = `0x${hex("c1")}`;
const WALLET = `0x${hex("7d")}`;
const BLAST = `0x${hex("b1")}`;
const CETUS = `${BLAST}::cetus::Venue`;
const VAULT = `0x${hex("5a")}`;
const ROUND = `0x${hex("6b")}`;
const SALE_TOKEN = `0x${hex("3f")}::froggy::FROGGY`;
const DIGEST = "4tP9gGnU2VZ7ZxCcrQvX7gB1u5Yt2ZbqZzUuXdFh3ry5";
const ROOT = hex("4c");
const PROOF = [hex("01"), hex("02")];

const freshness: Freshness = { checkpoint: 326_274_009, timestamp_ms: 1_790_235_061_218, cursor: "326274009:3:1:0" };

const totals: PresaleTotals = {
  total_commitments: "750000000000",
  remaining_commitments: "750000000000",
  participants: "412",
  fill_rate_bps: null,
  accepted_quote: null,
  refundable_quote: null,
};

const windows = {
  start_ms: 1_790_200_000_000,
  end_ms: 1_790_286_400_000,
  liquidity_deadline_ms: 1_790_890_000_000,
  uncapped_from_ms: null,
  // The sale-level hard cap takes hold 20 h in (ADR 0110).
  hard_cap_from_ms: 1_790_272_000_000,
};

const projection: PresaleProjectionPayload = {
  presale_id: PRESALE,
  presale_cap_id: PRESALE_CAP,
  sale_token: SALE_TOKEN,
  quote: USDC_COIN_TYPE,
  lifecycle: "open",
  windows,
  raise: {
    target: "1000000000000",
    pool_share: "800000000000",
    recipients: [{ address: CREATOR, bps: "1500", amount: "150000000000", vesting: null }],
    protocol: { bps: "500", amount: "50000000000" },
  },
  supply: {
    total: "1000000000000000",
    burnable: true,
    participants: { bps: "5000", amount: "500000000000000" },
    liquidity: { bps: "4000", amount: "400000000000000" },
    recipients: [{ address: CREATOR, bps: "900", amount: "90000000000000", vesting: null }],
    protocol: { bps: "100", amount: "10000000000000" },
  },
  eligibility: { kind: "open", wallet_cap: "5000000000", min_commitment: "1000000", max_participants: "65536" },
  uncapped: { starts_after_ms: 72_000_000, access: { anyone: { max_participants: "65536", min_commitment: "1000000" } } },
  hard_cap: { starts_after_ms: 72_000_000, closes_when_filled: false },
  venue: { kind: "cetus", venue: CETUS },
  participant_vesting: null,
  partner: null,
  fee_split: {
    routes: [
      { destination: { kind: "address", address: CREATOR }, bps: "5000" },
      { destination: { kind: "holder_rewards" }, bps: "5000" },
    ],
  },
  protocol_fees: {
    raise_bps: "500",
    token_bps: "100",
    lp_fee_meme_bps: "2000",
    lp_fee_quote_bps: "2000",
    protocol_quote: "50000000000",
    protocol_tokens: "10000000000000",
  },
  expected_vault_id: VAULT,
  vault: null,
  pool_tier: null,
  ledger: null,
  totals,
  custody: {
    quote: "750000000000",
    sale_tokens: "500000000000000",
    liquidity_tokens: "400000000000000",
    recipient_tokens: "90000000000000",
    protocol_tokens: "10000000000000",
  },
  migration: null,
  cancellation: null,
  delivery: { claimed_wallets: 0, remaining_wallets: 412 },
  freshness,
};

const summary: PresaleSummary = {
  presale_id: PRESALE,
  sale_token: SALE_TOKEN,
  quote: USDC_COIN_TYPE,
  lifecycle: "open",
  windows,
  raise: { target: "1000000000000" },
  eligibility_kind: "open",
  venue: { kind: "cetus", venue: CETUS },
  totals,
  cancellation_reason: null,
  created: { checkpoint: 326_100_000, timestamp_ms: 1_790_100_000_000 },
};

const commitment: PresaleCommitmentEntry = {
  cursor: "326274009:3:1:0",
  digest: DIGEST,
  timestamp_ms: 1_790_235_061_218,
  wallet: WALLET,
  quote: "2500000000",
  wallet_commitment: "2500000000",
  total_commitments: "750000000000",
  participants: "412",
};

const walletView: PresaleWalletView = {
  address: WALLET,
  presale_id: PRESALE,
  commitment: { quote: "2500000000", wallet_cap: "5000000000" },
  commits: [{ digest: DIGEST, timestamp_ms: 1_790_235_061_218, quote: "2500000000", wallet_commitment: "2500000000" }],
  claim: null,
  eligibility: { eligible: true, wallet_cap: "5000000000", source: "open" },
};

const envelope = { cursor: "326274009:3:1:0", checkpoint: 326_274_009, timestamp_ms: 1_790_235_061_218 } as const;
const presaleTopic = `presale:${PRESALE}` as const;

const errors: PresaleErrorBodies = {
  invalid_parameter: { error: { code: "invalid_parameter", message: "limit must be a positive integer" } },
  not_found: { error: { code: "not_found", message: "No such presale." } },
  not_ready: { error: { code: "not_ready", message: "The engine has not bootstrapped." } },
  unauthorized: { error: { code: "unauthorized", message: "Sign in again." } },
  not_embedded_wallet: { error: { code: "not_embedded_wallet", message: "Only your Blast wallet can be sponsored." } },
  target_not_allowed: { error: { code: "target_not_allowed", message: "This transaction calls a function that is not sponsored." } },
  dry_run_failed: {
    error: { code: "dry_run_failed", message: "The transaction would fail.", move_abort: "EWalletCapExceeded" },
  },
  budget_exceeded: { error: { code: "budget_exceeded", message: "Daily sponsored transactions used up.", reason: "daily_limit" } },
  pool_unavailable: { error: { code: "pool_unavailable", message: "Gas sponsorship is busy." } },
  identity_unavailable: { error: { code: "identity_unavailable", message: "Your account cannot be checked now." } },
  deployment_unavailable: { error: { code: "deployment_unavailable", message: "Presales are not configured." } },
  deployment_mismatch: { error: { code: "deployment_mismatch", message: "The configured deployment is on another chain." } },
  invalid_signature: { error: { code: "invalid_signature", message: "The signature does not match the transaction." } },
  reservation_expired: { error: { code: "reservation_expired", message: "The sponsorship expired; try again." } },
  execution_unconfirmed: {
    error: { code: "execution_unconfirmed", message: "The transaction may have executed.", digest: DIGEST },
  },
  invalid_allowlist: {
    error: {
      code: "invalid_allowlist",
      message: "Some rows are invalid.",
      rows: [
        { row: 3, reason: "duplicate wallet" },
        { row: 7, reason: "invalid address" },
      ],
    },
  },
  allowlist_too_large: { error: { code: "allowlist_too_large", message: "The upload is over 4 MiB." } },
  root_mismatch: { error: { code: "root_mismatch", message: "The presale's root is not this allowlist's." } },
  not_eligible: { error: { code: "not_eligible", message: "This wallet is not on the allowlist." } },
  allowlist_unknown: { error: { code: "allowlist_unknown", message: "No stored allowlist matches this presale." } },
  bridge_unavailable: { error: { code: "bridge_unavailable", message: "Bridging is unavailable." } },
  invalid_settings: { error: { code: "invalid_settings", message: "Unknown explorer." } },
  no_visitor: { error: { code: "no_visitor", message: "No visitor cookie." } },
  rate_limited: { error: { code: "rate_limited", message: "Too many requests." } },
  origin_invalid: { error: { code: "origin_invalid", message: "Cross-origin requests are refused." } },
  invalid_request: { error: { code: "invalid_request", message: "Unknown key: extra." } },
  body_too_large: { error: { code: "body_too_large", message: "The body is over 64 KiB." } },
  service_unavailable: { error: { code: "service_unavailable", message: "Try again shortly." } },
};

/** The example projection once funded: the lifecycle message's, which the variants build on. */
export const FUNDED_PROJECTION: PresaleProjectionPayload = {
  ...projection,
  lifecycle: "funded",
  totals: { ...totals, fill_rate_bps: "10000", accepted_quote: "750000000000", refundable_quote: "0" },
};

export const PRESALE_EXAMPLES: PresaleSchemaTypes = {
  "presale-list": { presales: [summary], next_cursor: "c2VjcmV0LXBhZ2UtMg", freshness },
  "presale-projection": projection,
  "presale-commitments": { commitments: [commitment], next_cursor: "326270001:2:0:0", freshness },
  "presale-wallet": { ...walletView, freshness },
  "wallet-presales": { positions: [walletView], next_cursor: null, freshness },
  "presale-policy": {
    creation_policy_id: BLAST,
    fee_policy_id: PRESALE_CAP,
    fee_policy: {
      in_force: { raise_bps: "500", token_bps: "100", lp_fee_meme_bps: "2000", lp_fee_quote_bps: "2000" },
      delay_ms: "86400000",
      pending: null,
    },
    creation_policy: {
      venues: { members: [CETUS], delay_ms: "86400000", pending: null },
      quotes: [{ quote_type: USDC_COIN_TYPE, allowed: true }],
      partners: [{ partner_id: CREATOR, accepted_until_ms: null }],
    },
    provenance: {
      network: "mainnet",
      deployment_fingerprint: hex("5c"),
      checkpoint: freshness.checkpoint,
      timestamp_ms: freshness.timestamp_ms,
      observed_ms: freshness.timestamp_ms + 1200,
      lag_ms: 1200,
    },
  },
  "ws-presale-snapshot": { type: "snapshot", topic: presaleTopic, ...envelope, projection, commitments: [commitment] },
  "ws-presale-snapshot-unavailable": { type: "snapshot_unavailable", topic: presaleTopic, reason: "not_found" },
  "ws-presale-committed": { type: "committed", ...envelope, presale_id: PRESALE, commitment, totals },
  "ws-presale-lifecycle": {
    type: "lifecycle",
    ...envelope,
    presale_id: PRESALE,
    lifecycle: "funded",
    projection: FUNDED_PROJECTION,
  },
  "ws-presale-claimed": {
    type: "claimed",
    ...envelope,
    presale_id: PRESALE,
    wallet: WALLET,
    tokens: "1666666666666",
    quote_refund: "0",
    remaining_wallets: 411,
    // Generation 2: the claim took this wallet off the sale's participants.
    totals: { ...FUNDED_PROJECTION.totals, participants: "411" },
  },
  "ws-presale-created": { type: "presale_created", ...envelope, presale: { ...summary, lifecycle: "pending" } },
  "ws-presale-opened": { type: "presale_opened", ...envelope, presale: summary },
  "sponsor-request": { presale_id: PRESALE, sender: WALLET, transaction_kind_bytes: "AAECAwQ=", intent: "commit" },
  "sponsor-response": {
    reservation_id: "rsv_01J9Z6",
    transaction_bytes: "AAECAwQFBgc=",
    sponsor_signature: "",
    expires_at_ms: 1_790_235_121_218,
    gas_budget: "50000000",
  },
  "execute-request": { user_signature: "AKD4b2xY" },
  "execute-response": { digest: DIGEST, effects: { status: "success", gas_used: "2195880" } },
  "allowlist-create-request": {
    quote: USDC_COIN_TYPE,
    entries: [
      { wallet: WALLET, cap: "5000000000" },
      { wallet: CREATOR, cap: "2500000000" },
    ],
  },
  "allowlist-response": {
    allowlist_id: "al_01J9Z7",
    root: ROOT,
    leaf_count: "2",
    entry_count: 2,
    total_cap: "7500000000",
    warnings: [{ code: "normalized_address", message: "Row 2's address was normalized.", row: 2 }],
  },
  "allowlist-entries-response": {
    quote: USDC_COIN_TYPE, source: { file_name: "crew.csv", uploaded_count: 1, include_blast_holders: false, added_count: 0, holder_cap: null },
    entries: [{ wallet: WALLET, cap: "5000000000" }],
  },
  "allowlist-bind-request": { presale_id: PRESALE },
  "allowlist-bind-response": { allowlist_id: "al_01J9Z7", presale_id: PRESALE, root: ROOT, leaf_count: "2" },
  "allowlist-proof-response": { index: "0", wallet_cap: "5000000000", proof: [hex("01")] },
  "bridge-quote-response": {
    fast: { eta_seconds: 20, fee_bps: "1.3", max_fee: "130000", allowance_ok: true },
    standard: { eta_seconds: 1_140, fee_bps: "0" },
    destination_domain: 8,
    forwarding: "circle",
    destination_caller: `0x${"0".repeat(64)}`,
    hook_data: null,
  },
  "bridge-transfer-request": {
    source: "base",
    tx_hash: `0x${hex("ab")}`,
    sui_address: WALLET,
    amount: "1000000000",
    presale_id: PRESALE,
  },
  "bridge-transfer-created-response": { id: "bt_01J9Z8" },
  "bridge-transfer-status-response": {
    status: "attested",
    timestamps: { sent_ms: 1_790_235_000_000, attested_ms: 1_790_235_020_000, minted_ms: null, failed_ms: null },
    sui_digest: null,
    error: null,
  },
  "account-settings-request": { explorer: "suiscan", theme: "dark" },
  "account-settings-response": { explorer: "suivision", theme: "system", saved: false },
  "outcome-request": { presale_id: PRESALE, tx_digest: DIGEST },
  "outcome-response": { status: "recorded" },
  "account-wallets-response": {
    wallets: [
      { address: WALLET, kind: "embedded", primary: true },
      { address: CREATOR, kind: "slush", primary: false },
    ],
  },
  "reward-allocations-response": {
    allocations: [
      {
        round_id: ROUND,
        number: "0",
        index: "0",
        meme_amount: "3500000000",
        quote_amount: "17500000",
        proof: PROOF.slice(0, 1),
        claim_deadline_ms: 1_790_840_000_000,
        delivery: "relay",
      },
    ],
  },
  "reward-manifest-response": {
    version: 2,
    vaultId: VAULT,
    number: "0",
    startCheckpoint: "326000000",
    endCheckpoint: "326270000",
    root: ROOT,
    manifestDigest: hex("8d"),
    memeAmount: "7000000000",
    quoteAmount: "35000000",
    allocations: [
      { index: "0", beneficiary: WALLET, memeAmount: "3500000000", quoteAmount: "17500000", proof: [hex("01")] },
      { index: "1", beneficiary: CREATOR, memeAmount: "3500000000", quoteAmount: "17500000", proof: [hex("02")] },
    ],
    accounting: {
      policy_version: "address-balance-time-v1",
      exclusions: [VAULT],
      start_checkpoint: 326_000_000,
      end_checkpoint: 326_270_000,
    },
  },
  "errors/invalid_parameter": errors.invalid_parameter,
  "errors/not_found": errors.not_found,
  "errors/not_ready": errors.not_ready,
  "errors/unauthorized": errors.unauthorized,
  "errors/not_embedded_wallet": errors.not_embedded_wallet,
  "errors/target_not_allowed": errors.target_not_allowed,
  "errors/dry_run_failed": errors.dry_run_failed,
  "errors/budget_exceeded": errors.budget_exceeded,
  "errors/pool_unavailable": errors.pool_unavailable,
  "errors/identity_unavailable": errors.identity_unavailable,
  "errors/deployment_unavailable": errors.deployment_unavailable,
  "errors/deployment_mismatch": errors.deployment_mismatch,
  "errors/invalid_signature": errors.invalid_signature,
  "errors/reservation_expired": errors.reservation_expired,
  "errors/execution_unconfirmed": errors.execution_unconfirmed,
  "errors/invalid_allowlist": errors.invalid_allowlist,
  "errors/allowlist_too_large": errors.allowlist_too_large,
  "errors/root_mismatch": errors.root_mismatch,
  "errors/not_eligible": errors.not_eligible,
  "errors/allowlist_unknown": errors.allowlist_unknown,
  "errors/bridge_unavailable": errors.bridge_unavailable,
  "errors/invalid_settings": errors.invalid_settings,
  "errors/no_visitor": errors.no_visitor,
  "errors/rate_limited": errors.rate_limited,
  "errors/origin_invalid": errors.origin_invalid,
  "errors/invalid_request": errors.invalid_request,
  "errors/body_too_large": errors.body_too_large,
  "errors/service_unavailable": errors.service_unavailable,
};
