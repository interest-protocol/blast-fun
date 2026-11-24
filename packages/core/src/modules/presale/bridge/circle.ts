import { z } from "zod";
import { recordPresaleMetric } from "../redaction/redaction.ts";
import { PresaleRouteError } from "../route-kit/errors.ts";
import { CCTP_SOURCE_DOMAINS, SUI_CCTP_DOMAIN, type BridgeSource } from "./contracts.ts";

/** Circle's mainnet Iris API. The bridge never uses Circle's sandbox (testnet). */
export const CIRCLE_IRIS_MAINNET = "https://iris-api.circle.com";
/** How long one Iris request may take before the quote is `bridge_unavailable`. */
export const CIRCLE_TIMEOUT_MS = 3_000;
/** Fee and allowance answers are reused for this long per instance. */
export const CIRCLE_CACHE_TTL_MS = 30_000;
/** A failed fetch (timeout, 5xx, malformed body) is not retried for this long. */
export const CIRCLE_FAILURE_TTL_MS = 5_000;
/** After a 429 Circle blocks every request for 5 minutes: none is sent until then. */
export const CIRCLE_RATE_LIMIT_BLOCK_MS = 300_000;

/** Circle's fee for one finality threshold: 1000 is Fast, 2000 is Standard. */
export type CircleFee = Readonly<{ finalityThreshold: number; minimumFeeBps: string }>;

export type CircleFailure = "rate_limited" | "timeout" | "unavailable" | "malformed";

/** An Iris request that failed, by kind; never carries the response. */
export class CircleUnavailableError extends Error {
  readonly kind: CircleFailure;
  constructor(kind: CircleFailure) {
    super(`Circle Iris API ${kind}.`);
    this.name = "CircleUnavailableError";
    this.kind = kind;
  }
}

/** The two Iris reads the quote needs. */
export type CircleIris = Readonly<{
  /** `GET /v2/burn/USDC/fees/{source}/8`. */
  fees(source: BridgeSource): Promise<readonly CircleFee[]>;
  /** `GET /v2/fastBurn/USDC/allowance`: the global Fast allowance in USDC, a decimal string. */
  fastAllowance(): Promise<string>;
}>;

const decimalSchema = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
const circleDecimalSchema = z.union([
  decimalSchema,
  z
    .number()
    .nonnegative()
    .transform((value) =>
      /e/i.test(String(value)) ? value.toFixed(20).replace(/\.?0+$/, "") : String(value),
    )
    .pipe(decimalSchema),
]);
const circleFeesSchema = z.array(
  z.object({
    finalityThreshold: z.number().int().safe(),
    minimumFee: circleDecimalSchema.refine((value) => Number(value) <= 10_000),
  }),
);
const circleAllowanceSchema = z.object({ allowance: circleDecimalSchema });

function parseFees(body: unknown): readonly CircleFee[] {
  const parsed = circleFeesSchema.safeParse(body);
  if (!parsed.success) throw new CircleUnavailableError("malformed");
  return Object.freeze(
    parsed.data.map(({ finalityThreshold, minimumFee }) =>
      Object.freeze({ finalityThreshold, minimumFeeBps: minimumFee }),
    ),
  );
}

function parseAllowance(body: unknown): string {
  const parsed = circleAllowanceSchema.safeParse(body);
  if (!parsed.success) throw new CircleUnavailableError("malformed");
  return parsed.data.allowance;
}

/**
 * One Iris `GET` over `fetch`, mainnet only. A 429 is `rate_limited`, an
 * answer slower than `timeoutMs` is `timeout`, a 404 is `not_found` when
 * `notFound` is asked for (else `unavailable`), any other non-2xx or network
 * failure is `unavailable`, and a body that is not JSON is `malformed`.
 */
export function createIrisGet(
  options: Readonly<{ fetch?: typeof globalThis.fetch; timeoutMs?: number }> = {},
) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? CIRCLE_TIMEOUT_MS;
  return async function get(path: string, notFound: "error" | "null" = "error"): Promise<unknown> {
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetcher(`${CIRCLE_IRIS_MAINNET}${path}`, {
        headers: { accept: "application/json" },
        signal,
      });
    } catch {
      throw new CircleUnavailableError(signal.aborted ? "timeout" : "unavailable");
    }
    if (!response.ok) {
      // An unread body holds the connection until garbage collection.
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 404 && notFound === "null") return null;
      throw new CircleUnavailableError(response.status === 429 ? "rate_limited" : "unavailable");
    }
    try {
      return await response.json();
    } catch {
      throw new CircleUnavailableError(signal.aborted ? "timeout" : "malformed");
    }
  };
}

/**
 * Circle's Iris API over `fetch`, mainnet only. A 429 is `rate_limited`, an
 * answer slower than `timeoutMs` is `timeout`, any other non-2xx or network
 * failure is `unavailable`, and a body that is not the documented shape is
 * `malformed`.
 */
export function createCircleIris(
  options: Readonly<{ fetch?: typeof globalThis.fetch; timeoutMs?: number }> = {},
): CircleIris {
  const get = createIrisGet(options);

  return Object.freeze({
    async fees(source: BridgeSource) {
      return parseFees(
        await get(`/v2/burn/USDC/fees/${CCTP_SOURCE_DOMAINS[source]}/${SUI_CCTP_DOMAIN}`),
      );
    },
    async fastAllowance() {
      return parseAllowance(await get("/v2/fastBurn/USDC/allowance"));
    },
  });
}

type Entry =
  | { kind: "value"; value: unknown; until: number }
  | { kind: "failure"; until: number }
  | { kind: "pending"; promise: Promise<unknown> };

function unavailable(retryAfterMs: number): PresaleRouteError {
  return new PresaleRouteError("bridge_unavailable", {
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1_000)),
  });
}

/**
 * The per-instance Iris facade the quote reads. Each key (one fee list per
 * source, and the allowance) is cached for `ttlMs` with one request in flight
 * at a time, so an instance sends at most five requests per 30 s however busy
 * it is. A failed request is not repeated for `failureTtlMs`, and a 429 stops
 * every request for Circle's 5-minute block: the 40 requests per second limit
 * is never approached. Every failure is `bridge_unavailable` with the seconds
 * until the next attempt as `Retry-After`.
 */
export function createCachedCircle(
  iris: CircleIris,
  options: Readonly<{
    now?: () => number;
    ttlMs?: number;
    failureTtlMs?: number;
    rateLimitBlockMs?: number;
  }> = {},
): CircleIris {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? CIRCLE_CACHE_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? CIRCLE_FAILURE_TTL_MS;
  const rateLimitBlockMs = options.rateLimitBlockMs ?? CIRCLE_RATE_LIMIT_BLOCK_MS;
  const entries = new Map<string, Entry>();
  let blockedUntil = 0;

  async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const at = now();
    if (at < blockedUntil) throw unavailable(blockedUntil - at);
    const entry = entries.get(key);
    if (entry?.kind === "pending") return entry.promise as Promise<T>;
    if (entry?.kind === "value" && at < entry.until) return entry.value as T;
    if (entry?.kind === "failure" && at < entry.until) throw unavailable(entry.until - at);
    const promise = load().then(
      (value) => {
        entries.set(key, { kind: "value", value, until: now() + ttlMs });
        return value;
      },
      (error: unknown) => {
        const kind = error instanceof CircleUnavailableError ? error.kind : "unavailable";
        recordPresaleMetric("presale.bridge.circle", { outcome: "error", kind, read: key });
        if (kind === "rate_limited") blockedUntil = now() + rateLimitBlockMs;
        const until = now() + (kind === "rate_limited" ? rateLimitBlockMs : failureTtlMs);
        entries.set(key, { kind: "failure", until });
        throw unavailable(until - now());
      },
    );
    entries.set(key, { kind: "pending", promise });
    return promise;
  }

  return Object.freeze({
    fees: (source: BridgeSource) => cached(`fees:${source}`, () => iris.fees(source)),
    fastAllowance: () => cached("allowance", () => iris.fastAllowance()),
  });
}
