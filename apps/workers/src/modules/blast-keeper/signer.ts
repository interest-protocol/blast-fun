// Gas-only key: registration, opening rounds and the closed set of permissionless SDK actions.
// Canonical SDK reconstruction binds every package, singleton, value and result edge before crypto.

import { bcs } from "@mysten/sui/bcs";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { fromBase64, normalizeStructTag, normalizeSuiAddress, normalizeSuiObjectId } from "@mysten/sui/utils";

import type { BlastDeployment } from "@interest-protocol/blast-deployments-sdk";
import { loadSignerKey } from "../worker-runtime/keys.ts";
import {
  assertAddressBalanceEnvelope,
  gasBudgetFor,
  MAX_RECORDS_PER_TRANSACTION,
  SignerRefusal,
  type SignedTransaction,
  type TransactionData,
} from "../worker-runtime/signer.ts";
import { assertKeeperActionOnly, type KeeperActionIntent } from "./transactions.ts";

export { SignerRefusal, gasBudgetFor, MAX_RECORDS_PER_TRANSACTION, MAX_GAS_BUDGET_MIST, type SignedTransaction } from "../worker-runtime/signer.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export type RegistrationIntent = Readonly<{
  memeType: string;
  currency: Readonly<{ objectId: string; version: string; digest: string }>;
}>;

/**
 * One launch's opening-round step: `settle` (one `settle_opening_round`, no
 * bidders) or `deliver` (one `deliver_opening_round` per bidder, in order,
 * each bidder once). `typeArguments` are the launch's `[Meme, Quote]`.
 */
export type OpeningRoundIntent = Readonly<{
  step: "settle" | "deliver";
  launchId: string;
  typeArguments: readonly string[];
  bidders: readonly string[];
}>;

/** The active deployment's launchpad package and the shared objects its calls take. */
export type LaunchpadTargets = Readonly<{ packageId: string; packageVersionId: string; runtimeConfigId: string }>;

/** The most bidders one delivery transaction may pay. */
export const MAX_DELIVERIES_PER_TRANSACTION = 100;

export type KeeperSigner = Readonly<{
  address: string;
  signActions(bytes: Uint8Array, intents: readonly KeeperActionIntent[], deployment: BlastDeployment, beforeCrypto?: () => Promise<void>): Promise<SignedTransaction>;
  signRegistrations(bytes: Uint8Array, intents: readonly RegistrationIntent[], deployment: BlastDeployment): Promise<SignedTransaction>;
  /** `launchpad`: the active deployment's, the only package and objects signed. */
  signOpeningRound(bytes: Uint8Array, intent: OpeningRoundIntent, launchpad: LaunchpadTargets, deployment: BlastDeployment): Promise<SignedTransaction>;
}>;

/** What the keeper's bytes must be built for: its address, the gas cap and the deployment's chain. */
type KeeperEnvelope = Readonly<{ sender: string; gasBudgetMist: bigint; chainIdentifier: string }>;

const COIN_REGISTRY = normalizeSuiObjectId("0xc");

/** Throws unless every input is an argument of some command: nothing rides along unused. */
function assertEveryInputUsed(data: TransactionData): void {
  const used = new Set<number>();
  for (const command of data.commands) {
    for (const argument of command.MoveCall?.arguments ?? []) {
      if (argument.$kind === "Input") used.add(argument.Input);
    }
  }
  if (used.size !== data.inputs.length) throw new SignerRefusal("an unused input");
}

/** Throws unless `records` is 1 to `MAX_RECORDS_PER_TRANSACTION` keys, none twice. */
function assertRecordCount(keys: readonly string[]): void {
  if (keys.length === 0 || keys.length > MAX_RECORDS_PER_TRANSACTION) throw new SignerRefusal("an intent of another shape");
  if (new Set(keys).size !== keys.length) throw new SignerRefusal("a record twice");
}

/**
 * Throws unless `bytes` are exactly `intents`' registrations by `sender`, in
 * order: command i is `0x2::coin_registry::finalize_registration<Meme>` of
 * intent i over the one Coin Registry input and that intent's pending
 * currency, and the inputs are that registry and one `Receiving` per intent,
 * each used. No Meme type or currency twice. The gas budget is at most
 * `gasBudgetFor(gasBudgetMist, intents)`.
 */
export function assertRegistrationsOnly(bytes: Uint8Array, intents: readonly RegistrationIntent[], envelope: KeeperEnvelope): void {
  assertRecordCount(intents.map((intent) => normalizeStructTag(intent.memeType)));
  if (new Set(intents.map((intent) => normalizeSuiObjectId(intent.currency.objectId))).size !== intents.length) {
    throw new SignerRefusal("a record twice");
  }
  const data = assertAddressBalanceEnvelope(bytes, { ...envelope, gasBudgetMist: gasBudgetFor(envelope.gasBudgetMist, intents.length) });
  if (data.commands.length !== intents.length) throw new SignerRefusal("unexpected commands");
  if (data.inputs.length !== intents.length + 1) throw new SignerRefusal("unexpected inputs");
  assertEveryInputUsed(data);
  for (const [index, intent] of intents.entries()) assertRegistration(data, index, intent);
}

/** Checks command `index`: one `finalize_registration` of `intent` over the Coin Registry. */
function assertRegistration(data: TransactionData, index: number, intent: RegistrationIntent): void {
  const call = data.commands[index]?.MoveCall;
  if (
    !call ||
    normalizeSuiAddress(call.package) !== normalizeSuiAddress("0x2") ||
    call.module !== "coin_registry" ||
    call.function !== "finalize_registration"
  ) {
    throw new SignerRefusal("another call");
  }
  if (call.typeArguments.length !== 1 || !sameType(call.typeArguments[0]!, intent.memeType)) {
    throw new SignerRefusal("another Meme type");
  }
  if (call.arguments.length !== 2) throw new SignerRefusal("unexpected arguments");
  const [registry, receiving] = call.arguments.map((argument) =>
    argument.$kind === "Input" ? data.inputs[argument.Input] : undefined,
  );
  const shared = registry?.Object?.SharedObject;
  if (!shared || normalizeSuiObjectId(shared.objectId) !== COIN_REGISTRY) throw new SignerRefusal("another registry");
  const currency = receiving?.Object?.Receiving;
  if (
    !currency ||
    normalizeSuiObjectId(currency.objectId) !== normalizeSuiObjectId(intent.currency.objectId) ||
    String(currency.version) !== intent.currency.version ||
    currency.digest !== intent.currency.digest
  ) {
    throw new SignerRefusal("another pending currency");
  }
}

function sameType(left: string, right: string): boolean {
  return normalizeStructTag(left) === normalizeStructTag(right);
}

/** One Move call argument: an intended shared object, or (a delivery's bidder) an intended address. */
type ArgumentRule = Readonly<{ shared: string; refusal: string } | { address: string }>;

type CallRule = Readonly<{ target: string; typeArguments: readonly string[]; arguments: readonly ArgumentRule[] }>;

function target(packageId: string, path: string): string {
  return `${normalizeSuiAddress(packageId)}::${path}`;
}

function pureAddress(bytes: string | undefined): string | null {
  if (bytes === undefined) return null;
  try {
    const raw = fromBase64(bytes);
    return raw.length === 32 ? normalizeSuiAddress(bcs.Address.parse(raw)) : null;
  } catch {
    return null;
  }
}

/**
 * Throws unless `bytes` are exactly `calls` by `sender`, in order: only Move
 * calls, every argument an input (never the gas coin or another command's
 * result), every input a shared object or (where a rule names an address) a
 * pure address. Nothing but gas leaves the key.
 */
function assertExactCalls(bytes: Uint8Array, envelope: KeeperEnvelope, calls: readonly CallRule[]): void {
  const data = assertAddressBalanceEnvelope(bytes, envelope);
  const pure = calls.some((call) => call.arguments.some((rule) => "address" in rule));
  for (const input of data.inputs) {
    if (input.Object?.SharedObject) {
      continue;
    }
    if (pure && input.Pure) {
      continue;
    }
    throw new SignerRefusal("an input that is not a shared object");
  }
  assertEveryInputUsed(data);
  if (data.commands.length !== calls.length) {
    throw new SignerRefusal("unexpected commands");
  }
  for (const [index, rule] of calls.entries()) {
    assertExpectedCall(data, data.commands[index]?.MoveCall, rule);
  }
}

function assertExpectedCall(
  data: TransactionData,
  call: TransactionData["commands"][number]["MoveCall"],
  rule: CallRule,
): void {
  if (
    !call ||
    `${normalizeSuiAddress(call.package)}::${call.module}::${call.function}` !== rule.target
  ) {
    throw new SignerRefusal("another call");
  }
  if (
    call.typeArguments.length !== rule.typeArguments.length ||
    call.typeArguments.some((type, position) => !sameType(type, rule.typeArguments[position]!))
  ) {
    throw new SignerRefusal("other coin types");
  }
  if (call.arguments.length !== rule.arguments.length) {
    throw new SignerRefusal("unexpected arguments");
  }
  for (const [position, argument] of call.arguments.entries()) {
    const input = argument.$kind === "Input" ? data.inputs[argument.Input] : undefined;
    assertExpectedArgument(input, rule.arguments[position]!);
  }
}

function assertExpectedArgument(
  input: TransactionData["inputs"][number] | undefined,
  expected: ArgumentRule,
): void {
  if ("address" in expected) {
    if (pureAddress(input?.Pure?.bytes) !== normalizeSuiAddress(expected.address)) {
      throw new SignerRefusal("another bidder");
    }
    return;
  }
  const object = input?.Object?.SharedObject;
  if (!object || normalizeSuiObjectId(object.objectId) !== normalizeSuiObjectId(expected.shared)) {
    throw new SignerRefusal(expected.refusal);
  }
}

const CLOCK = normalizeSuiObjectId("0x6");

/**
 * Throws unless `bytes` are exactly `intent`'s opening-round step for one
 * launch of the active deployment's launchpad (`launchpad`, never the
 * intent's say): one `settle_opening_round(launch, package version, runtime
 * config, clock)`, or one `deliver_opening_round(launch, package version,
 * bidder)` per intended bidder, each bidder once.
 */
export function assertOpeningRoundOnly(
  bytes: Uint8Array,
  intent: OpeningRoundIntent,
  launchpad: LaunchpadTargets,
  envelope: KeeperEnvelope,
): void {
  if (intent.typeArguments.length !== 2) throw new SignerRefusal("an intent of another shape");
  const launch: ArgumentRule = { shared: intent.launchId, refusal: "another launch" };
  const version: ArgumentRule = { shared: launchpad.packageVersionId, refusal: "another shared object" };
  if (intent.step === "settle") {
    if (intent.bidders.length !== 0) throw new SignerRefusal("an intent of another shape");
    assertExactCalls(bytes, envelope, [{
      target: target(launchpad.packageId, "launch::settle_opening_round"),
      typeArguments: intent.typeArguments,
      arguments: [
        launch,
        version,
        { shared: launchpad.runtimeConfigId, refusal: "another shared object" },
        { shared: CLOCK, refusal: "another shared object" },
      ],
    }]);
    return;
  }
  const bidders = intent.bidders.map((bidder) => normalizeSuiAddress(bidder));
  if (bidders.length === 0 || bidders.length > MAX_DELIVERIES_PER_TRANSACTION || new Set(bidders).size !== bidders.length) {
    throw new SignerRefusal("an intent of another shape");
  }
  assertExactCalls(bytes, envelope, bidders.map((bidder) => ({
    target: target(launchpad.packageId, "launch::deliver_opening_round"),
    typeArguments: intent.typeArguments,
    arguments: [launch, version, { address: bidder }],
  })));
}

/**
 * Loads the gas-only keeper key from `BLAST_WORKER_SIGNER_KEY`. `limits`
 * carries the per-record gas cap and the operator's Bluefin creation-fee cap
 * (`keeperSettings`). Errors name the variable only.
 */
export function loadKeeperSigner(
  environment: Environment,
  limits: Readonly<{ gasBudgetMist: bigint; creationFeeCapMist: bigint }>,
): KeeperSigner {
  const keypair = loadSignerKey(environment, "BLAST_WORKER_SIGNER_KEY");
  const address = keypair.toSuiAddress();
  const envelope = (deployment: BlastDeployment): KeeperEnvelope => ({
    sender: address,
    gasBudgetMist: limits.gasBudgetMist,
    chainIdentifier: deployment.chainIdentifier,
  });
  async function sign(bytes: Uint8Array): Promise<SignedTransaction> {
    const { signature } = await keypair.signTransaction(bytes);
    return { digest: TransactionDataBuilder.getDigestFromBytes(bytes), signature };
  }
  return Object.freeze({
    address,
    async signActions(bytes, intents, deployment, beforeCrypto) {
      await assertKeeperActionOnly(bytes, address, intents, deployment, gasBudgetFor(limits.gasBudgetMist, intents.length), limits.creationFeeCapMist);
      await beforeCrypto?.();
      return sign(bytes);
    },
    async signRegistrations(bytes, intents, deployment) {
      assertRegistrationsOnly(bytes, intents, envelope(deployment));
      return sign(bytes);
    },
    async signOpeningRound(bytes, intent, launchpad, deployment) {
      assertOpeningRoundOnly(bytes, intent, launchpad, envelope(deployment));
      return sign(bytes);
    },
  });
}
