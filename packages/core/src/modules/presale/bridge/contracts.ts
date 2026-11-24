import {
  bridgeSourceSchema,
  bridgeTransferSubmissionSchema,
  evmTxHashSchema,
  positiveBridgeAtomsSchema,
  solanaSignatureSchema,
} from "../contracts/bridge-transfer-request.ts";
import type { BridgeSource, BridgeTransferStatusResponse } from "../contracts/web-api.ts";
import type { PresaleDeploymentState, PresaleRuntimeIdentity } from "../deployment/contracts.ts";

export type { BridgeSource };

/** Circle CCTP domains (checked 2026-10-02). */
export const CCTP_SOURCE_DOMAINS = {
  ethereum: 0,
  arbitrum: 3,
  solana: 5,
  base: 6,
} as const satisfies Record<BridgeSource, number>;
export const SUI_CCTP_DOMAIN = 8;
export const BRIDGE_SOURCES = Object.keys(CCTP_SOURCE_DOMAINS) as readonly BridgeSource[];

/**
 * A source transaction hash in its source's format, normalized: an EVM hash
 * (`0x` + 64 hex) is lowercased, a Solana signature (base58) is kept as is.
 * Null when the value is not that source's format.
 */
export function normalizeBridgeTxHash(source: BridgeSource, value: unknown): string | null {
  const parsed = (source === "solana" ? solanaSignatureSchema : evmTxHashSchema).safeParse(value);
  if (!parsed.success) return null;
  return source === "solana" ? parsed.data : parsed.data.toLowerCase();
}

export function bridgeSource(value: unknown): BridgeSource | null {
  const parsed = bridgeSourceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A positive u64 decimal string (USDC atoms) as a bigint, or null. */
export function positiveBridgeAtoms(value: unknown): bigint | null {
  const parsed = positiveBridgeAtomsSchema.safeParse(value);
  return parsed.success ? BigInt(parsed.data) : null;
}

/** A registration that breaks the rule below; each caller maps it to its own code. */
export class BridgeRegistrationError extends Error {
  constructor() {
    super("The bridge transfer registration is invalid.");
    this.name = "BridgeRegistrationError";
  }
}

/**
 * The registration rule (contracts `bridge-transfer-request`), shared by the
 * public route and the operator's `register-test`: exactly the five keys, a
 * known source, its hash format (an EVM hash is lowercased so a repeat in
 * other letter case is the same transfer; a Solana signature is kept as
 * sent), a positive u64 amount, and two `0x` + 64 hex addresses.
 */
export function parseBridgeTransferRegistration(
  body: unknown,
  privyDid: string | null,
): BridgeTransferRegistration {
  const parsed = bridgeTransferSubmissionSchema.safeParse(body);
  if (!parsed.success) throw new BridgeRegistrationError();
  const { source, tx_hash, sui_address: suiAddress, amount, presale_id: presaleId } = parsed.data;
  const txHash = source === "solana" ? tx_hash : tx_hash.toLowerCase();
  return { source, txHash, suiAddress, amount, presaleId, privyDid };
}

/** `"blast"`: Blast's relayer submits the Sui mint. `"circle"`: the burn carries Circle's forward request. */
export type BridgeForwarding = "blast" | "circle";

/** The deployment identity's Sui CCTP V2 package and object ids. */
export type SuiCctpIds = NonNullable<PresaleRuntimeIdentity["cctp"]>;

/**
 * What this deployment is configured to bridge with, read from the
 * environment and the deployment identity. The bridge is on only while the
 * latest activation record is complete and was recorded for exactly this.
 */
export type BridgeConfiguration = Readonly<{
  identity: PresaleDeploymentState;
  /** `PRESALE_BRIDGE_FORWARDING`, or null when unset or invalid. */
  forwarding: BridgeForwarding | null;
  /** `PRESALE_BRIDGE_RELAYER_ADDRESS`, or null when unset or invalid. */
  relayerAddress: string | null;
}>;

/** One `$5` mainnet Fast transfer of the activation checklist. */
export type BridgeActivationTestTransfer = Readonly<{
  source: BridgeSource;
  amount_atoms: string;
  source_tx_hash: string;
  sui_digest: string;
  burn_to_mint_seconds: number;
}>;

/**
 * One $5 mainnet withdrawal of the activation checklist: USDC burned on Sui
 * with the Forwarding hook and minted by Circle on `destination`.
 */
export type BridgeWithdrawTestTransfer = Readonly<{
  destination: BridgeSource;
  amount_atoms: string;
  sui_digest: string;
  /** The destination's mint, as Circle's `forwardTxHash` reports it. */
  destination_tx_hash: string;
  burn_to_mint_seconds: number;
}>;

/** The checklist's withdrawal part: a destination goes live with one passing test transfer. */
export type BridgeWithdrawChecklist = Readonly<{
  test_transfers: readonly BridgeWithdrawTestTransfer[];
}>;

/** The 5 October activation checklist, as the operator records it (JSON). */
export type BridgeActivationChecklist = Readonly<{
  forwarding: BridgeForwarding;
  /** The bridge relayer's Sui address: required for `"blast"`. */
  relayer_address: string | null;
  /** Circle's forward request for the Sui route: required for `"circle"`, null for `"blast"`. */
  hook_data: string | null;
  /** Circle's fee API lists domain 8 as a V2 destination with Fast Transfer (threshold 1000). */
  circle: Readonly<{ domain8_v2: boolean; domain8_fast: boolean; checked_at: string }>;
  /** The global Fast allowance (USDC) next to the raise and the wallet cap (USDC atoms). */
  fast_allowance: Readonly<{
    allowance_usdc: string;
    raise_atoms: string;
    wallet_cap_atoms: string;
  }>;
  test_transfers: readonly BridgeActivationTestTransfer[];
  note?: string;
  /** Withdrawals out of Sui (social coins): which destinations were proven. Absent: none is live. */
  withdraw?: BridgeWithdrawChecklist;
}>;

/** Why a record does not activate the bridge, as fixed labels. */
export type BridgeActivationProblem =
  | "deactivated"
  | "test_transfers_duplicated"
  | "test_transfer_below_5_usdc"
  | "domain8_v2_unconfirmed"
  | "domain8_fast_unconfirmed"
  | "relayer_address_required"
  | "hook_data_required"
  | "hook_data_not_allowed"
  | "solana_transfers_missing"
  | "base_transfers_missing"
  | "sui_cctp_missing";

/**
 * Comparisons of the Fast allowance with the raise and the wallet cap. The
 * ticket asks for the comparison but states no rule that blocks activation
 * (Standard always works), so these never make a record incomplete.
 */
export type BridgeActivationWarning =
  | "wallet_cap_above_raise"
  | "fast_allowance_below_wallet_cap"
  | "fast_allowance_below_raise";

/** One stored activation record. Records are never changed: the latest one governs. */
export type BridgeActivationRecord = Readonly<{
  id: string;
  recordedAt: Date;
  /** `operator:<operator id>`. */
  recordedBy: string;
  kind: "checklist" | "deactivation";
  forwarding: BridgeForwarding | null;
  relayerAddress: string | null;
  hookData: string | null;
  /** The identity's Sui CCTP ids the checklist ran against. */
  suiCctp: SuiCctpIds | null;
  checklist: BridgeActivationChecklist | Readonly<{ reason: string }>;
  complete: boolean;
  problems: readonly BridgeActivationProblem[];
}>;

/** A record about to be stored. */
export type NewBridgeActivationRecord = Omit<BridgeActivationRecord, "id" | "recordedAt">;

/** The activation record table. */
export type BridgeActivationRecords = Readonly<{
  record(record: NewBridgeActivationRecord): Promise<BridgeActivationRecord>;
  /** The newest record, or null when none was ever recorded. */
  latest(): Promise<BridgeActivationRecord | null>;
  /** Whether any complete record was ever recorded. */
  anyComplete(): Promise<boolean>;
  /** The newest `limit` records, newest first. */
  history(limit: number): Promise<readonly BridgeActivationRecord[]>;
}>;

/** Why the bridge is off, as a fixed label. */
export type BridgeInactiveReason =
  | "no_record"
  | "deactivated"
  | "incomplete"
  | "identity_unavailable"
  | "sui_cctp_changed"
  | "forwarding_changed"
  | "relayer_changed";

export type BridgeActivation =
  | Readonly<{
      active: true;
      recordId: string;
      forwarding: BridgeForwarding;
      /** `0x` + 64 hex: the relayer for `"blast"`, all zeros (any caller) for `"circle"`. */
      destinationCaller: string;
      hookData: string | null;
    }>
  | Readonly<{ active: false; reason: BridgeInactiveReason; recordId: string | null }>;

export type BridgeStatus = BridgeTransferStatusResponse["status"];

/** One registered burn and what the relayer worker learned about it. */
export type BridgeTransfer = Readonly<{
  id: string;
  source: BridgeSource;
  sourceDomain: number;
  txHash: string;
  /** Unauthenticated hint (first registration wins): never the mint's recipient, which is the attested message's. */
  suiAddress: string;
  /** USDC atoms. Unauthenticated hint: the mint is the attested message's amount. */
  amount: string;
  /** Unauthenticated hint: nothing on the mint path reads it. */
  presaleId: string;
  /** Unauthenticated hint: the registering session's DID, if any; not the burn's owner. */
  privyDid: string | null;
  status: BridgeStatus;
  sentAt: Date;
  attestedAt: Date | null;
  mintedAt: Date | null;
  failedAt: Date | null;
  /** `invalid_burn`, `attestation_timeout`, or Circle's `delayReason` text. */
  error: string | null;
  nonce: string | null;
  message: string | null;
  attestation: string | null;
  suiDigest: string | null;
  nextPollAt: Date;
  pollCount: number;
  /** The last "not found" from Circle past the first minute of the observation window: the only evidence that demotes the transfer in the relayer's queue. Null once Circle shows a message. */
  circleNotFoundAt: Date | null;
  /** The start of the current observation window (null: `sentAt`); a repeat registration of a parked transfer resets it. */
  observedFrom: Date | null;
}>;

export type BridgeTransferRegistration = Readonly<{
  source: BridgeSource;
  txHash: string;
  suiAddress: string;
  amount: string;
  presaleId: string;
  privyDid: string | null;
}>;

/**
 * A transition's outcome. A refused move (backward, from a terminal status,
 * or for an unknown id) changes nothing and returns the transfer as it is.
 */
export type BridgeTransition =
  | Readonly<{ applied: true; transfer: BridgeTransfer }>
  | Readonly<{ applied: false; transfer: BridgeTransfer | null }>;

/**
 * The transfer table: registration and reads for the web routes, and the
 * forward-only transitions for the bridge relayer worker.
 *
 * - `sent → attested → minted`;
 * - `failed` from `sent` or `attested`;
 * - `failed` with `attestation_timeout` (never attested) → `attested` when the
 *   attestation arrives late; the failure stamp and error are cleared;
 * - `failed` with `attestation_timeout` (never attested) → `failed` with
 *   `invalid_burn` when a late message proves the burn invalid (spec A-008).
 *
 * Each transition stamps its timestamp: `at` (default the database clock),
 * clamped so it is never earlier than the stamps before it. Clock skew
 * between the worker and the database therefore never fails a transition;
 * the table's order CHECKs remain as the backstop. Prefer omitting `at`.
 *
 * Rules for the relayer worker (T-021):
 *
 * - Process every registered transfer whatever the activation gate says:
 *   the operator registers the checklist's test burns while the bridge is
 *   off (`register-test`), and burns in flight must finish after a
 *   deactivation.
 * - The registered `sui_address`, `amount` and `presale_id` are
 *   unauthenticated hints: anyone who sees a burn on its source chain can
 *   register it first, and a repeat returns that first id. Mint from the
 *   attested message (its recipient and amount), and never fail a valid
 *   burn because a registration disagrees with it.
 */
/**
 * How many registered burns Circle has not attested yet (`sent`) one Privy
 * account may hold (review L6): registering a hash makes the relayer poll
 * Circle for it, so made-up hashes are capped per account. A deposit in
 * flight is attested within minutes, so a person never comes near it.
 */
export const BRIDGE_OPEN_REGISTRATIONS_PER_ACCOUNT = 5;
/** `Retry-After` when the cap is reached: the relayer settles or parks a burn within its observation window. */
export const BRIDGE_OPEN_REGISTRATIONS_RETRY_AFTER_SECONDS = 300;

export type BridgeTransfers = Readonly<{
  /**
   * Idempotent on `(source, tx_hash)`: a repeat returns the first id with
   * `created: false`. A repeat of a parked never-seen transfer re-arms it for
   * one more observation window (T-021 B-010).
   */
  register(input: BridgeTransferRegistration): Promise<Readonly<{ id: string; created: boolean }>>;
  find(id: string): Promise<BridgeTransfer | null>;
  markAttested(
    id: string,
    input: Readonly<{ message: string; attestation: string; nonce?: string | null; at?: Date }>,
  ): Promise<BridgeTransition>;
  markMinted(
    id: string,
    input: Readonly<{ suiDigest: string; at?: Date }>,
  ): Promise<BridgeTransition>;
  markFailed(id: string, input: Readonly<{ error: string; at?: Date }>): Promise<BridgeTransition>;
  /**
   * Counts one poll of a `sent` or `attested` transfer, or of an
   * `attestation_timeout` failure that was never attested, and schedules the
   * next. `delayReason` (Circle's text, or null to clear it) is shown as
   * `error`; a timed-out transfer keeps `attestation_timeout`.
   */
  recordPoll(
    id: string,
    input: Readonly<{ nextPollAt: Date; delayReason?: string | null; circleNotFound?: boolean }>,
  ): Promise<BridgeTransition>;
}>;
