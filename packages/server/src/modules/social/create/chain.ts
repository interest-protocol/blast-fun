import { mainnetIdentity } from "@blast/core/modules/presale/deployment/mainnet-identity.ts";
import { PresaleCalls, PresaleClient, PresaleTransactions, type PresaleDeployment } from "@interest-protocol/blast-sdk/presale";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { Inputs, Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag } from "@mysten/sui/utils";

import { recordMetric } from "@blast/core/lib/metrics.ts";
import type { PresaleDeploymentState, PresaleRuntimeIdentity } from "@blast/core/modules/presale/deployment/contracts.ts";
import type { CreateDraft, CreateFeePolicy, CreatePublishAvailability, CreatePublishBlocker } from "@blast/core/modules/social/contracts/create.ts";
import { CREATE_DEFAULT_FEE_POLICY } from "@blast/core/modules/social/create/model.ts";
import type { CreatePresaleArgs } from "@blast/core/modules/social/create/presale-args.ts";

/**
 * Create's view of the chain: Blast's rates (the deployed `FeePolicy`, or
 * the configured ones before the deploy), whether publishing is on, and the
 * presale-creation transaction. Mainnet only: a deployment on any other
 * network is treated as not deployed. Nothing here signs or sends.
 */

export { CREATE_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";

/**
 * `SOCIAL_CREATE_FEE_POLICY`: Blast's rates before the `FeePolicy` can be
 * read, as `raise,token,lp_meme,lp_quote` BPS (default `200,100,1500,1500`
 * when unset or blank). Parsed once at boot: invalid text throws.
 */
export function configuredFeePolicy(raw: string | undefined): CreateFeePolicy {
  const text = raw?.trim();
  if (!text) return CREATE_DEFAULT_FEE_POLICY;
  const parts = text.split(",").map((part) => Number(part.trim()));
  const valid = parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0) && parts[0]! < 10_000 && parts[1]! <= 9_998 && parts[2]! <= 10_000 && parts[3]! <= 10_000;
  if (!valid) {
    throw new Error("SOCIAL_CREATE_FEE_POLICY must be four comma-separated BPS: raise, token, lp_meme, lp_quote.");
  }
  const [raise_bps, token_bps, lp_fee_meme_bps, lp_fee_quote_bps] = parts as [number, number, number, number];
  return { raise_bps, token_bps, lp_fee_meme_bps, lp_fee_quote_bps, source: "config" };
}

/** The mainnet identity, or null: no manifest, a bad one, or another network. */


export type FeePolicySource = () => Promise<CreateFeePolicy>;

/**
 * Blast's rates for checking drafts: the deployed `FeePolicy` (read through
 * the SDK, at most once a minute, bounded by `timeoutMs`) once a mainnet
 * deployment exists, else the configured rates. A failed read keeps the last
 * good one, else answers the configured rates, with a metric.
 */
export function feePolicySource(input: Readonly<{
  state: PresaleDeploymentState;
  client: () => ClientWithCoreApi | null;
  /** The rates before the deploy (`configuredFeePolicy`, parsed at boot). */
  configured: CreateFeePolicy;
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
  /** Canonical runtime retains the actual SDK read beyond the visible timeout. */
  trackWork?: <T>(work: Promise<T>) => Promise<T>;
}>): FeePolicySource {
  const { configured } = input;
  const identity = mainnetIdentity(input.state);
  const ttlMs = input.ttlMs ?? 60_000;
  const timeoutMs = input.timeoutMs ?? 3_000;
  const now = input.now ?? Date.now;
  const track = input.trackWork ?? (<T>(work: Promise<T>) => work);
  let cached: Readonly<{ at: number; policy: CreateFeePolicy }> | null = null;
  return async () => {
    if (!identity) return configured;
    if (cached && now() - cached.at < ttlMs) return cached.policy;
    const client = input.client();
    if (!client) return cached?.policy ?? configured;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const state = await Promise.race([
        track(new PresaleClient(client, identity.presale).getFeePolicy()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("fee policy read timed out")), timeoutMs);
        }),
      ]);
      const policy: CreateFeePolicy = {
        raise_bps: Number(state.fees.raiseBps),
        token_bps: Number(state.fees.tokenBps),
        lp_fee_meme_bps: Number(state.fees.lpFeeMemeBps),
        lp_fee_quote_bps: Number(state.fees.lpFeeQuoteBps),
        source: "chain",
      };
      cached = { at: now(), policy };
      return policy;
    } catch {
      recordMetric("social.create", { operation: "fee_policy", outcome: "chain_unavailable" });
      return cached?.policy ?? configured;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Whether the SDK can set participant vesting and encode the draft's terms.
 */
export function sdkSupportsVesting(calls: Readonly<{ setParticipantVesting?: unknown }> = PresaleCalls.prototype): boolean {
  return typeof calls.setParticipantVesting === "function";
}

/**
 * The presale coin template: the package whose one-time witness registers a
 * 9-decimal currency through the Coin Registry and hands the publisher a
 * sealed zero-supply treasury cap for the presale.
 */
export type CoinTemplate = Readonly<{
  /** The compiled module with the draft's name, symbol, description and icon. */
  bytecode(coin: CreatePresaleArgs["coin"], deployment: PresaleDeployment): Promise<Readonly<{ modules: string[]; dependencies: string[] }>>;
}>;

/** The sale-token package's dependencies in the order expected by the SDK. */
export function presaleCoinDependencies(deployment: PresaleDeployment): string[] {
  return [
    "0x0000000000000000000000000000000000000000000000000000000000000001",
    "0x0000000000000000000000000000000000000000000000000000000000000002",
    deployment.admin.packageId,
    deployment.partners.packageId,
    deployment.vestingPackageId,
    deployment.core.packageId,
    deployment.packageId,
  ];
}

/** Why publishing a draft is off now, in a fixed order. */
export function publishAvailability(input: Readonly<{
  state: PresaleDeploymentState;
  template: CoinTemplate | null;
  draft: CreateDraft | null;
  vesting?: boolean;
}>): CreatePublishAvailability {
  const reasons: CreatePublishBlocker[] = [];
  if (!mainnetIdentity(input.state)) reasons.push("presale_not_deployed");
  if (!input.template) reasons.push("coin_template_missing");
  const vests = input.draft ? [input.draft.buyer_vesting, ...input.draft.token_recipients, ...input.draft.raise_recipients].some((row) => row.vest) : false;
  if (vests && !(input.vesting ?? sdkSupportsVesting())) reasons.push("sdk_vesting_unsupported");
  return reasons.length ? { available: false, reasons } : { available: true };
}

/** The coin a published coin package defines, and the objects its publish returned. */
export type PublishedCoin = Readonly<{
  /** `0x…::module::WITNESS`. */
  coinType: string;
  /** The sealed zero-supply treasury cap the publish sent to the creator. */
  sealedTreasuryCap: Readonly<{ objectId: string; version: string; digest: string }>;
  /** The coin's shared `Currency<T>` once its registration is finalized. */
  currency: Readonly<{ objectId: string; initialSharedVersion: string }>;
}>;

/**
 * Step 2: `coin_registry::finalize_registration<T>`, which shares the new
 * coin's `Currency<T>` (the Coin Registry receives it at publication). Anyone
 * may send it; the creator's wallet does.
 */
export function registerCurrencyTransaction(input: Readonly<{
  coinType: string;
  /** The `Currency<T>` object the registry received, as a `Receiving` reference. */
  currency: Readonly<{ objectId: string; version: string; digest: string }>;
}>): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: "0x2::coin_registry::finalize_registration",
    typeArguments: [normalizeStructTag(input.coinType)],
    arguments: [tx.object("0xc"), tx.receivingRef(input.currency)],
  });
  return tx;
}

/**
 * Step 3: the venue's preparation, presale creation and sharing in one PTB.
 */
export function createPresaleTransaction(input: Readonly<{
  identity: PresaleRuntimeIdentity;
  args: CreatePresaleArgs;
  coin: PublishedCoin;
  creator: string;
}>): Transaction {
  const { identity, args, coin, creator } = input;
  const sdk = new PresaleTransactions(identity.presale);
  const terms = {
    saleTokenType: normalizeStructTag(coin.coinType),
    quoteType: normalizeStructTag(args.quoteType),
    sealedTreasuryCap: Inputs.ObjectRef(coin.sealedTreasuryCap),
    currency: coin.currency,
    tokenSupply: args.tokenSupply,
    tokenAllocationBps: args.tokenAllocationBps,
    liquidityTokenAllocationBps: args.liquidityTokenAllocationBps,
    recipientAllocations: args.recipientAllocations,
    burnable: args.burnable,
    raiseTarget: args.raiseTarget,
    raiseAllocations: args.raiseAllocations,
    commitmentDurationMs: args.durationMs,
    liquidityWindowDurationMs: args.liquidityWindowMs,
    eligibility: args.eligibility,
    uncapped: args.uncapped,
    participantVesting: args.participantVesting,
    hardCap: args.hardCap,
    feeSplit: args.feeSplit,
    partner: null,
    capRecipient: creator,
    commitmentStartsAtMs: args.startMs,
  };
  if (args.venue === "bluefin") {
    return sdk.createPresale({ ...terms, venue: "bluefin", tickSpacing: args.tickSpacing, feeRate: args.poolFeeRate });
  }
  const cetus = identity.venues.cetus;
  if (!cetus) throw new RangeError("The deployment names no Cetus objects.");
  return sdk.createPresale({
    ...terms,
    venue: "cetus",
    tickSpacing: args.tickSpacing,
    cetus: { config: cetus.globalConfig, pools: cetus.pools },
  });
}
