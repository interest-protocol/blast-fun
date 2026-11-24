import { migratorsDeployment } from "@interest-protocol/blast-sdk/deployments";
import { MigratorsClient } from "@interest-protocol/blast-sdk/migrators";
import type { VaultState } from "@interest-protocol/blast-sdk/vault";
// The Cetus CLMM driver of the migrated-venue rail: everything venue-specific
// goes through the SDK's reviewed adapter (`@interest-protocol/blast-sdk/
// migrators`, `cetus-venue.ts`). The web writes no Cetus Move call: the quote
// transport simulates the SDK's own exact-input swap, and the executed
// transaction is the SDK's `buildCetusSwapTransaction`.

import type { BlastDeployment } from "@interest-protocol/blast-sdk/deployments";
import type { LaunchState } from "@interest-protocol/blast-sdk/launchpad";
import {
  buildCetusSwapTransaction,
  CetusVenueError,
  cetusVenuePrice,
  cetusVenueTrade,
  decodeCetusPoolObject,
  decodeCetusSwapEvent,
  normalizeCetusQuote,
  quoteCetusSwap,
  reconcileCetusSwap,
  resolveCetusVenueRoute,
  type CetusPoolState,
  type CetusProviderQuote,
  type CetusQuoteTransport,
  type CetusSwapFacts,
  type CetusVenueQuote,
  type CetusVenueRoute,
  type CetusVenueTrade,
} from "@interest-protocol/blast-sdk/migrators";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import type { Transaction } from "@mysten/sui/transactions";

import { describeError } from "../transaction/errors.ts";
import type { EnabledAccess, SimulatedTransaction } from "../transaction/preflight.ts";

/** How long after the provider quoted a Cetus quote may be signed. Cetus has no on-chain expiry; the minimum output protects on chain. */
export const CETUS_QUOTE_VALID_FOR_MS = 20_000n;
/** Transport attempts per quote: one retry after a transport failure, never after a refusal. */
export const CETUS_QUOTE_ATTEMPTS = 2;

/** The provider answered, and its answer is that it cannot quote this swap. Retrying cannot help. */
export class CetusQuoteRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CetusQuoteRefused";
  }
}

/** The provider could not be reached or did not answer after every attempt. */
export class CetusQuoteUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CetusQuoteUnavailable";
  }
}

export type CetusRecord = Readonly<{
  route: CetusVenueRoute;
  pool: CetusPoolState;
  /** The pool object's type and version as the node reported them. */
  poolType: string;
  poolVersion: string;
}>;

/** Reads the launch's recorded pool and resolves its route through the SDK; throws `CetusVenueError` on any mismatch. */
export async function resolveCetusRecord(
  client: ClientWithCoreApi,
  deployment: BlastDeployment,
  launch: LaunchState,
  vault: VaultState,
): Promise<CetusRecord> {
  const cetus = deployment.packages.cetusClmm;
  if (!cetus) throw new CetusVenueError("deployment-mismatch", "the deployment records no Cetus lineage");
  const { object } = await client.core.getObject({ objectId: vault.poolId, include: { content: true } });
  if (object.owner.$kind !== "Shared") throw new CetusVenueError("route-substitution", `pool ${object.objectId} is not a shared pool`);
  let pool: CetusPoolState;
  try {
    pool = decodeCetusPoolObject(
      { objectId: object.objectId, initialSharedVersion: object.owner.Shared.initialSharedVersion, type: object.type, content: object.content },
      cetus.originalPackageId,
    );
  } catch (error) {
    throw new CetusVenueError("foreign-lineage", describeError(error));
  }
  const poolTickSpacing = await new MigratorsClient(client, migratorsDeployment(deployment)).getCetusPoolTier(launch.memeType);
  if (poolTickSpacing === null) throw new CetusVenueError("unsupported-tier", "The sale has no recorded Cetus tier");
  const route = resolveCetusVenueRoute({ deployment, launch: { ...launch, poolTickSpacing, poolFeeRate: pool.feeRate }, vault, pool });
  return { route, pool, poolType: object.type, poolVersion: object.version };
}

/** The pool's current price, in Quote atoms per Meme atom. */
export function cetusPoolPrice(record: Pick<CetusRecord, "route" | "pool">) {
  return cetusVenuePrice(record.pool.currentSqrtPrice, record.route.memeIsCoinA);
}

function sideOf(route: CetusVenueRoute, a2b: boolean): "buy" | "sell" {
  return a2b === route.memeIsCoinA ? "sell" : "buy";
}

/**
 * A quote transport that asks Sui itself: it simulates the SDK's exact-input
 * swap (`buildCetusSwapTransaction` with a one-atom minimum) at the latest
 * pool state and reads the pool's `SwapEvent` through the SDK. A simulation
 * that Sui rejects is a refusal (the pool cannot fill it); a node that cannot
 * be asked is a transport failure.
 */
export function simulatedCetusQuoteTransport({
  client,
  access,
  pool,
  sender,
  balances,
  now = Date.now,
}: Readonly<{
  client: ClientWithCoreApi;
  access: EnabledAccess;
  pool: CetusPoolState;
  sender: string;
  balances: Readonly<{ quote: bigint; meme: bigint }>;
  now?: () => number;
}>): CetusQuoteTransport {
  return async ({ route, a2b, amount }) => {
    const quotedAtMs = BigInt(now());
    const probe = normalizeCetusQuote({
      route,
      pool,
      request: { side: sideOf(route, a2b), amountIn: amount, slippageBps: 0n, validForMs: CETUS_QUOTE_VALID_FOR_MS, sender, balances },
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
    const transaction = buildCetusSwapTransaction({ access, route, quote: probe, nowMs: quotedAtMs });
    transaction.setSender(sender);
    const bytes = await transaction.build({ client });
    const result = await client.core.simulateTransaction({ transaction: bytes, include: { effects: true, events: true } });
    const simulated = result.Transaction ?? result.FailedTransaction;
    if (result.$kind !== "Transaction" || !simulated.status.success) {
      const reason = simulated.status.success ? "the swap failed" : "the network rejected it";
      throw new CetusQuoteRefused(`The Cetus pool cannot fill this swap: ${reason}`);
    }
    const facts = reconcileCetusSwap({ digest: simulated.digest, status: simulated.status, events: simulated.events ?? [] }, probe);
    const event = (simulated.events ?? [])[facts.eventIndex]!;
    const swap = decodeCetusSwapEvent(event, route.cetusOriginalPackageId);
    return {
      poolId: swap.pool,
      a2b: swap.atob,
      byAmountIn: true,
      amountIn: swap.amountIn,
      amountOut: swap.amountOut,
      feeAmount: swap.feeAmount,
      afterSqrtPrice: swap.afterSqrtPrice,
      isExceed: false,
      quotedAtMs,
    } satisfies CetusProviderQuote;
  };
}

/** `transport` retried after a transport failure, up to `attempts` calls in all; a refusal or an SDK rejection is final. */
export function withQuoteRetries(transport: CetusQuoteTransport, attempts = CETUS_QUOTE_ATTEMPTS): CetusQuoteTransport {
  return async (request) => {
    let last: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await transport(request);
      } catch (error) {
        if (error instanceof CetusQuoteRefused || error instanceof CetusVenueError) throw error;
        last = error;
      }
    }
    throw new CetusQuoteUnavailable(`The Cetus quote provider did not answer: ${describeError(last)}`);
  };
}

/** One exact-input Cetus quote for the signer, normalized and checked by the SDK. */
export function quoteCetusTrade({
  record,
  side,
  amountIn,
  slippageBps,
  sender,
  balances,
  transport,
}: Readonly<{
  record: CetusRecord;
  side: "buy" | "sell";
  amountIn: bigint;
  slippageBps: bigint;
  sender: string;
  balances: Readonly<{ quote: bigint; meme: bigint }>;
  transport: CetusQuoteTransport;
}>): Promise<CetusVenueQuote> {
  return quoteCetusSwap({
    route: record.route,
    pool: record.pool,
    request: { side, amountIn, slippageBps, validForMs: CETUS_QUOTE_VALID_FOR_MS, sender, balances: { ...balances } },
    transport: withQuoteRetries(transport),
  });
}

/** The SDK-built swap for `quote`; refuses an expired quote, another deployment, or an unavailable Cetus. */
export function buildCetusTrade(access: EnabledAccess, quote: CetusVenueQuote, nowMs: number): Transaction {
  return buildCetusSwapTransaction({ access, route: quote.route, quote, nowMs: BigInt(nowMs) });
}

/** Whether a simulated or completed transaction is exactly the quoted swap (the SDK's reconciliation). */
export function reconcileCetusTrade(transaction: SimulatedTransaction, quote: CetusVenueQuote): CetusSwapFacts {
  return reconcileCetusSwap(transaction, quote);
}

/** What a completed transaction's one swap in the route's pool did, from its `SwapEvent`; null when it holds none. */
export function readCetusSwap(transaction: SimulatedTransaction, route: CetusVenueRoute): CetusVenueTrade | null {
  if (!transaction.status.success) return null;
  for (const event of transaction.events) {
    try {
      const swap = decodeCetusSwapEvent(event, route.cetusOriginalPackageId);
      if (swap.pool === route.pool.objectId) return cetusVenueTrade(swap, route.memeIsCoinA);
    } catch {
      // Another package's event: not this pool's swap.
    }
  }
  return null;
}
