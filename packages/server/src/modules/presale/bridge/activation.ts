import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";
import { z } from "zod";
import { bridgeSourceSchema } from "@blast/core/modules/presale/contracts/bridge-transfer-request.ts";
import { isValidTransactionDigest } from "@mysten/sui/utils";

import type { PresaleDeploymentState } from "@blast/core/modules/presale/deployment/contracts.ts";
import { withinFastAllowance } from "@blast/core/modules/presale/bridge/quote.ts";
import {
  normalizeBridgeTxHash,
  type BridgeActivation,
  type BridgeActivationChecklist,
  type BridgeActivationProblem,
  type BridgeActivationRecords,
  type BridgeActivationTestTransfer,
  type BridgeActivationWarning,
  type BridgeWithdrawChecklist,
  type BridgeWithdrawTestTransfer,
  type BridgeConfiguration,
  type NewBridgeActivationRecord,
  type SuiCctpIds,
} from "@blast/core/modules/presale/bridge/contracts.ts";

const HEX_BYTES = /^0x([0-9a-f]{2})+$/;
const UINT = /^(0|[1-9][0-9]*)$/;
const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const ZERO_CALLER = `0x${"0".repeat(64)}`;
/** A checklist transfer passes when Circle minted it on Sui in under this. */
export const ACTIVATION_MAX_MINT_SECONDS = 60;
/** Each checklist transfer is a $5 transfer: at least 5 USDC in atoms. */
export const ACTIVATION_MIN_TEST_ATOMS = 5_000_000n;
const OPERATOR = /^operator:[A-Za-z0-9._:-]{1,128}$/;

/**
 * Circle's documented Forwarding Service hook (`depositForBurnWithHook`):
 * the `cctp-forward` magic, version 0, no extra data. It is the reference
 * value for the runbook; the record carries whatever hook Circle documents
 * for the Sui route on activation day.
 */
export const CIRCLE_FORWARD_HOOK_DATA =
  "0x636374702d666f72776172640000000000000000000000000000000000000000";

/** A malformed checklist: it is refused, never recorded. */
export class BridgeChecklistError extends Error {
  readonly field: string;
  constructor(field: string) {
    super(`The activation checklist's ${field} is invalid.`);
    this.name = "BridgeChecklistError";
    this.field = field;
  }
}

function object(
  value: unknown,
  field: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const shape = Object.fromEntries([
    ...required.map((key) => [key, z.unknown().nonoptional()]),
    ...optional.map((key) => [key, z.unknown().optional()]),
  ]);
  const parsed = z.strictObject(shape).safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = issue.code === "unrecognized_keys" ? issue.keys[0] : issue.path[0];
    throw new BridgeChecklistError(key === undefined ? field : `${field}.${String(key)}`);
  }
  return parsed.data;
}

function matching(value: unknown, pattern: RegExp, field: string): string {
  const parsed = z.string().regex(pattern).safeParse(value);
  if (!parsed.success) throw new BridgeChecklistError(field);
  return parsed.data;
}

function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

function boolean(value: unknown, field: string): boolean {
  const parsed = z.boolean().safeParse(value);
  if (!parsed.success) throw new BridgeChecklistError(field);
  return parsed.data;
}

function testTransfer(value: unknown, index: number): BridgeActivationTestTransfer {
  const field = `test_transfers[${index}]`;
  const record = object(value, field, [
    "source",
    "amount_atoms",
    "source_tx_hash",
    "sui_digest",
    "burn_to_mint_seconds",
  ]);
  if (!bridgeSourceSchema.safeParse(record.source).success)
    throw new BridgeChecklistError(`${field}.source`);
  const seconds = record.burn_to_mint_seconds;
  if (!z.number().nonnegative().safeParse(seconds).success)
    throw new BridgeChecklistError(`${field}.burn_to_mint_seconds`);
  const suiDigest = record.sui_digest;
  if (!z.string().refine(isValidTransactionDigest).safeParse(suiDigest).success)
    throw new BridgeChecklistError(`${field}.sui_digest`);
  const sourceTx = normalizeBridgeTxHash(
    record.source as BridgeActivationTestTransfer["source"],
    record.source_tx_hash,
  );
  if (sourceTx === null) throw new BridgeChecklistError(`${field}.source_tx_hash`);
  return Object.freeze({
    source: record.source as BridgeActivationTestTransfer["source"],
    amount_atoms: matching(record.amount_atoms, UINT, `${field}.amount_atoms`),
    source_tx_hash: sourceTx,
    sui_digest: suiDigest as string,
    burn_to_mint_seconds: seconds as number,
  });
}

function withdrawTestTransfer(value: unknown, index: number): BridgeWithdrawTestTransfer {
  const field = `withdraw.test_transfers[${index}]`;
  const record = object(value, field, [
    "destination",
    "amount_atoms",
    "sui_digest",
    "destination_tx_hash",
    "burn_to_mint_seconds",
  ]);
  if (!bridgeSourceSchema.safeParse(record.destination).success)
    throw new BridgeChecklistError(`${field}.destination`);
  const destination = record.destination as BridgeWithdrawTestTransfer["destination"];
  const seconds = record.burn_to_mint_seconds;
  if (!z.number().nonnegative().safeParse(seconds).success)
    throw new BridgeChecklistError(`${field}.burn_to_mint_seconds`);
  const suiDigest = record.sui_digest;
  if (!z.string().refine(isValidTransactionDigest).safeParse(suiDigest).success)
    throw new BridgeChecklistError(`${field}.sui_digest`);
  const destinationTx = normalizeBridgeTxHash(destination, record.destination_tx_hash);
  if (destinationTx === null) throw new BridgeChecklistError(`${field}.destination_tx_hash`);
  return Object.freeze({
    destination,
    amount_atoms: matching(record.amount_atoms, UINT, `${field}.amount_atoms`),
    sui_digest: suiDigest as string,
    destination_tx_hash: destinationTx,
    burn_to_mint_seconds: seconds as number,
  });
}

/** The checklist's optional `withdraw` part: `{ test_transfers: [...] }`, at most 20. */
function withdrawChecklist(value: unknown): BridgeWithdrawChecklist {
  const record = object(value, "withdraw", ["test_transfers"]);
  const transfers = z.array(z.unknown()).max(20).safeParse(record.test_transfers);
  if (!transfers.success) throw new BridgeChecklistError("withdraw.test_transfers");
  return Object.freeze({ test_transfers: Object.freeze(transfers.data.map(withdrawTestTransfer)) });
}

/** The operator's checklist JSON, exactly: an unknown key or a wrong type is refused. */
export function parseBridgeActivationChecklist(value: unknown): BridgeActivationChecklist {
  const record = object(
    value,
    "checklist",
    ["forwarding", "relayer_address", "hook_data", "circle", "fast_allowance", "test_transfers"],
    ["note", "withdraw"],
  );
  const forwarding = z.enum(["blast", "circle"]).safeParse(record.forwarding);
  if (!forwarding.success) throw new BridgeChecklistError("forwarding");
  const circle = object(record.circle, "circle", ["domain8_v2", "domain8_fast", "checked_at"]);
  const checkedAt = circle.checked_at;
  const checked = z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)))
    .safeParse(checkedAt);
  if (!checked.success) throw new BridgeChecklistError("circle.checked_at");
  const allowance = object(record.fast_allowance, "fast_allowance", [
    "allowance_usdc",
    "raise_atoms",
    "wallet_cap_atoms",
  ]);
  const transfers = z.array(z.unknown()).max(20).safeParse(record.test_transfers);
  if (!transfers.success) throw new BridgeChecklistError("test_transfers");
  if (!z.string().max(500).optional().safeParse(record.note).success)
    throw new BridgeChecklistError("note");
  return Object.freeze({
    forwarding: forwarding.data,
    relayer_address: nullable(record.relayer_address, (value) =>
      matching(value, SUI_OBJECT_ID_PATTERN, "relayer_address"),
    ),
    hook_data: nullable(record.hook_data, (value) => {
      if (!z.string().max(2_050).safeParse(value).success)
        throw new BridgeChecklistError("hook_data");
      return matching(value, HEX_BYTES, "hook_data");
    }),
    circle: Object.freeze({
      domain8_v2: boolean(circle.domain8_v2, "circle.domain8_v2"),
      domain8_fast: boolean(circle.domain8_fast, "circle.domain8_fast"),
      checked_at: checked.data,
    }),
    fast_allowance: Object.freeze({
      allowance_usdc: matching(allowance.allowance_usdc, DECIMAL, "fast_allowance.allowance_usdc"),
      raise_atoms: matching(allowance.raise_atoms, UINT, "fast_allowance.raise_atoms"),
      wallet_cap_atoms: matching(
        allowance.wallet_cap_atoms,
        UINT,
        "fast_allowance.wallet_cap_atoms",
      ),
    }),
    test_transfers: Object.freeze(transfers.data.map(testTransfer)),
    ...(record.note === undefined ? {} : { note: record.note as string }),
    ...(record.withdraw === undefined ? {} : { withdraw: withdrawChecklist(record.withdraw) }),
  });
}

/** What keeps `checklist` from activating the bridge against `suiCctp`. */
export function bridgeActivationProblems(
  checklist: BridgeActivationChecklist,
  suiCctp: SuiCctpIds | null,
): readonly BridgeActivationProblem[] {
  const problems: BridgeActivationProblem[] = [];
  if (!checklist.circle.domain8_v2) problems.push("domain8_v2_unconfirmed");
  if (!checklist.circle.domain8_fast) problems.push("domain8_fast_unconfirmed");
  if (checklist.forwarding === "blast" && checklist.relayer_address === null)
    problems.push("relayer_address_required");
  if (checklist.forwarding === "blast" && checklist.hook_data !== null)
    problems.push("hook_data_not_allowed");
  if (checklist.forwarding === "circle" && checklist.hook_data === null)
    problems.push("hook_data_required");
  // A transfer counts once: a repeated (source, hash) or Sui digest is the same transfer.
  const hashes = new Set<string>();
  const digests = new Set<string>();
  const distinct = checklist.test_transfers.filter((transfer) => {
    const hash = `${transfer.source}:${transfer.source_tx_hash}`;
    const repeated = hashes.has(hash) || digests.has(transfer.sui_digest);
    hashes.add(hash);
    digests.add(transfer.sui_digest);
    return !repeated;
  });
  if (distinct.length < checklist.test_transfers.length) problems.push("test_transfers_duplicated");
  const fiveDollars = (transfer: BridgeActivationTestTransfer) =>
    BigInt(transfer.amount_atoms) >= ACTIVATION_MIN_TEST_ATOMS;
  if (!checklist.test_transfers.every(fiveDollars)) problems.push("test_transfer_below_5_usdc");
  const passed = (source: string) =>
    distinct.filter(
      (transfer) =>
        transfer.source === source &&
        fiveDollars(transfer) &&
        transfer.burn_to_mint_seconds < ACTIVATION_MAX_MINT_SECONDS,
    ).length;
  if (passed("solana") < 2) problems.push("solana_transfers_missing");
  if (passed("base") < 1) problems.push("base_transfers_missing");
  if (suiCctp === null) problems.push("sui_cctp_missing");
  return Object.freeze(problems);
}

/**
 * The checklist's allowance comparison: the global Fast allowance (USDC)
 * against the wallet cap and the raise (atoms), and the cap against the
 * raise. Recorded for the operator; it never blocks activation.
 */
export function bridgeActivationWarnings(
  checklist: BridgeActivationChecklist,
): readonly BridgeActivationWarning[] {
  const {
    allowance_usdc: allowance,
    raise_atoms: raise,
    wallet_cap_atoms: cap,
  } = checklist.fast_allowance;
  const warnings: BridgeActivationWarning[] = [];
  if (BigInt(cap) > BigInt(raise)) warnings.push("wallet_cap_above_raise");
  if (!withinFastAllowance(BigInt(cap), allowance))
    warnings.push("fast_allowance_below_wallet_cap");
  if (!withinFastAllowance(BigInt(raise), allowance)) warnings.push("fast_allowance_below_raise");
  return Object.freeze(warnings);
}

function recordedBy(value: string): string {
  if (!z.string().regex(OPERATOR).safeParse(value).success)
    throw new BridgeChecklistError("recorded_by");
  return value;
}

/** A checklist record: complete exactly when no problem remains. */
export function buildBridgeActivationRecord(
  input: Readonly<{
    checklist: BridgeActivationChecklist;
    suiCctp: SuiCctpIds | null;
    recordedBy: string;
  }>,
): NewBridgeActivationRecord {
  const problems = bridgeActivationProblems(input.checklist, input.suiCctp);
  return Object.freeze({
    recordedBy: recordedBy(input.recordedBy),
    kind: "checklist",
    forwarding: input.checklist.forwarding,
    relayerAddress: input.checklist.relayer_address,
    hookData: input.checklist.hook_data,
    suiCctp: input.suiCctp,
    checklist: input.checklist,
    complete: problems.length === 0,
    problems,
  });
}

/** A record that turns the bridge off until the next complete checklist. */
export function buildBridgeDeactivationRecord(
  input: Readonly<{ reason: string; recordedBy: string }>,
): NewBridgeActivationRecord {
  if (input.reason.length < 1 || input.reason.length > 500)
    throw new BridgeChecklistError("reason");
  return Object.freeze({
    recordedBy: recordedBy(input.recordedBy),
    kind: "deactivation",
    forwarding: null,
    relayerAddress: null,
    hookData: null,
    suiCctp: null,
    checklist: Object.freeze({ reason: input.reason }),
    complete: false,
    problems: Object.freeze(["deactivated"] as const),
  });
}

/** The ids in a fixed order, so a stored copy compares equal whatever its key order. */
export function suiCctpKey(ids: SuiCctpIds): string {
  return [
    ids.messageTransmitter,
    ids.tokenMessengerMinter,
    ids.mtState.objectId,
    ids.mtState.initialSharedVersion,
    ids.tmmState.objectId,
    ids.tmmState.initialSharedVersion,
    ids.usdcTreasury.objectId,
    ids.usdcTreasury.initialSharedVersion,
    ids.usdcType,
    ids.denyList.objectId,
    ids.denyList.initialSharedVersion,
    ids.stablecoinHandler ?? "",
    ids.handlerState?.objectId ?? "",
    ids.handlerState?.initialSharedVersion ?? "",
  ].join("|");
}

/**
 * The bridge configuration from the environment: `PRESALE_BRIDGE_FORWARDING`
 * (`blast` or `circle`) and `PRESALE_BRIDGE_RELAYER_ADDRESS` (the relayer's
 * Sui address), with the deployment identity's Sui CCTP ids. A missing or
 * invalid value is null, which keeps the bridge off.
 */
export function bridgeConfigurationFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  identity: PresaleDeploymentState,
): BridgeConfiguration {
  const forwarding = environment.PRESALE_BRIDGE_FORWARDING?.trim();
  const relayer = environment.PRESALE_BRIDGE_RELAYER_ADDRESS?.trim().toLowerCase();
  return Object.freeze({
    identity,
    forwarding: z.enum(["blast", "circle"]).safeParse(forwarding).data ?? null,
    relayerAddress: z.string().regex(SUI_OBJECT_ID_PATTERN).safeParse(relayer).data ?? null,
  });
}

/** Whether the latest record activates the bridge under `configuration`. */
export function evaluateBridgeActivation(
  latest:
    | (Readonly<
        Pick<
          NewBridgeActivationRecord,
          "kind" | "complete" | "forwarding" | "relayerAddress" | "hookData" | "suiCctp"
        >
      > & { id: string })
    | null,
  configuration: BridgeConfiguration,
): BridgeActivation {
  if (latest === null) return { active: false, reason: "no_record", recordId: null };
  const off = (
    reason: Extract<BridgeActivation, { active: false }>["reason"],
  ): BridgeActivation => ({ active: false, reason, recordId: latest.id });
  if (latest.kind === "deactivation") return off("deactivated");
  if (!latest.complete || latest.forwarding === null || latest.suiCctp === null)
    return off("incomplete");
  const identity = configuration.identity;
  if (identity.status !== "ready" || !identity.identity.cctp) return off("identity_unavailable");
  if (suiCctpKey(identity.identity.cctp) !== suiCctpKey(latest.suiCctp))
    return off("sui_cctp_changed");
  if (configuration.forwarding !== latest.forwarding) return off("forwarding_changed");
  if (latest.forwarding === "blast") {
    if (latest.relayerAddress === null || configuration.relayerAddress !== latest.relayerAddress)
      return off("relayer_changed");
    return {
      active: true,
      recordId: latest.id,
      forwarding: "blast",
      destinationCaller: latest.relayerAddress,
      hookData: null,
    };
  }
  return {
    active: true,
    recordId: latest.id,
    forwarding: "circle",
    destinationCaller: ZERO_CALLER,
    hookData: latest.hookData,
  };
}

export type BridgeActivationGate = Readonly<{
  /** The bridge's state now: the latest record under the current configuration. */
  current(): Promise<BridgeActivation>;
  /** Whether the bridge was ever activated: transfer status reads answer from then on. */
  everActivated(): Promise<boolean>;
}>;

/**
 * The activation gate. The bridge is off by default: it is on only while the
 * latest record is a complete checklist recorded for the configured
 * forwarding mode, relayer, and the identity's Sui CCTP ids. Changing any of
 * them without a new record turns it off.
 */
export function createBridgeActivationGate(
  input: Readonly<{
    records: Pick<BridgeActivationRecords, "latest" | "anyComplete">;
    configuration: BridgeConfiguration | (() => BridgeConfiguration);
  }>,
): BridgeActivationGate {
  const configuration =
    typeof input.configuration === "function"
      ? input.configuration
      : () => input.configuration as BridgeConfiguration;
  // Records are never deleted, so once true this stays true: remember it, never a false.
  let activatedOnce = false;
  return Object.freeze({
    async current() {
      return evaluateBridgeActivation(await input.records.latest(), configuration());
    },
    async everActivated() {
      activatedOnce ||= await input.records.anyComplete();
      return activatedOnce;
    },
  });
}
