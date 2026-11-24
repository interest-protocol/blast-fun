import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import type { Transaction, TransactionObjectArgument } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

import { blastTradeFeeAtoms, type BlastTradeFee } from "@blast/core/lib/blast-trade-fee.ts";
import { AFTERMATH_DAO, AFTERMATH_DAO_SWAP } from "@blast/core/modules/sponsor/aftermath-dao.ts";
import { grossForNetOut, TRADE_ROUTE_MAX_PATHS, type TradePath, type TradeRoute, type TradeRouteAnswer, type TradeRouter, type TradeRouteRequest } from "@blast/server/modules/social/trades/aggregator.ts";
import { minOut } from "@blast/core/modules/social/trades/amounts.ts";

/**
 * Aftermath DAO-fee pools (contracts ADR 0104): a Blast sale that migrates
 * through the Aftermath vendor trades in a `DaoFeePool<Lp>`, Aftermath's
 * wrapper around its AMM pool that takes the sale's DAO fee from every swap's
 * input. The Cetus aggregator does not route these wrappers (its Aftermath
 * adapter swaps the plain AMM pool, which the wrapper holds as a dynamic
 * object field and no transaction can name), so the app calls the wrapper
 * directly: `swap::swap_exact_in` of Aftermath's DAO-fee package, the one
 * entry point the wrapper exposes for an exact-in swap.
 *
 * Everything else is the trade path's own: the quote is this module's
 * `TradeRoute` (a leg with provider `AFTERMATH_DAO`), dry-run, sealed and
 * executed as any route is. USDC or SUI that is not the pool's own quote coin
 * is converted through the Cetus aggregator, fee-less, before or after the
 * DAO leg. Blast's fee (`BLAST_TRADE_FEE_BPS`) is taken from the final
 * output, at the quoted amount, by a `SplitCoins` and a `TransferObjects` to
 * the fee receiver, since no Cetus swap context carries it here.
 *
 * Every object, package and type is pinned in `@blast/core/modules/sponsor/aftermath-dao.ts`,
 * whose call the sponsor's trade policy admits exactly.
 */

/** A route leg through a DAO-fee pool. Its `poolId` is the `DaoFeePool` wrapper. */
export const AFTERMATH_DAO_PROVIDER = "AFTERMATH_DAO";
/** The AMM's abort for a fill below `expected_coin_out × (1 − allowable_slippage)`. */
export const AFTERMATH_SLIPPAGE_ABORT = Object.freeze({ package: AFTERMATH_DAO.ammPackage, module: "swap", code: 48 });

/** Aftermath's fixed-point one: weights, fees and the protocol fee are fractions of it. */
const FIXED_ONE = 10n ** 18n;
const HALF = FIXED_ONE / 2n;
const BPS = 10_000n;

const DaoFeePoolBcs = bcs.struct("DaoFeePool", {
  id: bcs.Address,
  pool_id: bcs.Address,
  fee_bps: bcs.u16(),
  fee_recipient: bcs.Address,
});

const PoolBcs = bcs.struct("Pool", {
  id: bcs.Address,
  name: bcs.string(),
  creator: bcs.Address,
  lp_supply: bcs.u64(),
  illiquid_lp_supply: bcs.u64(),
  type_names: bcs.vector(bcs.string()),
  normalized_balances: bcs.vector(bcs.u128()),
  weights: bcs.vector(bcs.u64()),
  flatness: bcs.u64(),
  fees_swap_in: bcs.vector(bcs.u64()),
  fees_swap_out: bcs.vector(bcs.u64()),
  fees_deposit: bcs.vector(bcs.u64()),
  fees_withdraw: bcs.vector(bcs.u64()),
  coin_decimals: bcs.option(bcs.vector(bcs.u8())),
  decimal_scalars: bcs.vector(bcs.u128()),
  lp_decimals: bcs.u8(),
  lp_decimal_scalar: bcs.u128(),
});

const ProtocolFeeVaultBcs = bcs.struct("ProtocolFeeVault", {
  id: bcs.Address,
  version: bcs.u64(),
  dev_wallet: bcs.Address,
  fee_percentages: bcs.struct("FeePercentages", {
    total_protocol_fee: bcs.u64(),
    treasury: bcs.u64(),
    insurance_fund: bcs.u64(),
    dev_wallet: bcs.u64(),
    referee_discount: bcs.u64(),
  }),
});

/**
 * A DAO-fee pool as the quote needs it: a two-coin, evenly weighted,
 * constant-product pool (flatness 0), which is what the Blast vendor creates.
 * Balances are the AMM's own, normalized: atoms × the coin's scalar.
 */
export type AftermathDaoPool = Readonly<{
  /** The `DaoFeePool` wrapper, the swap's shared object. */
  wrapperId: string;
  /** The AMM pool inside it (`chain_read_v1.presales.pool_id`). */
  poolId: string;
  /** The pool's LP coin, the swap's first type argument. */
  lpType: string;
  coins: readonly [string, string];
  normalizedBalances: readonly [bigint, bigint];
  /** Each coin's atoms → normalized factor (`decimal_scalars`). */
  scalars: readonly [bigint, bigint];
  /** The DAO fee, in basis points of the input. */
  daoFeeBps: number;
  /** Aftermath's protocol fee, a fraction of `FIXED_ONE` of what is left of the input. */
  protocolFee: bigint;
  /** Its treasury, insurance-fund and dev-wallet shares, fractions of `FIXED_ONE` of it, each split off on its own. */
  protocolFeeShares: readonly [bigint, bigint, bigint];
  feesSwapIn: readonly [bigint, bigint];
  feesSwapOut: readonly [bigint, bigint];
}>;

/** Reads DAO-fee pools by their AMM pool id. Rejects when the fullnode cannot answer. */
export interface AftermathDaoPools {
  /** The pool, or null when `poolId` is not an AMM pool inside a DAO-fee wrapper this module can quote. */
  read(poolId: string, signal?: AbortSignal): Promise<AftermathDaoPool | null>;
}

type ObjectOwner = Readonly<{ $kind: string; ObjectOwner?: string }>;

function parentOf(owner: ObjectOwner | undefined): string | null {
  return owner?.$kind === "ObjectOwner" && typeof owner.ObjectOwner === "string" ? normalizeSuiAddress(owner.ObjectOwner) : null;
}

const typeOf = (name: string) => normalizeStructTag(name.startsWith("0x") ? name : `0x${name}`);

/**
 * The pool from its three objects, or null when it is not one this module
 * quotes: another wrapper type, a wrapper over another pool, or a pool that
 * is not two coins at even weights with flatness 0.
 */
export function parseAftermathDaoPool(input: Readonly<{
  poolId: string;
  poolType: string;
  pool: Uint8Array;
  wrapperId: string;
  wrapperType: string;
  wrapper: Uint8Array;
  vaultType: string;
  vault: Uint8Array;
}>): AftermathDaoPool | null {
  const wrapperType = /^(0x[0-9a-f]+)::pool::DaoFeePool<(.+)>$/.exec(normalizeStructTag(input.wrapperType));
  const poolType = /^(0x[0-9a-f]+)::pool::Pool<(.+)>$/.exec(normalizeStructTag(input.poolType));
  if (!wrapperType || normalizeSuiAddress(wrapperType[1]!) !== AFTERMATH_DAO.typeOrigin) return null;
  if (!poolType || normalizeSuiAddress(poolType[1]!) !== AFTERMATH_DAO.ammTypeOrigin || poolType[2] !== wrapperType[2]) return null;
  if (normalizeStructTag(input.vaultType) !== normalizeStructTag(AFTERMATH_DAO.vaultType)) return null;
  const wrapper = DaoFeePoolBcs.parse(input.wrapper);
  const pool = PoolBcs.parse(input.pool);
  const vault = ProtocolFeeVaultBcs.parse(input.vault);
  if (normalizeSuiAddress(wrapper.pool_id) !== normalizeSuiAddress(input.poolId) || normalizeSuiAddress(pool.id) !== normalizeSuiAddress(input.poolId)) return null;
  if (pool.type_names.length !== 2 || pool.normalized_balances.length !== 2 || pool.decimal_scalars.length !== 2) return null;
  if (pool.weights.length !== 2 || BigInt(pool.weights[0]!) !== HALF || BigInt(pool.weights[1]!) !== HALF || BigInt(pool.flatness) !== 0n) return null;
  if (pool.fees_swap_in.length !== 2 || pool.fees_swap_out.length !== 2) return null;
  const pair = <T>(values: readonly T[], map: (value: T) => bigint) => [map(values[0]!), map(values[1]!)] as const;
  const scalars = pair(pool.decimal_scalars, BigInt);
  if (scalars[0] === 0n || scalars[1] === 0n) return null;
  const normalized = pair(pool.normalized_balances, BigInt);
  const shares = [vault.fee_percentages.treasury, vault.fee_percentages.insurance_fund, vault.fee_percentages.dev_wallet].map(BigInt);
  const fees = [...pair(pool.fees_swap_in, BigInt), ...pair(pool.fees_swap_out, BigInt), BigInt(vault.fee_percentages.total_protocol_fee)];
  if (fees.some((fee) => fee < 0n || fee >= FIXED_ONE) || wrapper.fee_bps >= Number(BPS)) return null;
  if (shares.some((share) => share < 0n) || shares[0]! + shares[1]! + shares[2]! !== FIXED_ONE) return null;
  return {
    wrapperId: normalizeSuiAddress(input.wrapperId),
    poolId: normalizeSuiAddress(input.poolId),
    lpType: normalizeStructTag(wrapperType[2]!),
    coins: [typeOf(pool.type_names[0]!), typeOf(pool.type_names[1]!)],
    normalizedBalances: normalized,
    scalars,
    daoFeeBps: wrapper.fee_bps,
    protocolFee: fees[4]!,
    protocolFeeShares: [shares[0]!, shares[1]!, shares[2]!],
    feesSwapIn: [fees[0]!, fees[1]!],
    feesSwapOut: [fees[2]!, fees[3]!],
  };
}

/**
 * DAO-fee pools from the fullnode. The AMM pool is a dynamic object field of
 * its wrapper, so it is owned by the field object, which the wrapper owns:
 * the first read walks that chain up once, and the wrapper id is kept (a
 * pool never changes wrapper). Each quote then reads the pool, the wrapper
 * and the protocol fee vault in one request.
 */
export function fullnodeAftermathDaoPools(client: ClientWithCoreApi): AftermathDaoPools {
  const wrappers = new Map<string, string>();
  const ownerOf = async (objectId: string, signal?: AbortSignal) => parentOf((await client.core.getObject({ objectId, signal })).object.owner as ObjectOwner);
  return Object.freeze({
    async read(poolId: string, signal?: AbortSignal) {
      const id = normalizeSuiAddress(poolId);
      let wrapperId = wrappers.get(id);
      if (wrapperId === undefined) {
        const field = await ownerOf(id, signal);
        const wrapper = field && (await ownerOf(field, signal));
        if (!wrapper) return null;
        wrapperId = wrapper;
      }
      const { objects } = await client.core.getObjects({ objectIds: [id, wrapperId, AFTERMATH_DAO.vault], include: { content: true }, signal });
      const [pool, wrapper, vault] = objects;
      if (!pool || pool instanceof Error || !wrapper || wrapper instanceof Error || !vault || vault instanceof Error) {
        throw new Error("The fullnode did not answer the pool's objects.");
      }
      const parsed = parseAftermathDaoPool({
        poolId: id,
        poolType: pool.type,
        pool: pool.content,
        wrapperId,
        wrapperType: wrapper.type,
        wrapper: wrapper.content,
        vaultType: vault.type,
        vault: vault.content,
      });
      if (parsed) wrappers.set(id, wrapperId);
      return parsed;
    },
  });
}

/**
 * What `swap_exact_in` gives for `amountIn` of coin `from` (0 or 1), as the
 * AMM computes it, each fee rounded down: the DAO fee off the input and
 * Aftermath's protocol fee off what is left, both in atoms (each is split
 * off the coin, the protocol fee as its three shares); then, normalized, the pool's swap-in fee, the
 * constant-product output and its swap-out fee; then the output in atoms,
 * rounded down. 0 when nothing would come out.
 */
export function aftermathDaoSwapOut(pool: AftermathDaoPool, from: 0 | 1, amountIn: bigint): bigint {
  if (amountIn <= 0n) return 0n;
  const to = from === 0 ? 1 : 0;
  const afterDao = amountIn - (amountIn * BigInt(pool.daoFeeBps)) / BPS;
  const protocolFee = (afterDao * pool.protocolFee) / FIXED_ONE;
  const afterProtocol = afterDao - pool.protocolFeeShares.reduce((sum, share) => sum + (protocolFee * share) / FIXED_ONE, 0n);
  const normalizedIn = afterProtocol * pool.scalars[from];
  const effective = normalizedIn - (normalizedIn * pool.feesSwapIn[from]) / FIXED_ONE;
  const balanceIn = pool.normalizedBalances[from];
  const balanceOut = pool.normalizedBalances[to];
  if (effective <= 0n || balanceIn + effective <= 0n) return 0n;
  const out = (balanceOut * effective) / (balanceIn + effective);
  return (out - (out * pool.feesSwapOut[to]) / FIXED_ONE) / pool.scalars[to];
}

/**
 * The least input of coin `from` that `aftermathDaoSwapOut` turns into at
 * least `amountOut`, or null when the pool cannot give that much (or it
 * would take more than a u64).
 */
export function aftermathDaoSwapIn(pool: AftermathDaoPool, from: 0 | 1, amountOut: bigint): bigint | null {
  if (amountOut <= 0n) return 0n;
  const U64_MAX = 18_446_744_073_709_551_615n;
  if (aftermathDaoSwapOut(pool, from, U64_MAX) < amountOut) return null;
  let low = 1n;
  let high = U64_MAX;
  while (low < high) {
    const mid = (low + high) / 2n;
    if (aftermathDaoSwapOut(pool, from, mid) >= amountOut) high = mid;
    else low = mid + 1n;
  }
  return low;
}

/**
 * The pool's fee on a leg, as the decimal fraction of its input a route leg
 * carries: `1 − (1 − dao)(1 − protocol)(1 − swap in)(1 − swap out)`, to 18
 * places, rounded down.
 */
export function aftermathDaoFeeRate(pool: AftermathDaoPool, from: 0 | 1): string {
  const to = from === 0 ? 1 : 0;
  const kept = (BPS - BigInt(pool.daoFeeBps)) * (FIXED_ONE - pool.protocolFee) * (FIXED_ONE - pool.feesSwapIn[from]) * (FIXED_ONE - pool.feesSwapOut[to]);
  const whole = BPS * FIXED_ONE * FIXED_ONE * FIXED_ONE;
  const fee = ((whole - kept) * FIXED_ONE) / whole;
  return fee === 0n ? "0" : `0.${fee.toString().padStart(18, "0").replace(/0+$/, "")}`;
}

/** Whether a route goes through a DAO-fee pool, so `aftermathDaoRouter` builds it. */
export function isAftermathDaoRoute(route: TradeRoute): boolean {
  return route.paths.some((path) => path.provider === AFTERMATH_DAO_PROVIDER);
}

/**
 * The router for sale coins in DAO-fee pools. `base` routes the USDC or SUI
 * leg that is not the pool's own quote coin; it must charge no fee (Blast's
 * fee is this router's, `fee`).
 */
export function createAftermathDaoRouter(input: Readonly<{
  pools: AftermathDaoPools;
  base: TradeRouter;
  fee: BlastTradeFee | null;
}>): TradeRouter {
  const { pools, base } = input;
  const fee = input.fee ?? null;
  if (base.fee !== null) throw new Error("The Aftermath router's base router must charge no fee.");

  async function exactIn(request: TradeRouteRequest, pool: AftermathDaoPool, sale: 0 | 1): Promise<TradeRouteAnswer> {
    const paired = sale === 0 ? 1 : 0;
    const buying = request.target === pool.coins[sale];
    const outer = buying ? request.from : request.target;
    let prefix: TradeRoute | null = null;
    let daoIn = request.amount;
    if (buying && outer !== pool.coins[paired]) {
      const answer = await base.findRoute({ from: outer, target: pool.coins[paired], amount: request.amount, byAmountIn: true, signal: request.signal });
      if (answer.status !== "route") return answer;
      prefix = answer.route;
      daoIn = prefix.amountOut;
    }
    const from: 0 | 1 = buying ? paired : sale;
    const daoOut = aftermathDaoSwapOut(pool, from, daoIn);
    if (daoOut <= 0n) return { status: "no_route" };
    let suffix: TradeRoute | null = null;
    let gross = daoOut;
    if (!buying && outer !== pool.coins[paired]) {
      const answer = await base.findRoute({ from: pool.coins[paired], target: outer, amount: daoOut, byAmountIn: true, signal: request.signal });
      if (answer.status !== "route") return answer;
      suffix = answer.route;
      gross = suffix.amountOut;
    }
    const blastFee = blastTradeFeeAtoms(gross, fee);
    if (gross - blastFee <= 0n) return { status: "no_route" };
    const leg: TradePath = {
      poolId: pool.wrapperId,
      provider: AFTERMATH_DAO_PROVIDER,
      direction: from === 0,
      from: pool.coins[from],
      target: pool.coins[from === 0 ? 1 : 0],
      feeRate: aftermathDaoFeeRate(pool, from),
      amountIn: daoIn,
      amountOut: daoOut,
      publishedAt: AFTERMATH_DAO.package,
      lpType: pool.lpType,
    };
    const cetus = prefix ?? suffix;
    const paths = [...(prefix?.paths ?? []), leg, ...(suffix?.paths ?? [])];
    if (paths.length > TRADE_ROUTE_MAX_PATHS) return { status: "no_route" };
    return {
      status: "route",
      route: {
        requestId: cetus?.requestId ?? "",
        amountIn: request.amount,
        amountOut: gross - blastFee,
        paths,
        // The Cetus leg's aggregator, whose slippage abort the dry run reads; the DAO package with none.
        aggregatorPackage: cetus?.aggregatorPackage ?? AFTERMATH_DAO.package,
        deviationRatio: null,
        blastFee,
      },
    };
  }

  async function buyInput(request: TradeRouteRequest, pool: AftermathDaoPool, paired: 0 | 1, outer: string, gross: bigint): Promise<bigint | TradeRouteAnswer> {
    const daoIn = aftermathDaoSwapIn(pool, paired, gross);
    if (daoIn === null) return { status: "no_route" } as const;
    if (outer === pool.coins[paired]) return daoIn;
    else {
      const answer = await base.findRoute({ from: outer, target: pool.coins[paired], amount: daoIn, byAmountIn: false, signal: request.signal });
      if (answer.status !== "route") return answer;
      return answer.route.amountIn;
    }
  }

  /** The input that buys `request.amount` of the target after Blast's fee, then that input exact-in. */
  async function exactOut(request: TradeRouteRequest, pool: AftermathDaoPool, sale: 0 | 1): Promise<TradeRouteAnswer> {
    const paired = sale === 0 ? 1 : 0;
    const buying = request.target === pool.coins[sale];
    const outer = buying ? request.from : request.target;
    const gross = grossForNetOut(request.amount, fee);
    let amountIn: bigint | null;
    if (buying) {
      const input = await buyInput(request, pool, paired, outer, gross);
      if (typeof input !== "bigint") return input;
      amountIn = input;
    } else {
      let need = gross;
      if (outer !== pool.coins[paired]) {
        const answer = await base.findRoute({ from: pool.coins[paired], target: outer, amount: gross, byAmountIn: false, signal: request.signal });
        if (answer.status !== "route") return answer;
        need = answer.route.amountIn;
      }
      amountIn = aftermathDaoSwapIn(pool, sale, need);
    }
    if (amountIn === null || amountIn <= 0n) return { status: "no_route" };
    return exactIn({ ...request, amount: amountIn, byAmountIn: true }, pool, sale);
  }

  const router: TradeRouter = {
    fee,
    async findRoute(request: TradeRouteRequest): Promise<TradeRouteAnswer> {
      const binding = request.aftermath;
      if (!binding) return { status: "no_route" };
      let pool: AftermathDaoPool | null;
      try {
        pool = await pools.read(binding.poolId, request.signal);
      } catch {
        return { status: "unavailable", reason: "aftermath_pool_read" };
      }
      if (!pool) return { status: "unavailable", reason: "aftermath_pool_unsupported" };
      const sale = pool.coins.indexOf(binding.coinType);
      if (sale !== 0 && sale !== 1) return { status: "unavailable", reason: "aftermath_pool_coin" };
      if (request.from !== binding.coinType && request.target !== binding.coinType) return { status: "no_route" };
      if (request.from === request.target) return { status: "no_route" };
      try {
        return request.byAmountIn ? await exactIn(request, pool, sale) : await exactOut(request, pool, sale);
      } catch {
        return { status: "unavailable", reason: "error" };
      }
    },
    /**
     * The route's legs: a Cetus prefix, the DAO-fee swap, a Cetus suffix
     * (either or both absent), then Blast's fee off the output. The DAO swap
     * that ends the route expects the quote's minimum plus the fee with no
     * slippage of its own; one that feeds a Cetus suffix expects its leg's
     * output less the slippage, and the suffix's context expects the
     * minimum plus the fee with none. The suffix scales that limit to its
     * actual input, so check the absolute net minimum after the fee as well.
     * A Cetus prefix keeps the slippage on its own output.
     */
    async appendSwap(tx: Transaction, route: TradeRoute, inputCoin: TransactionObjectArgument, slippageBps: number) {
      if (route.blastFee !== blastTradeFeeAtoms(route.amountOut + route.blastFee, fee)) {
        throw new Error("The route was priced with another Blast fee than this router charges.");
      }
      const at = route.paths.findIndex((path) => path.provider === AFTERMATH_DAO_PROVIDER);
      const leg = route.paths[at];
      if (!leg || route.paths.findLastIndex((path) => path.provider === AFTERMATH_DAO_PROVIDER) !== at) {
        throw new Error("An Aftermath route has exactly one DAO-fee leg.");
      }
      if (!leg.lpType || normalizeSuiAddress(leg.publishedAt) !== AFTERMATH_DAO.package) throw new Error("The DAO-fee leg is not Aftermath's pinned swap.");
      const prefix = route.paths.slice(0, at);
      const suffix = route.paths.slice(at + 1);
      const minimum = minOut(route.amountOut, slippageBps);
      const grossMinimum = minimum + route.blastFee;
      const cetus = (paths: readonly TradePath[], amountIn: bigint, amountOut: bigint): TradeRoute => ({ ...route, amountIn, amountOut, paths, blastFee: 0n, deviationRatio: null });
      let coin = inputCoin;
      if (prefix.length > 0) coin = await base.appendSwap(tx, cetus(prefix, route.amountIn, leg.amountIn), coin, slippageBps);
      coin = tx.moveCall({
        target: `${AFTERMATH_DAO.package}::${AFTERMATH_DAO_SWAP}`,
        typeArguments: [leg.lpType, leg.from, leg.target],
        arguments: [
          tx.object(leg.poolId),
          tx.object(AFTERMATH_DAO.version),
          tx.object(AFTERMATH_DAO.registry),
          tx.object(AFTERMATH_DAO.vault),
          tx.object(AFTERMATH_DAO.treasury),
          tx.object(AFTERMATH_DAO.insuranceFund),
          tx.object(AFTERMATH_DAO.referralVault),
          coin,
          tx.pure.u64(suffix.length > 0 ? minOut(leg.amountOut, slippageBps) : grossMinimum),
          tx.pure.u64(0n),
        ],
      });
      if (suffix.length > 0) coin = await base.appendSwap(tx, cetus(suffix, leg.amountOut, grossMinimum), coin, 0);
      if (fee !== null && route.blastFee > 0n) {
        const [cut] = tx.splitCoins(coin, [tx.pure.u64(route.blastFee)]);
        tx.transferObjects([cut!], fee.receiver);
      }
      if (suffix.length > 0) {
        const [payout] = tx.splitCoins(coin, [tx.pure.u64(minimum)]);
        tx.mergeCoins(coin, [payout!]);
      }
      return coin;
    },
  };
  return Object.freeze(router);
}

/**
 * The app's router: a request that names an Aftermath binding goes to
 * `aftermath`, any other to `cetus` (Cetus and Bluefin, with Blast's fee as
 * the aggregator's overlay); a route is built by the router that found it.
 */
export function routeByVenue(cetus: TradeRouter, aftermath: TradeRouter): TradeRouter {
  if (cetus.fee?.ppm !== aftermath.fee?.ppm || cetus.fee?.receiver !== aftermath.fee?.receiver) {
    throw new Error("Both routers must charge the same Blast fee.");
  }
  return Object.freeze({
    fee: cetus.fee,
    findRoute: (request: TradeRouteRequest) => (request.aftermath ? aftermath.findRoute(request) : cetus.findRoute(request)),
    appendSwap: (tx: Transaction, route: TradeRoute, inputCoin: TransactionObjectArgument, slippageBps: number) =>
      (isAftermathDaoRoute(route) ? aftermath : cetus).appendSwap(tx, route, inputCoin, slippageBps),
  });
}
