import type { VestingTerms } from "@interest-protocol/blast-core/payout";
import type {
  EligibilityPolicy,
  HardCap,
  PresaleCommitment,
  PresaleLifecycle,
  PresaleProjection,
  ProtocolFees,
  UncappedAccess,
  UncappedPhase,
} from "@interest-protocol/blast-sdk/presale";


import type {
  Address,
  Checkpoint,
  CoinType,
  Count,
  DecimalString,
  EventCursor,
  EventFields,
  Freshness,
  Nullable,
  PageCursor,
  PresaleId,
  PresaleVenue,
  TimestampMs,
  TransactionDigest,
  WirePick,
} from "./wire.ts";

/** Read path, blast-infra `/v1` (interface contract rev 2, section 2 and CL-1..CL-4, CL-14). */

/** The SDK lifecycle, lowercase on the wire. */
export type PresaleWireLifecycle = Lowercase<PresaleLifecycle>;

type Share = { bps: DecimalString; amount: DecimalString };
type ExactVestingTerms = {
  cliff_delay_ms: DecimalString;
  period_duration_ms: DecimalString;
  periods: WirePick<VestingTerms, "periods">["periods"];
};
type VestingSchedule = {
  vesting_id: Address;
  presale_id: PresaleId;
  beneficiary: Address;
  coin_type: CoinType;
  asset: "sale_token" | "quote";
  share: "token" | "raise" | "participant";
  total: DecimalString;
  released: DecimalString;
  start_ms: TimestampMs;
  cliff_ms: DecimalString;
  period_ms: DecimalString;
  periods: DecimalString;
  end_ms: DecimalString;
  closed: boolean;
  created: Transaction & { checkpoint: Checkpoint };
  last_claim: (Transaction & { amount: DecimalString }) | null;
};
type RecipientShare = {
  address: Address;
  vesting: { terms: ExactVestingTerms; schedule: VestingSchedule | null } | null;
} & Share;
type Transaction = { digest: TransactionDigest; timestamp_ms: TimestampMs };

/**
 * The sale's windows. Generation 2 (contracts ADR 0110): once a sale closes
 * early under a hard cap with `closes_when_filled`, `end_ms` and
 * `liquidity_deadline_ms` are the ACTUAL ones `PresaleFunded` carries, not
 * `PresaleOpened`'s schedule. `hard_cap_from_ms` is null without a hard cap.
 */
export type PresaleWindows = WirePick<PresaleProjection, "startMs" | "endMs" | "liquidityDeadlineMs"> &
  Nullable<WirePick<PresaleProjection, "uncappedFromMs">> &
  WirePick<PresaleProjection, "hardCapFromMs">;

/**
 * The sale-level hard cap (contracts ADR 0110): from `starts_after_ms` into
 * the window commitments take only what is left of the raise; with
 * `closes_when_filled` anyone may settle the sale once the raise is full.
 */
export type PresaleHardCap = WirePick<HardCap, "startsAfterMs" | "closesWhenFilled">;

/** Commitments and delivery counters in the indexer's presale view. */
export type PresaleTotals = WirePick<PresaleProjection, "totalCommitments" | "participants"> & {
  remaining_commitments: DecimalString;
  fill_rate_bps: DecimalString | null;
} & Nullable<EventFields<"PresaleFunded", "accepted_quote" | "refundable_quote">>;

type OpenEligibility = Extract<EligibilityPolicy, { kind: "open" }>;
type AllowlistedEligibility = Extract<EligibilityPolicy, { kind: "allowlisted" }>;
export type PresaleEligibility =
  | WirePick<OpenEligibility, "kind" | "walletCap" | "minCommitment" | "maxParticipants">
  | WirePick<AllowlistedEligibility, "kind" | "root" | "leafCount">;

type AnyoneAccess = Extract<UncappedAccess, { kind: "anyone" }>;
export type PresaleUncapped = WirePick<UncappedPhase, "startsAfterMs"> & {
  access: Extract<UncappedAccess, { kind: "eligible" }>["kind"] | { anyone: WirePick<AnyoneAccess, "maxParticipants" | "minCommitment"> };
};

/** A CLMM venue names the migration witness type. */
export type PresaleClmmVenueView = { kind: Exclude<PresaleVenue, "aftermath">; venue: CoinType };

/**
 * The Aftermath DAO-pool vendor (contracts ADR 0104): its package, the sale's
 * `PoolCreation` binding (`PoolCreationReserved`) and, after migration, the
 * Aftermath pool and the DAO-fee pool traders reach (`Migrated`). Every id is
 * null until its event is indexed. It has no CLMM tier and no `Vault`.
 */
export type PresaleAftermathVenueView = {
  kind: Extract<PresaleVenue, "aftermath">;
  vendor_package_id: Address;
  /** The fresh LP coin, the `PoolCreationReserved` event's `Lp`. */
  lp_type: CoinType | null;
  pool_creation_id: Address | null;
  pool_id: Address | null;
  dao_fee_pool_id: Address | null;
};

export type PresaleVenueView = PresaleClmmVenueView | PresaleAftermathVenueView;

/** Section 2.1: one presale. */
export type PresaleProjectionPayload = WirePick<PresaleProjection, "presaleId" | "presaleCapId"> & {
  sale_token: CoinType;
  quote: CoinType;
  lifecycle: PresaleWireLifecycle;
  windows: PresaleWindows;
  raise: { target: DecimalString; pool_share: DecimalString; recipients: RecipientShare[]; protocol: Share };
  supply: WirePick<PresaleProjection, "burnable"> & {
    total: DecimalString;
    participants: Share;
    liquidity: Share;
    recipients: RecipientShare[];
    protocol: Share;
  };
  eligibility: PresaleEligibility;
  uncapped: PresaleUncapped | null;
  hard_cap: PresaleHardCap | null;
  venue: PresaleVenueView;
  participant_vesting: ExactVestingTerms | null;
  partner: { partner_id: Address; paid?: { meme: DecimalString; quote: DecimalString; sui: DecimalString } | null } | null;
  fee_split: {
    routes: {
      destination: { kind: "address"; address: Address } | { kind: "owner" | "auto_lp" | "holder_rewards" | "burn" };
      bps: DecimalString;
    }[];
  };
  protocol_fees: WirePick<ProtocolFees, keyof ProtocolFees> & WirePick<PresaleProjection, "protocolQuote" | "protocolTokens">;
  expected_vault_id?: Address | null;
  vault?: Record<string, unknown> | null;
  ledger?: Record<string, unknown> | null;
  pool_tier?: Record<string, unknown> | null;
  totals: PresaleTotals;
  custody: WirePick<PresaleProjection, "quote" | "saleTokens" | "liquidityTokens" | "recipientTokens" | "protocolTokens">;
  migration: null | (Transaction & { pool_id: Address | null } & WirePick<PresaleProjection, "protocolQuote" | "protocolTokens">);
  cancellation: null | (Transaction & { reason: "raise_missed" | "liquidity_deadline" });
  delivery: { claimed_wallets: Count; remaining_wallets: Count };
  freshness: Freshness;
};

/** One `GET /v1/presales` row (T-002-AC-3); `windows` and `totals` are the section 2.1 objects (CL-14). */
export type PresaleSummary = Pick<PresaleProjectionPayload, "presale_id" | "sale_token" | "quote" | "lifecycle" | "windows" | "totals"> & {
  raise: Pick<PresaleProjectionPayload["raise"], "target">;
  eligibility_kind: PresaleEligibility["kind"];
  venue: PresaleVenueView;
  cancellation_reason: Exclude<PresaleProjectionPayload["cancellation"], null>["reason"] | null;
  created: { checkpoint: Checkpoint; timestamp_ms: TimestampMs };
};

export type PresaleListResponse = { presales: PresaleSummary[]; next_cursor: PageCursor | null; freshness: Freshness };

/** CL-1: a commitment log entry; `wallet` is the committing transaction's sender. */
export type PresaleCommitmentEntry = {
  cursor: EventCursor;
  digest: TransactionDigest;
  timestamp_ms: TimestampMs;
  wallet: Address;
} & EventFields<"Committed", "quote" | "wallet_commitment" | "total_commitments" | "participants">;

/** CL-1: `next_cursor` is the next page's `before`. */
export type PresaleCommitmentsResponse = {
  commitments: PresaleCommitmentEntry[];
  next_cursor: EventCursor | null;
  freshness: Freshness;
};

/** Section 2.2: one wallet's commitment and delivery. */
export type PresaleWalletView = {
  address: Address;
  presale_id: PresaleId;
  commitment: null | WirePick<PresaleCommitment, "quote" | "walletCap">;
  commits: (Transaction & EventFields<"Committed", "quote" | "wallet_commitment">)[];
  claim: null | (Transaction & EventFields<"Claimed", "tokens" | "quote_refund"> & { relayed_by: Address; vesting_id: Address | null });
  eligibility: { eligible: boolean; wallet_cap: DecimalString | null; source: "open" | "allowlist" | "uncapped" };
};

/** `GET /v1/presales/{presale_id}/wallets/{address}`: the section 2.2 view and the read path's freshness. */
export type PresaleWalletResponse = PresaleWalletView & { freshness: Freshness };

/** CL-2. */
export type WalletPresalesResponse = { positions: PresaleWalletView[]; next_cursor: PageCursor | null; freshness: Freshness };

type PendingPolicy = { delay_ms: DecimalString; ready_at_ms: DecimalString } & Record<string, unknown>;

/** The indexer's governed presale policy and the checkpoint that served it. */
export type PresalePolicyResponse = {
  creation_policy_id: Address | null;
  fee_policy_id: Address | null;
  fee_policy: { in_force: WirePick<ProtocolFees, keyof ProtocolFees> | null; delay_ms: DecimalString; pending: PendingPolicy | null } | null;
  creation_policy: {
    venues: { members: CoinType[]; delay_ms: DecimalString; pending: PendingPolicy | null } | null;
    quotes: { quote_type: CoinType; allowed: boolean }[];
    partners: { partner_id: Address; accepted_until_ms: DecimalString | null }[];
  };
  provenance: {
    network: string;
    deployment_fingerprint: string | null;
    checkpoint: Checkpoint | null;
    timestamp_ms: TimestampMs | null;
    observed_ms: TimestampMs;
    lag_ms: number | null;
  };
};

// === WebSocket (`/v1/ws`, CL-4 as corrected by CL-20, CL-26, CL-28, CL-29) ===

/** `presale:<presale_id>`. */
export type PresaleTopic = `presale:${PresaleId}`;
export type PresaleFeedTopic = "presale_feed";

/**
 * blast-infra's market-data envelope. Only `snapshot` names its `topic`. A log
 * message has none: it is fanned out to every topic it belongs to and reaches
 * a connection once, so clients route it by `presale_id` and drop a repeated
 * `cursor` (CL-20).
 */
type Envelope<Type extends string, Body> = {
  type: Type;
  cursor: EventCursor;
  checkpoint: Checkpoint;
  timestamp_ms: TimestampMs;
} & Body;

/**
 * A log message. One replayed on resume carries `replayed: true`; the
 * snapshot after `resume_complete` replaces the client's state (CL-26).
 */
type LogMessage<Type extends string, Body> = Envelope<Type, Body> & { replayed?: true };

/**
 * Sent instead of a snapshot for a `presale:<id>` topic, on first subscribe or
 * after `resume_complete`, when the server does not know the sale
 * (`not_found`: HTTP answers 404) or cannot render it (`unavailable`: retry
 * HTTP with backoff). The topic stays subscribed (CL-28).
 */
export type PresaleSnapshotUnavailableMessage = {
  type: "snapshot_unavailable";
  topic: PresaleTopic;
  reason: "not_found" | "unavailable";
};

export type PresaleSnapshotMessage = Envelope<
  "snapshot",
  { topic: PresaleTopic; projection: PresaleProjectionPayload; commitments: PresaleCommitmentEntry[] }
>;
export type PresaleCommittedMessage = LogMessage<
  "committed",
  { presale_id: PresaleId; commitment: PresaleCommitmentEntry; totals: PresaleTotals }
>;
/**
 * Carries the full section 2.1 projection, never a delta; sent to both
 * `presale:<id>` and `presale_feed`. A replayed one may omit the projection,
 * and a client never applies state from it (CL-26).
 */
export type PresaleLifecycleMessage = LogMessage<"lifecycle", { presale_id: PresaleId; lifecycle: PresaleWireLifecycle }> &
  ({ projection: PresaleProjectionPayload } | { replayed: true; projection?: PresaleProjectionPayload });
/** One wallet's delivery, with the sale's totals after it, as `committed` carries them (CL-29). */
export type PresaleClaimedMessage = LogMessage<
  "claimed",
  { wallet: Address; remaining_wallets: Count; totals: PresaleTotals } & EventFields<
    "Claimed",
    "presale_id" | "tokens" | "quote_refund"
  >
>;
export type PresaleCreatedMessage = LogMessage<"presale_created", { presale: PresaleSummary }>;
export type PresaleOpenedMessage = LogMessage<"presale_opened", { presale: PresaleSummary }>;
