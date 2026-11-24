import { z } from "zod";
import { MINIMUM_SECRET_LENGTH } from "@blast/core/lib/config/secret.ts";

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";

import { BLAST_TRADE_FEE_MAX_BPS } from "@blast/core/lib/blast-trade-fee.ts";
import type { SocialTradeSide } from "@blast/core/modules/social/contracts/trades.ts";
import type { TradePath, TradeRoute } from "@blast/server/modules/social/trades/aggregator.ts";

/**
 * The `quote_id` (social feed R3-30): an offered quote, sealed. It carries
 * everything R3-31's swap path pins — the wallet it was dry-run from, the
 * account, the coins, the amounts, the slippage, the route's legs in order and
 * its expiry — with the price impact it showed (OA-29) and Blast's fee rate
 * and amount (`BLAST_TRADE_FEE_BPS`), encrypted and
 * authenticated with AES-256-GCM, so it is opaque to the client and cannot be
 * edited (a widened slippage or another route fails authentication). Nothing
 * is stored per quote: the quote route writes no row, and only a trade the
 * account sends is recorded (R3-31).
 *
 * The key is derived from `RATE_LIMIT_SUBJECT_PEPPER` (HKDF-SHA256 with this
 * purpose's own label), the secret every social instance already shares, so a
 * quote issued by one instance opens on any other.
 */

export type SealedTradeQuote = Readonly<{
  accountId: string;
  /** The Blast wallet the quote was dry-run from: the only sender that may execute it. */
  sender: string;
  side: SocialTradeSide;
  inCoin: string;
  outCoin: string;
  amountIn: bigint;
  amountOut: bigint;
  minOut: bigint;
  slippageBps: number;
  /** The price impact the quote showed, in basis points; null when it showed none. */
  priceImpactBps: number | null;
  /** Blast's fee rate the quote was priced at, in basis points (0: none); the swap refuses another rate. */
  blastFeeBps: number;
  issuedAtMs: number;
  expiresAtMs: number;
  route: TradeRoute;
}>;

const PREFIX = "q1.";
const INFO = "blast-social-trade-quote:v1";
/** Longer than any route of `TRADE_ROUTE_MAX_PATHS` legs seals to; the swap request body is 4 KiB. */
export const TRADE_QUOTE_ID_MAX_LENGTH = 3_000;

/** The sealing key for a pepper of at least 32 characters; throws otherwise. */
export function tradeQuoteKey(pepper: string): Buffer {
  if (pepper.length < MINIMUM_SECRET_LENGTH) throw new Error("RATE_LIMIT_SUBJECT_PEPPER must be at least 32 characters.");
  return Buffer.from(hkdfSync("sha256", pepper, Buffer.alloc(0), INFO, 32));
}

/** A leg: nine fields, and a tenth, the LP type, on an Aftermath DAO-fee leg. */
type CompactPath = [string, string, 0 | 1, number, number, string, string, string, string, string?];

type Compact = {
  a: string;
  s: string;
  d: SocialTradeSide;
  i: string;
  o: string;
  ai: string;
  ao: string;
  m: string;
  b: number;
  /** Absent from a quote sealed before OA-29, which opens with no impact. */
  pi?: number | null;
  /** Blast's fee rate; absent from a quote sealed before the fee, which opens at 0. */
  f?: number;
  t: number;
  e: number;
  q: string;
  ri: string;
  ro: string;
  g: string;
  v: string | null;
  /** The route's Blast fee in atoms; absent before the fee (0). */
  rf?: string;
  c: string[];
  h: CompactPath[];
};

function compact(quote: SealedTradeQuote): Compact {
  const coins: string[] = [];
  const index = (coin: string) => {
    const at = coins.indexOf(coin);
    if (at >= 0) return at;
    coins.push(coin);
    return coins.length - 1;
  };
  const legs = quote.route.paths.map((path): CompactPath => [
    path.poolId,
    path.provider,
    path.direction ? 1 : 0,
    index(path.from),
    index(path.target),
    path.feeRate,
    path.amountIn.toString(),
    path.amountOut.toString(),
    path.publishedAt,
    ...(path.lpType === undefined ? [] : [path.lpType]),
  ] as CompactPath);
  return {
    a: quote.accountId,
    s: quote.sender,
    d: quote.side,
    i: quote.inCoin,
    o: quote.outCoin,
    ai: quote.amountIn.toString(),
    ao: quote.amountOut.toString(),
    m: quote.minOut.toString(),
    b: quote.slippageBps,
    pi: quote.priceImpactBps,
    f: quote.blastFeeBps,
    t: quote.issuedAtMs,
    e: quote.expiresAtMs,
    q: quote.route.requestId,
    ri: quote.route.amountIn.toString(),
    ro: quote.route.amountOut.toString(),
    g: quote.route.aggregatorPackage,
    v: quote.route.deviationRatio,
    rf: quote.route.blastFee.toString(),
    c: coins,
    h: legs,
  };
}

const ATOMS = /^(0|[1-9][0-9]{0,19})$/;

const compactAtomsSchema = z.string().regex(ATOMS);
const compactPathIndexSchema = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^(0|[1-9][0-9]*)$/).transform(Number),
]);
const compactPathFields = [
  z.string(), z.string(), z.unknown(), compactPathIndexSchema, compactPathIndexSchema,
  z.string(), z.coerce.string().regex(ATOMS), z.coerce.string().regex(ATOMS), z.string(),
] as const;
const compactPathSchema = z.union([z.tuple(compactPathFields), z.tuple([...compactPathFields, z.string()])]);
const compactQuoteSchema = z.object({
  a: z.string(), s: z.string(), d: z.enum(["buy", "sell"]), i: z.string(), o: z.string(),
  ai: compactAtomsSchema, ao: compactAtomsSchema, m: compactAtomsSchema,
  b: z.number().int(), t: z.number().int(), e: z.number().int(),
  pi: z.number().int().min(0).max(10_000).nullish(),
  f: z.number().int().min(0).max(BLAST_TRADE_FEE_MAX_BPS).nullish(),
  q: z.string(), ri: compactAtomsSchema, ro: compactAtomsSchema, g: z.string(),
  v: z.unknown().optional(), rf: compactAtomsSchema.nullish(),
  c: z.array(z.string()), h: z.array(z.unknown()),
});

function expandPath(leg: unknown, coins: readonly string[]): TradePath | null {
  const parsed = compactPathSchema.safeParse(leg);
  if (!parsed.success) return null;
  const [poolId, provider, direction, from, target, feeRate, amountIn, amountOut, publishedAt, lpType] = parsed.data;
  if (coins[from] === undefined || coins[target] === undefined) return null;
  return {
    poolId,
    provider,
    direction: direction === 1,
    from: coins[from]!,
    target: coins[target]!,
    feeRate,
    amountIn: BigInt(amountIn),
    amountOut: BigInt(amountOut),
    publishedAt,
    ...(lpType === undefined ? {} : { lpType }),
  };
}

function expand(value: unknown): SealedTradeQuote | null {
  const parsed = compactQuoteSchema.safeParse(value);
  if (!parsed.success) return null;
  const c = parsed.data;
  const impact = c.pi ?? null;
  const blastFeeBps = c.f ?? 0;
  const blastFee = c.rf ?? "0";
  const coins = c.c;
  const paths: TradePath[] = [];
  for (const leg of c.h) {
    const path = expandPath(leg, coins);
    if (path === null) return null;
    paths.push(path);
  }
  return {
    accountId: c.a,
    sender: c.s,
    side: c.d,
    inCoin: c.i,
    outCoin: c.o,
    amountIn: BigInt(c.ai),
    amountOut: BigInt(c.ao),
    minOut: BigInt(c.m),
    slippageBps: c.b,
    priceImpactBps: impact,
    blastFeeBps,
    issuedAtMs: c.t,
    expiresAtMs: c.e,
    route: {
      requestId: c.q,
      amountIn: BigInt(c.ri),
      amountOut: BigInt(c.ro),
      paths,
      aggregatorPackage: c.g,
      deviationRatio: typeof c.v === "string" ? c.v : null,
      blastFee: BigInt(blastFee),
    },
  };
}

/** Seals a quote into its `quote_id`. */
export function sealTradeQuote(key: Buffer, quote: SealedTradeQuote): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(deflateRawSync(Buffer.from(JSON.stringify(compact(quote))))), cipher.final()]);
  return `${PREFIX}${Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64url")}`;
}

/**
 * Opens a `quote_id`: the quote, or null for anything this key did not seal
 * (malformed, edited, sealed with another key, or too long). Expiry is the
 * caller's to judge; an expired quote opens.
 */
export function openTradeQuote(key: Buffer, token: string): SealedTradeQuote | null {
  if (typeof token !== "string" || !token.startsWith(PREFIX) || token.length > TRADE_QUOTE_ID_MAX_LENGTH) return null;
  const raw = token.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const bytes = Buffer.from(raw, "base64url");
  if (bytes.length < 12 + 16 + 1) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(bytes.length - 16));
    const plain = Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]);
    return expand(JSON.parse(inflateRawSync(plain, { maxOutputLength: 64 * 1_024 }).toString("utf8")));
  } catch {
    return null;
  }
}
