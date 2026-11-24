import { z } from "zod";
import { addressSchema } from "../contracts/primitives.ts";
import { BASIS_POINTS_DENOMINATOR, U64_MAX } from "@interest-protocol/blast-sdk";
import { MAX_PARTICIPANTS } from "@interest-protocol/blast-sdk/presale";

/**
 * A sale's terms from blast-infra's presale projection (`GET
 * /v1/presales/{id}`, interface contract section 2.1): how the supply and the
 * raise are split and who may commit. Presale-owned: the social presale
 * pages read them through this reader, never the projection directly.
 *
 * Most of it is set when the sale is created, but not all: until the sale's
 * window starts a `FeeAdmin` may change Blast's rates for it
 * (`ProtocolFeesChanged`, `set_protocol_fees` asserts `clock < start_ms`),
 * which moves Blast's shares and the participants' tokens and the pool's
 * quote with them (blast-infra `docs/api.md`, T-043's read fix). So an answer
 * is kept in memory for `cacheMs` only once its split is final — the
 * projection has applied the chain up to the sale's start (`freshness
 * .timestamp_ms ≥ windows.start_ms`, a start of 0 meaning not opened) — and
 * otherwise for `beforeStartCacheMs` at most, the public routes' shared-cache
 * life, so a rate change shows as soon as the route's own cache lets it. One
 * entry per sale, the oldest dropped past `maxEntries`; a sale blast-infra
 * does not know is cached as null for `cacheMs`. Anything else (unreachable,
 * slow, `not_ready`, a body off the contract) throws, and nothing is cached.
 */

export type PresaleTermsShare = Readonly<{ bps: number; amount: string }>;
export type PresaleTermsRecipient = Readonly<{ address: string; bps: number; amount: string }>;

export type PresaleTerms = Readonly<{
  presaleId: string;
  /** Quote atoms. */
  raiseTarget: string;
  supply: Readonly<{
    total: string;
    participants: PresaleTermsShare;
    liquidity: PresaleTermsShare;
    recipients: readonly PresaleTermsRecipient[];
    protocol: PresaleTermsShare;
  }>;
  raise: Readonly<{
    /** Quote atoms that go to the pool. */
    poolShare: string;
    recipients: readonly PresaleTermsRecipient[];
    protocol: PresaleTermsShare;
  }>;
  eligibility: Readonly<{ kind: "open" } | { kind: "allowlisted"; wallets: number }>;
  /** R3-90: whether holders can burn the coin (`supply.burnable`); null when the body does not say. */
  burnable: boolean | null;
  /**
   * R3-90: whether the sale stops at its target — the sale-level
   * `hard_cap` (contracts ADR 0110: from its `starts_after_ms`, amounts take
   * only what is left of the target). False when it can go over
   * (`hard_cap: null`). Null when the body does not say.
   */
  hardCap: boolean | null;
  eligibleUncappedFromMs?: number;
  publicBuy?: Readonly<{ from_ms: number; min_atoms: string; hard_cap_from_ms: number | null }>;
  /** Claim-relative buyer vesting; absent on older projection responses. */
  participantVesting?: Readonly<{ cliffMs: string; durationMs: string }> | null;
  /**
   * The migration pool's swap fee in millionths (`pool_tier.fee_rate`, the CLMM tier reserved before the sale's
   * creation and fixed with it: 2,500 is 0.25%). Null for an Aftermath sale (its venue carries none), a tier not
   * indexed yet, or a body without one; absent where a caller builds terms by hand.
   */
  poolFeePpm?: number | null;
}>;

export type PresaleTermsReader = (
  presaleId: string,
  signal?: AbortSignal,
) => Promise<PresaleTerms | null>;

/** How long a split that can still change is kept, by default: the public routes' `s-maxage=10`. */
export const PRESALE_TERMS_BEFORE_START_CACHE_MS = 10_000;

function atomsSchema(maximum: bigint = U64_MAX) {
  return z
    .string()
    .regex(/^(0|[1-9][0-9]{0,19})$/)
    .pipe(z.string().refine((value) => BigInt(value) <= maximum));
}

const shareSchema = z.object({
  bps: atomsSchema(BASIS_POINTS_DENOMINATOR).transform(Number),
  amount: atomsSchema(),
});
const recipientSchema = shareSchema.extend({ address: addressSchema });
const recipientsSchema = z.array(recipientSchema).max(64);
const vestingSchema = z
  .object({ cliff_delay_ms: atomsSchema(), period_duration_ms: atomsSchema(), periods: atomsSchema() })
  .transform((value) => ({
    cliffMs: value.cliff_delay_ms,
    durationMs: (BigInt(value.period_duration_ms) * BigInt(value.periods)).toString(),
  }))
  .refine(
    ({ cliffMs, durationMs }) =>
      BigInt(durationMs) > 0n &&
      BigInt(durationMs) <= U64_MAX &&
      BigInt(cliffMs) <= BigInt(durationMs),
  );
const termsSchema = z.object({
  presale_id: z.string(),
  raise: z.object({
    target: atomsSchema(),
    pool_share: atomsSchema(),
    recipients: recipientsSchema,
    protocol: shareSchema,
  }),
  supply: z.object({
    total: atomsSchema(),
    participants: shareSchema,
    liquidity: shareSchema,
    recipients: recipientsSchema,
    protocol: shareSchema,
    burnable: z.boolean().nullable().catch(null),
  }),
  eligibility: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("open") }),
    z.object({
      kind: z.literal("allowlisted"),
      leaf_count: atomsSchema(MAX_PARTICIPANTS).transform(Number),
    }),
  ]),
  windows: z.object({
    uncapped_from_ms: z.number().int().safe().nonnegative().nullish(),
    hard_cap_from_ms: z.number().int().safe().nonnegative().nullish(),
  }).optional(),
  uncapped: z.object({ access: z.union([
    z.literal("eligible"),
    z.object({ anyone: z.object({ min_commitment: atomsSchema() }) }),
  ]) }).nullish(),
  hard_cap: z
    .union([
      z.null().transform(() => false),
      z
        .object({ starts_after_ms: z.number(), closes_when_filled: z.boolean() })
        .transform(() => true),
    ])
    .transform((value): boolean | null => value)
    .catch(null),
  participant_vesting: vestingSchema.nullish(),
  pool_tier: z
    .object({ fee_rate: atomsSchema(1_000_000n).transform(Number).nullish().catch(null) })
    .nullish()
    .catch(null),
});
const finalSplitSchema = z
  .object({
    windows: z.object({ start_ms: z.number().int().safe().positive() }),
    freshness: z.object({ timestamp_ms: z.number().int().safe() }),
  })
  .refine(({ windows, freshness }) => freshness.timestamp_ms >= windows.start_ms);
const notFoundSchema = z.object({ error: z.object({ code: z.literal("not_found") }) });

class TermsUnavailable extends Error {
  constructor() {
    super("The presale projection is unavailable.");
    this.name = "TermsUnavailable";
  }
}

/**
 * Whether a projection body's split is final: the sale has a start (its
 * window is zero until it opens) and the projection has applied the chain up
 * to it, so no `ProtocolFeesChanged` can follow. Anything unreadable is not.
 */
export function presaleSplitIsFinal(body: unknown): boolean {
  return finalSplitSchema.safeParse(body).success;
}

/** The section 2.1 parts this reader keeps, or `TermsUnavailable` for a body off the contract. */
export function parsePresaleTerms(presaleId: string, body: unknown): PresaleTerms {
  const parsed = termsSchema.safeParse(body);
  if (!parsed.success || parsed.data.presale_id !== presaleId) throw new TermsUnavailable();
  const root = parsed.data;
  const { raise, supply, eligibility } = root;
  return {
    presaleId,
    raiseTarget: raise.target,
    supply: {
      total: supply.total,
      participants: supply.participants,
      liquidity: supply.liquidity,
      recipients: supply.recipients,
      protocol: supply.protocol,
    },
    raise: { poolShare: raise.pool_share, recipients: raise.recipients, protocol: raise.protocol },
    eligibility:
      eligibility.kind === "allowlisted"
        ? { kind: "allowlisted", wallets: eligibility.leaf_count }
        : { kind: "open" },
    burnable: supply.burnable,
    hardCap: root.hard_cap,
    ...(root.windows?.uncapped_from_ms != null && root.uncapped?.access === "eligible"
      ? { eligibleUncappedFromMs: root.windows.uncapped_from_ms }
      : {}),
    ...(root.windows?.uncapped_from_ms != null && root.uncapped && root.uncapped.access !== "eligible" ? {
      publicBuy: { from_ms: root.windows.uncapped_from_ms, min_atoms: root.uncapped.access.anyone.min_commitment,
        hard_cap_from_ms: root.windows.hard_cap_from_ms ?? null },
    } : {}),
    poolFeePpm: root.pool_tier?.fee_rate ?? null,
    ...(root.participant_vesting === undefined
      ? {}
      : { participantVesting: root.participant_vesting }),
  };
}

export function createPresaleTermsReader(
  options: Readonly<{
    origin: () => string;
    fetch: typeof fetch;
    timeoutMs: number;
    /** How long a final answer (and an unknown sale) is kept. */
    cacheMs: number;
    /** How long an answer whose split can still change is kept (default `PRESALE_TERMS_BEFORE_START_CACHE_MS`, never past `cacheMs`; 0 keeps none). */
    beforeStartCacheMs?: number;
    maxEntries?: number;
    now?: () => number;
  }>,
): PresaleTermsReader {
  const cache = new Map<string, { until: number; terms: PresaleTerms | null }>();
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 500;
  const beforeStartMs = Math.min(
    options.cacheMs,
    options.beforeStartCacheMs ?? PRESALE_TERMS_BEFORE_START_CACHE_MS,
  );
  return async (presaleId, signal) => {
    const cached = cache.get(presaleId);
    if (cached && now() < cached.until) return cached.terms;
    let response: Response;
    let body: unknown;
    try {
      const timeout = AbortSignal.timeout(options.timeoutMs);
      response = await options.fetch(new URL(`/v1/presales/${presaleId}`, options.origin()), {
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      body = await response.json().catch(() => null);
    } catch {
      throw new TermsUnavailable();
    }
    let terms: PresaleTerms | null;
    let keepMs = options.cacheMs;
    if (response.status === 404 && notFoundSchema.safeParse(body).success) terms = null;
    else if (response.status === 200) {
      terms = parsePresaleTerms(presaleId, body);
      if (!presaleSplitIsFinal(body)) keepMs = beforeStartMs;
    } else throw new TermsUnavailable();
    cache.delete(presaleId);
    if (keepMs <= 0) return terms;
    cache.set(presaleId, { until: now() + keepMs, terms });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value as string);
    return terms;
  };
}
