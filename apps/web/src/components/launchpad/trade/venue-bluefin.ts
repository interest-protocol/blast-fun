import { migratorsDeployment } from "@interest-protocol/blast-sdk/deployments";
import { MigratorsClient } from "@interest-protocol/blast-sdk/migrators";
import type { VaultState } from "@interest-protocol/blast-sdk/vault";
// The Bluefin Spot driver of the migrated-venue rail, the counterpart of
// `venue-cetus.ts`: everything venue-specific goes through the SDK's reviewed
// adapter (`@interest-protocol/blast-sdk/migrators`, `bluefin-venue.ts`). The
// web writes no Bluefin Move call: the quote transport simulates the SDK's own
// exact-input swap, and the executed transaction is the SDK's
// `buildBluefinSwapTransaction`. A Bluefin pool is always `Pool<Meme, Quote>`,
// so the Meme is coin A.

import type { BlastDeployment } from "@interest-protocol/blast-sdk/deployments";
import type { LaunchState } from "@interest-protocol/blast-sdk/launchpad";
import {
  bluefinVenuePrice,
  bluefinVenueTrade,
  BluefinVenueError,
  buildBluefinSwapTransaction,
  decodeBluefinPoolObject,
  decodeBluefinSwapEvent,
  normalizeBluefinQuote,
  quoteBluefinSwap,
  reconcileBluefinSwap,
  resolveBluefinVenueRoute,
  type BluefinPoolState,
  type BluefinProviderQuote,
  type BluefinQuoteTransport,
  type BluefinSwapFacts,
  type BluefinVenueQuote,
  type BluefinVenueRoute,
  type BluefinVenueTrade,
} from "@interest-protocol/blast-sdk/migrators";
import { SimulationError, type ClientWithCoreApi } from "@mysten/sui/client";
import type { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils";

import { describeError } from "../transaction/errors.ts";
import type { EnabledAccess, SimulatedTransaction } from "../transaction/preflight.ts";
import { atomsGrouped } from "@blast/core/web/format.ts";

/** How long after the provider quoted a Bluefin quote may be signed; the SDK's builder refuses it from then on, and the minimum output protects on chain. */
export const BLUEFIN_QUOTE_VALID_FOR_MS = 20_000n;
/** Transport attempts per quote: one retry after a transport failure, never after a refusal. */
export const BLUEFIN_QUOTE_ATTEMPTS = 2;

/** The provider answered, and its answer is that it cannot quote this swap. Retrying cannot help. */
export class BluefinQuoteRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BluefinQuoteRefused";
  }
}

/** The provider could not be reached or did not answer after every attempt. */
export class BluefinQuoteUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BluefinQuoteUnavailable";
  }
}

export type BluefinRecord = Readonly<{
  route: BluefinVenueRoute;
  pool: BluefinPoolState;
  /** The pool object's type and version as the node reported them. */
  poolType: string;
  poolVersion: string;
}>;

/** The recorded pool is not in the Bluefin Spot layout this app's SDK decodes: an unsupported route until the SDK is updated. */
export class BluefinPoolLayoutUnsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BluefinPoolLayoutUnsupported";
  }
}

const percent = (feeRate: bigint) => `${atomsGrouped(feeRate, 4)}%`;

/**
 * Reads the launch's recorded Bluefin pool and resolves its route through the
 * SDK; throws `BluefinVenueError` on any mismatch and
 * `BluefinPoolLayoutUnsupported` for a pool it cannot decode. Two limits fail
 * closed: the pool is decoded in Bluefin Spot v17's whole layout, so a
 * Bluefin layout change refuses every Bluefin pool until the SDK is updated;
 * and the pool's fee rate must equal the launch's recorded fee, so a Bluefin
 * fee change closes that launch's route.
 */
export async function resolveBluefinRecord(
  client: ClientWithCoreApi,
  deployment: BlastDeployment,
  launch: LaunchState,
  vault: VaultState,
): Promise<BluefinRecord> {
  const bluefin = deployment.packages.bluefinSpot;
  if (!bluefin) throw new BluefinVenueError("deployment-mismatch", "the deployment records no Bluefin Spot lineage");
  const { object } = await client.core.getObject({ objectId: vault.poolId, include: { content: true } });
  if (object.owner.$kind !== "Shared") throw new BluefinVenueError("route-substitution", `pool ${object.objectId} is not a shared pool`);
  const tag = parseStructTag(object.type);
  if (tag.address !== normalizeSuiAddress(bluefin.originalPackageId) || tag.module !== "pool" || tag.name !== "Pool") {
    throw new BluefinVenueError("foreign-lineage", `pool ${object.objectId} is a ${object.type}, not a pool of the deployment's Bluefin Spot`);
  }
  let pool: BluefinPoolState;
  try {
    pool = decodeBluefinPoolObject(
      { objectId: object.objectId, initialSharedVersion: object.owner.Shared.initialSharedVersion, type: object.type, content: object.content },
      bluefin.originalPackageId,
    );
  } catch (error) {
    throw new BluefinPoolLayoutUnsupported(
      `The recorded Bluefin pool ${object.objectId} is not in the Bluefin Spot v17 layout this app reads (${describeError(error)}). Bluefin trading stays closed until the app is updated; nothing can be signed.`,
    );
  }
  const tier = await new MigratorsClient(client, migratorsDeployment(deployment)).getBluefinPoolTier(launch.memeType);
  if (!tier) throw new BluefinVenueError("unsupported-tier", "The sale has no recorded Bluefin tier");
  if (pool.feeRate !== tier.feeRate) {
    throw new BluefinVenueError(
      "route-substitution",
      `Bluefin now charges ${percent(pool.feeRate)} in pool ${pool.objectId}, not the ${percent(tier.feeRate)} the launch recorded, so its route is closed`,
    );
  }
  const route = resolveBluefinVenueRoute({ deployment, launch: { ...launch, poolTickSpacing: tier.tickSpacing, poolFeeRate: tier.feeRate }, vault, pool });
  return { route, pool, poolType: object.type, poolVersion: object.version };
}

/** The pool's current price, in Quote atoms per Meme atom (the Meme is coin A). */
export function bluefinPoolPrice(record: Pick<BluefinRecord, "pool">) {
  return bluefinVenuePrice(record.pool.currentSqrtPrice);
}

/**
 * The Bluefin provider quote transport (`BluefinQuoteTransport`): it asks Sui
 * itself, simulating the SDK's exact-input swap (`buildBluefinSwapTransaction`
 * with a one-atom minimum) at the latest pool state and reading the pool's
 * `AssetSwap` through the SDK. A simulation that Sui rejects is a refusal (the
 * pool cannot fill it); a node that cannot be asked is a transport failure.
 */
export function simulatedBluefinQuoteTransport({
  client,
  access,
  pool,
  sender,
  balances,
  now = Date.now,
}: Readonly<{
  client: ClientWithCoreApi;
  access: EnabledAccess;
  pool: BluefinPoolState;
  sender: string;
  balances: Readonly<{ quote: bigint; meme: bigint }>;
  now?: () => number;
}>): BluefinQuoteTransport {
  return async ({ route, a2b, amount }) => {
    const quotedAtMs = BigInt(now());
    const probe = normalizeBluefinQuote({
      route,
      pool,
      request: { side: a2b ? "sell" : "buy", amountIn: amount, slippageBps: 0n, validForMs: BLUEFIN_QUOTE_VALID_FOR_MS, sender, balances: { ...balances } },
      providerQuote: {
        poolId: route.pool.objectId,
        a2b,
        byAmountIn: true,
        amountIn: amount,
        amountOut: 1n,
        feeAmount: 0n,
        afterSqrtPrice: null,
        isExceed: false,
        quotedAtMs,
      },
    });
    const transaction = buildBluefinSwapTransaction({ access, route, quote: probe, nowMs: quotedAtMs });
    transaction.setSender(sender);
    let bytes: Uint8Array;
    try {
      bytes = await transaction.build({ client });
    } catch (error) {
      // Building without a gas budget simulates the swap: a swap that fails there is the pool's refusal.
      if (error instanceof SimulationError && error.executionError) throw new BluefinQuoteRefused("The Bluefin pool cannot fill this swap");
      throw error;
    }
    const result = await client.core.simulateTransaction({ transaction: bytes, include: { effects: true, events: true } });
    const simulated = result.Transaction ?? result.FailedTransaction;
    if (result.$kind !== "Transaction" || !simulated.status.success) {
      throw new BluefinQuoteRefused("The Bluefin pool cannot fill this swap");
    }
    const facts = reconcileBluefinSwap({ digest: simulated.digest, status: simulated.status, events: simulated.events ?? [] }, probe);
    const swap = decodeBluefinSwapEvent((simulated.events ?? [])[facts.eventIndex]!, route.bluefinOriginalPackageId);
    return {
      poolId: swap.pool,
      a2b: swap.a2b,
      byAmountIn: true,
      amountIn: swap.amountIn,
      amountOut: swap.amountOut,
      feeAmount: swap.fee,
      afterSqrtPrice: swap.afterSqrtPrice,
      isExceed: swap.exceeded,
      quotedAtMs,
    } satisfies BluefinProviderQuote;
  };
}

/** `transport` retried after a transport failure, up to `attempts` calls in all; a refusal or an SDK rejection is final. */
export function withBluefinQuoteRetries(transport: BluefinQuoteTransport, attempts = BLUEFIN_QUOTE_ATTEMPTS): BluefinQuoteTransport {
  return async (request) => {
    let last: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await transport(request);
      } catch (error) {
        if (error instanceof BluefinQuoteRefused || error instanceof BluefinVenueError) throw error;
        last = error;
      }
    }
    throw new BluefinQuoteUnavailable(`The Bluefin quote provider did not answer: ${describeError(last)}`);
  };
}

/** One exact-input Bluefin quote for the signer, normalized and checked by the SDK. */
export function quoteBluefinTrade({
  record,
  side,
  amountIn,
  slippageBps,
  sender,
  balances,
  transport,
}: Readonly<{
  record: BluefinRecord;
  side: "buy" | "sell";
  amountIn: bigint;
  slippageBps: bigint;
  sender: string;
  balances: Readonly<{ quote: bigint; meme: bigint }>;
  transport: BluefinQuoteTransport;
}>): Promise<BluefinVenueQuote> {
  return quoteBluefinSwap({
    route: record.route,
    pool: record.pool,
    request: { side, amountIn, slippageBps, validForMs: BLUEFIN_QUOTE_VALID_FOR_MS, sender, balances: { ...balances } },
    transport: withBluefinQuoteRetries(transport),
  });
}

/** The SDK-built swap for `quote`; refuses an expired quote, another deployment, or an unavailable Bluefin. */
export function buildBluefinTrade(access: EnabledAccess, quote: BluefinVenueQuote, nowMs: number): Transaction {
  return buildBluefinSwapTransaction({ access, route: quote.route, quote, nowMs: BigInt(nowMs) });
}

/** Whether a simulated or completed transaction is exactly the quoted swap (the SDK's reconciliation). */
export function reconcileBluefinTrade(transaction: SimulatedTransaction, quote: BluefinVenueQuote): BluefinSwapFacts {
  return reconcileBluefinSwap(transaction, quote);
}

/** What a completed transaction's one swap in the route's pool did, from its `AssetSwap`; null when it holds none. */
export function readBluefinSwap(transaction: SimulatedTransaction, route: BluefinVenueRoute): BluefinVenueTrade | null {
  if (!transaction.status.success) return null;
  for (const event of transaction.events) {
    try {
      const swap = decodeBluefinSwapEvent(event, route.bluefinOriginalPackageId);
      if (swap.pool === route.pool.objectId) return bluefinVenueTrade(swap);
    } catch {
      // Another package's event: not this pool's swap.
    }
  }
  return null;
}
