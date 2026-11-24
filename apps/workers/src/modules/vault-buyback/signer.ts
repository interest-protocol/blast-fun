import { MIGRATOR_VENUES, type MigratorVenue } from "@blast/core/modules/launchpad-contract/venues.ts";
// Dedicated gas-only BuybackAdmin key. It signs only an ACL sign-in followed
// by the exact vault buyback, including both package versions and the bound
// vault, pool, currency, venue config, quote amount and minimum output.

import { coreRoleType } from "@interest-protocol/blast-core/roles";
import { coreDeployment } from "@interest-protocol/blast-deployments-sdk";
import { bcs } from "@mysten/sui/bcs";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { fromBase64, normalizeStructTag, normalizeSuiAddress, normalizeSuiObjectId } from "@mysten/sui/utils";
import type { BlastDeployment } from "@interest-protocol/blast-deployments-sdk";
import { z } from "zod";

import { cetusMemeSide } from "@interest-protocol/blast-core/cetus";
import { objectIdSchema, u64Schema } from "#workers/lib/validation.ts";
import { sharedCurrencyId } from "#workers/modules/blast-keeper/chain.ts";
import { loadSignerKey } from "#workers/modules/worker-runtime/keys.ts";
import { assertAddressBalanceEnvelope, SignerRefusal, type SignedTransaction, type TransactionData } from "#workers/modules/worker-runtime/signer.ts";

type Environment = Readonly<Record<string, string | undefined>>;
type Argument = NonNullable<TransactionData["commands"][number]["MoveCall"]>["arguments"][number];

export const BUYBACK_KEY_VARIABLE = "BLAST_BUYBACK_SIGNER_KEY";

const CLOCK = normalizeSuiObjectId("0x6");

/** One buyback of one vault in its own pool. Stored as JSONB with the open submission: parsed, never cast. */
export type BuybackIntent = Readonly<{
  venue: MigratorVenue;
  vaultId: string;
  poolId: string;
  memeType: string;
  quoteType: string;
  /** The piece: Quote atoms this buyback spends, u64 decimal string. */
  quoteIn: string;
  /** The vault's `burn_quote` the job read before drawing the piece, u64 decimal string. */
  heldQuote: string;
  /** u64 decimal string. */
  minMemeOut: string;
}>;

const coinTypeSchema = z.string().min(5).max(1024).refine((type) => {
  try {
    return normalizeStructTag(type) === type;
  } catch {
    return false;
  }
});

const intentSchema = z.strictObject({
  venue: z.enum(MIGRATOR_VENUES),
  vaultId: objectIdSchema,
  poolId: objectIdSchema,
  memeType: coinTypeSchema,
  quoteType: coinTypeSchema,
  quoteIn: u64Schema.refine((value) => BigInt(value) > 0n),
  heldQuote: u64Schema,
  minMemeOut: u64Schema.refine((value) => BigInt(value) > 0n),
}).refine((intent) => BigInt(intent.quoteIn) <= BigInt(intent.heldQuote));

export function parseBuybackIntent(value: unknown): BuybackIntent {
  const parsed = intentSchema.safeParse(value);
  if (!parsed.success) throw new SignerRefusal("a malformed buyback intent");
  return parsed.data;
}

/** The contract's type arguments: `<Meme, Quote, CoinA, CoinB>` in Cetus's coin order, or `<Meme, Quote>` on Bluefin. */
export function buybackTypeArguments(intent: Pick<BuybackIntent, "venue" | "memeType" | "quoteType">): string[] {
  const meme = normalizeStructTag(intent.memeType);
  const quote = normalizeStructTag(intent.quoteType);
  if (intent.venue === "bluefin") return [meme, quote];
  return cetusMemeSide(meme, quote) === "a" ? [meme, quote, meme, quote] : [meme, quote, quote, meme];
}

/** What the guard binds the bytes to: the pass's accepted deployment and the configured cap, never the intent's say. */
export type BuybackBinding = Readonly<{ deployment: BlastDeployment; adminCapId: string; gasBudgetMist: bigint }>;

function sameId(left: string, right: string): boolean {
  return normalizeSuiObjectId(left) === normalizeSuiObjectId(right);
}

function sharedInput(data: TransactionData, argument: Argument | undefined, objectId: string, mutable: boolean): number {
  const index = argument?.$kind === "Input" ? argument.Input : -1;
  const shared = data.inputs[index]?.Object?.SharedObject;
  if (!shared || !sameId(shared.objectId, objectId) || shared.mutable !== mutable) throw new SignerRefusal("another shared object");
  return index;
}

/** Command 0: `sign_in<BuybackAdmin>` with the deployment's ACL and the configured cap. Returns the inputs it uses. */
function assertSignIn(data: TransactionData, binding: BuybackBinding): number[] {
  const { packages, sharedObjects } = binding.deployment;
  const signIn = data.commands[0]?.MoveCall;
  if (
    !signIn ||
    normalizeSuiAddress(signIn.package) !== normalizeSuiAddress(packages.admin.packageId) ||
    signIn.module !== "blast_acl" ||
    signIn.function !== "sign_in"
  ) {
    throw new SignerRefusal("another admin call");
  }
  const role = coreRoleType(coreDeployment(binding.deployment), "BuybackAdmin");
  if (signIn.typeArguments.length !== 1 || normalizeStructTag(signIn.typeArguments[0]!) !== normalizeStructTag(role)) {
    throw new SignerRefusal("another admin role");
  }
  if (signIn.arguments.length !== 2) throw new SignerRefusal("unexpected admin arguments");
  const acl = sharedInput(data, signIn.arguments[0], sharedObjects.admin.acl.objectId, false);
  const capArgument = signIn.arguments[1];
  const capIndex = capArgument?.$kind === "Input" ? capArgument.Input : -1;
  const cap = data.inputs[capIndex]?.Object?.ImmOrOwnedObject;
  if (!cap || !sameId(cap.objectId, binding.adminCapId)) throw new SignerRefusal("another AdminCap");
  return [acl, capIndex];
}

/** A u64 pure input. */
function pureU64(data: TransactionData, argument: Argument | undefined, name: string): Readonly<{ index: number; value: bigint }> {
  const index = argument?.$kind === "Input" ? argument.Input : -1;
  try {
    const raw = fromBase64(data.inputs[index]?.Pure?.bytes ?? "");
    if (raw.length !== 8) throw new Error("length");
    return { index, value: BigInt(bcs.u64().parse(raw)) };
  } catch {
    throw new SignerRefusal(`an unreadable ${name}`);
  }
}

/** `quote_in` is the intent's positive piece, within the balance read; `min_meme_out` is the intent's positive floor. */
function assertAmounts(data: TransactionData, args: readonly (Argument | undefined)[], intent: BuybackIntent): number[] {
  const quoteIn = pureU64(data, args[7], "quote_in");
  if (quoteIn.value <= 0n || quoteIn.value !== BigInt(intent.quoteIn) || quoteIn.value > BigInt(intent.heldQuote)) {
    throw new SignerRefusal("another quote_in");
  }
  const minMemeOut = pureU64(data, args[8], "min_meme_out");
  if (minMemeOut.value <= 0n || minMemeOut.value !== BigInt(intent.minMemeOut)) throw new SignerRefusal("another min_meme_out");
  return [quoteIn.index, minMemeOut.index];
}

/** Command 1: the active migrators package's `buyback_and_burn` over exactly the intended objects. */
function assertBuybackCall(data: TransactionData, intent: BuybackIntent, binding: BuybackBinding): number[] {
  const { packages, sharedObjects } = binding.deployment;
  const migratorsVersion = sharedObjects.migrators.packageVersion;
  const vaultVersion = sharedObjects.vault.packageVersion;
  const venueConfig = intent.venue === "cetus" ? sharedObjects.cetus?.config : sharedObjects.bluefin?.config;
  if (!packages.migrators || !migratorsVersion || !venueConfig) throw new SignerRefusal("a deployment without this venue's buyback");
  const call = data.commands[1]?.MoveCall;
  const target = `${normalizeSuiAddress(packages.migrators.packageId)}::${intent.venue}::buyback_and_burn`;
  if (!call || `${normalizeSuiAddress(call.package)}::${call.module}::${call.function}` !== target) {
    throw new SignerRefusal("another call");
  }
  const types = buybackTypeArguments(intent);
  if (call.typeArguments.length !== types.length || call.typeArguments.some((type, index) => normalizeStructTag(type) !== types[index])) {
    throw new SignerRefusal("other coin types");
  }
  const args = call.arguments;
  if (args.length !== 10) throw new SignerRefusal("unexpected arguments");
  const witness = args[3];
  const fromSignIn =
    (witness?.$kind === "Result" && witness.Result === 0) ||
    (witness?.$kind === "NestedResult" && witness.NestedResult[0] === 0 && witness.NestedResult[1] === 0);
  if (!fromSignIn) throw new SignerRefusal("a witness that is not the sign-in's");
  return [
    sharedInput(data, args[0], intent.vaultId, true),
    sharedInput(data, args[1], migratorsVersion.objectId, false),
    sharedInput(data, args[2], vaultVersion.objectId, false),
    sharedInput(data, args[4], sharedCurrencyId(intent.memeType), true),
    sharedInput(data, args[5], venueConfig.objectId, false),
    sharedInput(data, args[6], intent.poolId, true),
    ...assertAmounts(data, args, intent),
    sharedInput(data, args[9], CLOCK, false),
  ];
}

/** Throws unless `bytes` are exactly `intent`'s buyback, sent and paid by `sender` within the gas budget. */
export function assertBuybackOnly(bytes: Uint8Array, sender: string, intent: BuybackIntent, binding: BuybackBinding): void {
  const data = assertAddressBalanceEnvelope(bytes, {
    sender,
    gasBudgetMist: binding.gasBudgetMist,
    chainIdentifier: binding.deployment.chainIdentifier,
  });
  if (data.commands.length !== 2) throw new SignerRefusal("unexpected commands");
  const used = [...assertSignIn(data, binding), ...assertBuybackCall(data, intent, binding)];
  if (new Set(used).size !== used.length || data.inputs.length !== used.length) throw new SignerRefusal("unexpected inputs");
}

export type BuybackSigner = Readonly<{
  address: string;
  /** Signs only `intent`'s buyback, bound to `binding`'s deployment, cap and gas budget. */
  signBuyback(bytes: Uint8Array, intent: unknown, deployment: BlastDeployment): Promise<SignedTransaction>;
}>;

/** Loads the buyback key from `BLAST_BUYBACK_SIGNER_KEY`, refusing any other signer key. Errors name variables only. */
export function loadBuybackSigner(
  environment: Environment,
  limits: Readonly<{ gasBudgetMist: bigint; adminCapId: string }>,
): BuybackSigner {
  const keypair = loadSignerKey(environment, BUYBACK_KEY_VARIABLE);
  const address = keypair.toSuiAddress();
  return Object.freeze({
    address,
    async signBuyback(bytes: Uint8Array, intent: unknown, deployment: BlastDeployment): Promise<SignedTransaction> {
      assertBuybackOnly(bytes, address, parseBuybackIntent(intent), { deployment, ...limits });
      const { signature } = await keypair.signTransaction(bytes);
      return { digest: TransactionDataBuilder.getDigestFromBytes(bytes), signature };
    },
  });
}
