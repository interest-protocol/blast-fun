import type { VaultEventPayloads } from "@interest-protocol/blast-sdk/vault";
import type { RewardManifest, RewardProof } from "@interest-protocol/blast-sdk/holder-rewards";
import type { Allowlist, AllowlistProof } from "@interest-protocol/blast-sdk/presale";
import type { AccountSettings } from "./account-settings.ts";

import type {
  Address,
  Checkpoint,
  Count,
  DecimalString,
  PresaleId,
  TimestampMs,
  TransactionDigest,
  WirePick,
} from "./wire.ts";

/** Web API, `/api/presale/*` and `/api/account/*` (interface contract rev 2, section 3 and CL-5..CL-9, CL-15). */

/** Standard base64. */
export type Base64 = string;

// === 3.1 Gas sponsorship ===

export type { PublicSponsorIntent, SponsorRequest } from "./sponsor-request.ts";

/** `sponsor_signature` is always empty: the gas pool signs inside `execute` (CA-7). */
export type SponsorResponse = {
  reservation_id: string;
  transaction_bytes: Base64;
  sponsor_signature: "";
  expires_at_ms: TimestampMs;
  /** MIST. */
  gas_budget: DecimalString;
};

/** `POST /api/presale/sponsor/{reservation_id}/execute`. */
export type { ExecuteRequest } from "./execute-request.ts";

/** CL-5: `gas_used` is net MIST, computation + storage − rebate, so it may be negative. */
export type ExecuteResponse = {
  digest: TransactionDigest;
  effects: { status: "success" | "failure"; gas_used: `${bigint}` };
};

// === 3.2 Allowlists ===

/**
 * `POST /api/presale/allowlists` as JSON. The CSV form is `multipart/form-data`
 * with a file part `file` (header `wallet,cap`) and a form field `quote` (CL-6c).
 * Card holders are included only when explicitly requested, at the mean uploaded cap.
 */
export type { AllowlistCreateRequest } from "./allowlist-request.ts";

export type AllowlistWarning = {
  code: "quote_not_allowed" | "normalized_address";
  message: string;
  /** The 1-based data row the warning is about. */
  row?: Count;
};

/** The saved manifest; `root` has no `0x` (CL-15). */
export type AllowlistResponse = { allowlist_id: string } & WirePick<
  Allowlist,
  "root" | "leafCount"
> & {
    entry_count: Count;
    /** Quote atoms. */
    total_cap: DecimalString;
    warnings: AllowlistWarning[];
  };

export type AllowlistSource = Readonly<{
  file_name: string;
  uploaded_count: number;
  include_blast_holders: boolean;
  added_count: number;
  holder_cap: DecimalString | null;
}>;

/** Owner-only saved rows, in Merkle index order. Caps are exact Quote atoms. */
export type AllowlistEntriesResponse = Readonly<{
  quote: string;
  source: AllowlistSource | null;
  entries: readonly Readonly<{ wallet: string; cap: DecimalString }>[];
}>;

/** `POST /api/presale/allowlists/{allowlist_id}/bind`. */
export type { AllowlistBindRequest } from "./allowlist-request.ts";

/** CL-6d. */
export type AllowlistBindResponse = { allowlist_id: string; presale_id: PresaleId } & WirePick<
  Allowlist,
  "root" | "leafCount"
>;

/** `GET /api/presale/presales/{presale_id}/proof?wallet=`; proof entries have no `0x` (CL-15). */
export type AllowlistProofResponse = WirePick<AllowlistProof, "index" | "walletCap" | "proof">;

// === 3.3 Bridge (CCTP V2, USDC) ===

export type { BridgeSource } from "./bridge-transfer-request.ts";
/** Circle's rate as reported, possibly fractional: `"1.3"` (CL-7). */
export type FeeBps = string;

/** `GET /api/presale/bridge/quote`. */
export type BridgeQuoteResponse = {
  fast: null | {
    eta_seconds: Count;
    fee_bps: FeeBps;
    max_fee: DecimalString;
    allowance_ok: boolean;
  };
  standard: { eta_seconds: Count; fee_bps: FeeBps };
  destination_domain: 8;
  forwarding: "circle" | "blast";
  /** The relayer's Sui address; all zeros means any caller. */
  destination_caller: Address;
  /** Non-null means `depositForBurnWithHook`. */
  hook_data: string | null;
};

/** `POST /api/presale/bridge/transfers`, idempotent on `(source, tx_hash)`. */
export type { BridgeTransferRequest } from "./bridge-transfer-request.ts";

/** 201 for a new transfer, 200 with the existing id for a repeat. */
export type BridgeTransferCreatedResponse = { id: string };

/** `GET /api/presale/bridge/transfers/{id}`. */
export type BridgeTransferStatusResponse = {
  status: "sent" | "attested" | "minted" | "failed";
  timestamps: {
    sent_ms: TimestampMs;
    attested_ms: TimestampMs | null;
    minted_ms: TimestampMs | null;
    failed_ms: TimestampMs | null;
  };
  sui_digest: TransactionDigest | null;
  /** `invalid_burn`, `attestation_timeout`, or Circle's `delayReason` text. */
  error: string | null;
};

// === 3.5 Account settings (CL-8) ===

export type { AccountSettings } from "./account-settings.ts";
/** `PUT /api/account/settings`. */
export type AccountSettingsRequest = AccountSettings;
/** Every settings response; `saved` is false for an account's configured defaults. */
export type AccountSettingsResponse = AccountSettings & { saved: boolean };

// === 3.6 Outcome registration ===

/** `POST /api/presale/outcomes/commitments` and `POST /api/presale/outcomes`. */
export type { OutcomeRequest } from "./outcome-request.ts";
/** 201 `recorded` or 200 `duplicate`. */
export type OutcomeResponse = { status: "recorded" | "duplicate" };

// === 3.7 Linked wallets ===

/** `GET /api/account/wallets`. */
export type AccountWalletsResponse = {
  wallets: { address: Address; kind: "embedded" | "slush"; primary: boolean }[];
};

// === 3.8 Holder rewards ===

export type RewardAllocation = WirePick<
  VaultEventPayloads["RewardClaimed"],
  "round_id" | "index" | "meme_amount" | "quote_amount"
> &
  WirePick<VaultEventPayloads["RoundPublished"], "number"> & { claim_deadline_ms: TimestampMs } &
  Pick<RewardProof, "proof"> & { delivery: "relay" | "self_claim" };

/** `GET /api/presale/rewards/{presale_id}/wallets/{wallet}`: unpaid allocations of open rounds. */
export type RewardAllocationsResponse = { allocations: RewardAllocation[] };

/** `GET /api/presale/rewards/rounds/{round_id}/manifest`: the SDK manifest plus its accounting (CL-13). */
export type RewardManifestResponse = RewardManifest & {
  accounting: {
    /** The weighting policy, e.g. `address-balance-time-v1`. */
    policy_version: string;
    /** Addresses whose balances earn no reward. */
    exclusions: Address[];
    start_checkpoint: Checkpoint;
    end_checkpoint: Checkpoint;
  };
};
