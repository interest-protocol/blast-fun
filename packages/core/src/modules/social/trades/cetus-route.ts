import { z } from "zod";
import { isValidSuiAddress, normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

import { blastTradeFeeAtoms, type BlastTradeFeeRate } from "@blast/core/lib/blast-trade-fee.ts";
import { parseDecimal } from "@blast/core/modules/social/trades/amounts.ts";

/**
 * The Cetus aggregator's `find_routes` (social feed R3-30, OA-25 Q1/Q11), asked
 * with a plain `fetch` and checked here. The server's quote and the browser's
 * estimate share this module, so the browser never shows a route the server
 * would refuse. Cetus sends CORS headers, and the call reads nothing private.
 *
 * Blast's app fee is the aggregator's overlay fee, taken from the swap's
 * output inside the swap (`lib/blast-trade-fee.ts`). Every swap is exact-in,
 * so a route's `amountOut` is net of it.
 */

/** One leg of an aggregator route, checked and canonical. */
export type TradePath = Readonly<{
  /** The pool object. */
  poolId: string;
  /** The aggregator's provider (`CETUS`, `BLUEFIN`, …). */
  provider: string;
  /** The pool's swap direction (a → b). */
  direction: boolean;
  from: string;
  target: string;
  /** The venue's fee on this leg, a decimal fraction of its input. */
  feeRate: string;
  amountIn: bigint;
  amountOut: bigint;
  /** The adapter package the leg's swap call targets. */
  publishedAt: string;
  /** An Aftermath DAO-fee leg's pool LP type, the swap's first type argument (`aftermath.ts`); absent on an aggregator leg. */
  lpType?: string;
}>;

/** A route the aggregator answered, checked: what the quote shows and what the swap executes. */
export type TradeRoute = Readonly<{
  /** The aggregator's request id, carried into the swap context. */
  requestId: string;
  amountIn: bigint;
  amountOut: bigint;
  /** The legs in execution order. */
  paths: readonly TradePath[];
  /** The aggregator v3 package (`router::new_swap_context_v3`, `confirm_swap_v3`). */
  aggregatorPackage: string;
  /** The aggregator's deviation from its market price, as it sent it (`""` when it has none). */
  deviationRatio: string | null;
  /**
   * Blast's fee in atoms of the output coin, which `amountOut` is already net
   * of: the route's last legs give `amountOut + blastFee`. 0 with no fee.
   */
  blastFee: bigint;
}>;

export type TradeRouteAnswer =
  | Readonly<{ status: "route"; route: TradeRoute }>
  | Readonly<{ status: "no_route" }>
  | Readonly<{ status: "unavailable"; reason: string }>;

export type TradeRouteRequest = Readonly<{
  from: string;
  target: string;
  amount: bigint;
  /** True: sell exactly `amount`; false: buy exactly `amount` of `target`. */
  byAmountIn: boolean;
  /**
   * The sale coin of the pair when its sale migrated to an Aftermath DAO-fee
   * pool, and that pool (`chain_read_v1.presales.pool_id`): the request is
   * routed through the pool's wrapper (`aftermath.ts`), not the aggregator.
   */
  aftermath?: Readonly<{ coinType: string; poolId: string }> | null;
  signal?: AbortSignal;
}>;

/** The most legs a route may have: more is not offered (a quote id carries the route). */
export const TRADE_ROUTE_MAX_PATHS = 8;
/** How long one aggregator request may take. */
export const TRADE_ROUTE_TIMEOUT_MS = 4_000;
/** `SOCIAL_TRADE_PROVIDERS`' default: the two venues Blast sales migrate to, whose swaps need no oracle and no extra pool details. */
export const DEFAULT_TRADE_PROVIDERS: readonly string[] = Object.freeze(["CETUS", "BLUEFIN"]);
/** The aggregator's origin: the web CSP's `connect-src` lists it, so the browser's estimate can ask it. */
export const CETUS_ROUTER_ORIGIN = "https://api-sui.cetus.zone";
/** The aggregator API (`@cetusprotocol/aggregator-sdk`'s `DEFAULT_ENDPOINT`). */
export const CETUS_ROUTER_ENDPOINT = `${CETUS_ROUTER_ORIGIN}/router_v3`;
/** The SDK version the query names (installed SDK 1.7.3); an upgrade must recheck the query. */
const CETUS_SDK_VERSION = "1010703";
/** The aggregator v3 package the SDK assumes when an answer names none (SDK 1.7.3 `getRouterResult`). */
const CETUS_DEFAULT_AGGREGATOR_V3 = "0x3864c7c59a4889fec05d1aae4bc9dba5a0e0940594b424fbed44cb3f6ac4c032";
/** The largest answer read; more is refused before it is parsed. */
const MAX_ROUTE_BYTES = 4 * 1024 * 1024;
/**
 * The second ask when the best route has more than `TRADE_ROUTE_MAX_PATHS`
 * legs: at most two splits of at most three hops (six legs), which still
 * reaches a sale coin through USDC and SUI. Cetus refuses a depth above 3.
 */
const NARROW_ROUTE = Object.freeze({ depth: "3", split_count: "2" });
/** Aggregator codes that mean no pool reaches the coin (SDK 1.7.3 `processErrorStatusCode`: 5000 insufficient liquidity, 5001/5010 no route). */
const NO_ROUTE_CODES = new Set([5000, 5001, 5010]);

/** Why an answered route cannot be quoted: the `unusable_route` metric's detail. */
export type UnusableRoute = "malformed" | "too_many_legs" | "provider" | "endpoints" | "no_package" | "fee";

const atomsSchema = z.preprocess(
  (value) => value === null || value === undefined ? "" : String(value),
  z.string().regex(/^(0|[1-9][0-9]{0,19})$/).pipe(
    z.string().transform(BigInt).refine((value) => value <= 18_446_744_073_709_551_615n),
  ),
);
const coinSchema = z.string().max(512).transform((value, context) => {
  try { return normalizeStructTag(value); }
  catch { context.addIssue({ code: "custom", message: "Invalid coin type" }); return z.NEVER; }
});
const objectSchema = z.string().refine((value) => isValidSuiAddress(value)).transform((value) => normalizeSuiAddress(value));
const pathSchema = z.object({
  id: objectSchema, from: coinSchema, target: coinSchema,
  published_at: objectSchema, amount_in: atomsSchema, amount_out: atomsSchema,
  direction: z.boolean(), provider: z.string().transform((value) => value.toUpperCase()),
  fee_rate: z.preprocess(String, z.string()).refine((value) => {
    const fee = parseDecimal(value);
    return fee !== null && fee.n >= 0n && fee.n < fee.d;
  }),
}).refine((path) => path.from !== path.target);
const routeSchema = z.object({
  request_id: z.string().optional().catch(undefined),
  amount_in: atomsSchema.refine((value) => value > 0n),
  amount_out: atomsSchema.refine((value) => value > 0n),
  deviation_ratio: z.union([z.string(), z.number()]).optional().catch(undefined),
  paths: z.array(pathSchema).min(1),
  packages: z.record(z.string(), z.unknown()).optional().catch(undefined),
});

/**
 * A `find_routes` answer's route as a checked `TradeRoute` (no Blast fee yet),
 * or why it is not one this service can quote and execute: a malformed leg,
 * more than `TRADE_ROUTE_MAX_PATHS` legs, a provider outside `providers`, legs
 * that do not start at `from` and end at `target`, or no aggregator package.
 */
export function routeFromCetus(
  data: unknown,
  request: Readonly<{ from: string; target: string }>,
  providers: readonly string[],
): Readonly<{ route: TradeRoute }> | Readonly<{ unusable: UnusableRoute }> {
  const parsed = routeSchema.safeParse(data);
  if (!parsed.success) return { unusable: "malformed" };
  const { paths: legs, packages } = parsed.data;
  if (legs.length > TRADE_ROUTE_MAX_PATHS) return { unusable: "too_many_legs" };
  const allowed = new Set(providers);
  if (legs.some((path) => !allowed.has(path.provider))) return { unusable: "provider" };
  const paths: TradePath[] = legs.map((path) => ({
    poolId: path.id, provider: path.provider, direction: path.direction, from: path.from, target: path.target,
    feeRate: path.fee_rate, amountIn: path.amount_in, amountOut: path.amount_out, publishedAt: path.published_at,
  }));
  if (paths[0]!.from !== normalizeStructTag(request.from) || paths.at(-1)!.target !== normalizeStructTag(request.target)) {
    return { unusable: "endpoints" };
  }
  const aggregator = objectSchema.safeParse(packages?.aggregator_v3 ?? CETUS_DEFAULT_AGGREGATOR_V3);
  if (!aggregator.success) return { unusable: "no_package" };
  return {
    route: {
      requestId: parsed.data.request_id ?? "",
      amountIn: parsed.data.amount_in,
      amountOut: parsed.data.amount_out,
      paths,
      aggregatorPackage: aggregator.data,
      deviationRatio: parsed.data.deviation_ratio === undefined ? null : String(parsed.data.deviation_ratio),
      blastFee: 0n,
    },
  };
}

/**
 * The route with Blast's fee taken from its output, as the aggregator takes
 * it on chain from the same amount; null when nothing would be left.
 */
export function withBlastFee(route: TradeRoute, fee: BlastTradeFeeRate | null): TradeRoute | null {
  const gross = route.amountOut + route.blastFee;
  const blastFee = blastTradeFeeAtoms(gross, fee);
  return gross - blastFee > 0n ? { ...route, amountOut: gross - blastFee, blastFee } : null;
}

/** The output to ask an exact-out route for: the least gross whose `gross − ⌊gross × ppm ÷ 10⁶⌋` is at least `amountOut`. */
export function grossForNetOut(amountOut: bigint, fee: BlastTradeFeeRate | null): bigint {
  if (fee === null || amountOut <= 0n) return amountOut;
  // gross − ⌊gross × ppm ÷ 10⁶⌋ = ⌈gross × keep ÷ 10⁶⌉ ≥ out exactly when gross × keep > (out − 1) × 10⁶.
  const keep = 1_000_000n - BigInt(fee.ppm);
  return ((amountOut - 1n) * 1_000_000n) / keep + 1n;
}

/**
 * The answer's JSON with every number kept as its source text, so atoms above
 * 2^53 survive exactly (`JSON.parse` source access: Node 24, Bun, current
 * browsers). A runtime without it passes the parsed number, which only the
 * browser's estimate can meet and which shows to the same digits.
 */
function parseExact(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === "number" && context?.source !== undefined ? context.source : value);
}

/** The body as text, refused past `MAX_ROUTE_BYTES` (by its declared length, then as it streams). */
async function boundedText(response: Response): Promise<string> {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_ROUTE_BYTES)) throw new Error("route too large");
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_ROUTE_BYTES) throw new Error("route too large");
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** The `find_routes` URL for a request: canonical coins, the providers, and the narrow limits when asked. */
export function findRoutesUrl(
  request: Readonly<{ from: string; target: string; amount: bigint; byAmountIn: boolean }>,
  providers: readonly string[],
  narrow = false,
  endpoint = CETUS_ROUTER_ENDPOINT,
): string {
  const query = new URLSearchParams({
    from: normalizeStructTag(request.from),
    target: normalizeStructTag(request.target),
    amount: request.amount.toString(),
    by_amount_in: String(request.byAmountIn),
    ...(narrow ? NARROW_ROUTE : {}),
    providers: providers.join(","),
    v: CETUS_SDK_VERSION,
  });
  return `${endpoint}/find_routes?${query}`;
}

type Asked = TradeRouteAnswer | Readonly<{ status: "unusable"; unusable: UnusableRoute }>;

/**
 * The aggregator's best route for the request, with Blast's fee taken; never
 * throws. With a fee, an exact-out request asks for enough more that what is
 * left after the fee is still the amount asked. A best route with more legs
 * than a quote carries is asked again with fewer splits. An answered route
 * that still cannot be quoted is `unusable_route:<why>`.
 */
export async function findCetusRoute(input: Readonly<{
  request: TradeRouteRequest;
  providers: readonly string[];
  fee: BlastTradeFeeRate | null;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  endpoint?: string;
}>): Promise<TradeRouteAnswer> {
  const { request, providers, fee } = input;
  const fetcher = input.fetch ?? globalThis.fetch;
  const timeout = AbortSignal.timeout(input.timeoutMs ?? TRADE_ROUTE_TIMEOUT_MS);
  let signal: AbortSignal = timeout;
  const amount = request.byAmountIn ? request.amount : grossForNetOut(request.amount, fee);
  const ask = async (narrow: boolean): Promise<Asked> => {
    const url = findRoutesUrl({ ...request, amount }, providers, narrow, input.endpoint);
    const response = await fetcher(url, { signal, redirect: "error", headers: { Accept: "application/json" } });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { status: "unavailable", reason: `aggregator_http_${response.status}` };
    }
    const body = parseExact(await boundedText(response)) as Readonly<{ code?: unknown; msg?: unknown; data?: { paths?: unknown } | null }> | null;
    if (body?.data == null) {
      const code = Number(body?.code);
      return NO_ROUTE_CODES.has(code) || String(body?.msg ?? "").includes("Insufficient liquidity")
        ? { status: "no_route" }
        : { status: "unavailable", reason: `aggregator_${Number.isFinite(code) ? code : "answer"}` };
    }
    if (Array.isArray(body.data.paths) && body.data.paths.length === 0) return { status: "no_route" };
    const found = routeFromCetus(body.data, request, providers);
    if ("unusable" in found) return { status: "unusable", unusable: found.unusable };
    const route = withBlastFee(found.route, fee);
    return route ? { status: "route", route } : { status: "unusable", unusable: "fee" };
  };
  try {
    // Inside the try: a browser without `AbortSignal.any` gets `unavailable` (the server's quote), not a throw.
    if (request.signal) signal = AbortSignal.any([request.signal, timeout]);
    let answer = await ask(false);
    if (answer.status === "unusable" && answer.unusable === "too_many_legs") answer = await ask(true);
    return answer.status === "unusable" ? { status: "unavailable", reason: `unusable_route:${answer.unusable}` } : answer;
  } catch {
    return { status: "unavailable", reason: timeout.aborted ? "timeout" : "error" };
  }
}
