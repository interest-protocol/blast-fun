// The buyback operator's own settings (`BLAST_BUYBACK_*`), read and validated
// once at start. Every number is configuration with the owner's default
// (LP-22, decisions of 2026-10-27); a present but invalid value stops the
// process before it connects to anything. Messages name the variable, never
// its value. The runtime's timings, node, database and gas budget are the
// shared `BLAST_WORKER_*` contract (`worker-runtime/config.ts`) of this
// process's own environment; its key is `BLAST_BUYBACK_SIGNER_KEY` alone.

import { objectIdSchema, wholeNumberSetting } from "#workers/lib/validation.ts";
import { refuseForeignSignerKeys } from "#workers/modules/worker-runtime/keys.ts";
import { BUYBACK_KEY_VARIABLE } from "./signer.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export type BuybackSettings = Readonly<{
  /** The dedicated `AdminCap` holding `BuybackAdmin` only, owned by the buyback key. */
  adminCapId: string;
  /** The smallest piece, in US cents: a vault whose waiting Quote is worth less waits for later collections. */
  minUsdCents: bigint;
  /** One piece spends at most this share of the pool's Quote liquidity, in basis points. */
  maxPoolShareBps: bigint;
  /**
   * The slippage tolerance, in basis points (owner, 2026-10-27: 10%): `min_meme_out` is the
   * expected Meme at the reference less this share, and a spot price this far or further from
   * the reference skips the buyback. Smaller deviations are ignored.
   */
  slippageBps: bigint;
  /** The reference price's time-weighted window, a whole number of minutes in ms. */
  twapWindowMs: number;
  /** The most blast-infra may lag the chain for its candles and Quote USD price to count. */
  referenceMaxLagMs: number;
  /** The oldest Quote USD price the minimum check accepts. */
  usdPriceMaxAgeMs: number;
  /** The most pieces one vault buys in a UTC day. */
  maxPiecesPerDay: number;
  /** The shortest wait between two pieces of one vault. */
  minPieceGapMs: number;
  /** Consecutive `min_meme_out` aborts of one vault before the alert fires. */
  abortAlertAfter: number;
  /** Vault pages (of 100) one discovery sweep reads at most. */
  discoveryMaxPages: number;
}>;

export const BUYBACK_DEFAULTS = Object.freeze({
  BLAST_BUYBACK_MIN_USD: "50",
  BLAST_BUYBACK_MAX_POOL_SHARE_BPS: "100",
  BLAST_BUYBACK_SLIPPAGE_BPS: "1000",
  BLAST_BUYBACK_TWAP_WINDOW_MS: "1800000",
  BLAST_BUYBACK_REFERENCE_MAX_LAG_MS: "30000",
  BLAST_BUYBACK_USD_MAX_AGE_MS: "300000",
  BLAST_BUYBACK_MAX_PIECES_PER_DAY: "8",
  BLAST_BUYBACK_MIN_PIECE_GAP_MS: "900000",
  BLAST_BUYBACK_ABORT_ALERT_AFTER: "2",
  BLAST_BUYBACK_DISCOVERY_MAX_PAGES: "50",
});

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function value(environment: Environment, name: keyof typeof BUYBACK_DEFAULTS): string {
  return environment[name]?.trim() || BUYBACK_DEFAULTS[name];
}

function integer(environment: Environment, name: keyof typeof BUYBACK_DEFAULTS, min: number, max: number): number {
  return wholeNumberSetting(environment, name, Number(BUYBACK_DEFAULTS[name]), min, max);
}

/** "50", "49.5" or "0.01": whole US dollars with at most two decimals, as cents. */
function usdCents(environment: Environment): bigint {
  const raw = value(environment, "BLAST_BUYBACK_MIN_USD");
  const match = /^(0|[1-9][0-9]{0,8})(?:\.([0-9]{1,2}))?$/.exec(raw);
  const cents = match ? BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0")) : 0n;
  if (cents < 1n) throw new Error("BLAST_BUYBACK_MIN_USD must be a positive US dollar amount with at most two decimals.");
  return cents;
}

/**
 * The buyback settings from `environment`, every number defaulted to the
 * owner's decision and validated. Refuses an environment that also holds
 * another worker's key: the buyback key is never shared.
 */
export function buybackSettingsFromEnvironment(environment: Environment): BuybackSettings {
  refuseForeignSignerKeys(environment, BUYBACK_KEY_VARIABLE);
  const capId = environment.BLAST_BUYBACK_ADMIN_CAP_ID?.trim();
  if (!capId || !objectIdSchema.safeParse(capId).success) {
    throw new Error("BLAST_BUYBACK_ADMIN_CAP_ID is required: the buyback key's AdminCap, a 0x-prefixed 64-hex object ID.");
  }
  const twapWindowMs = integer(environment, "BLAST_BUYBACK_TWAP_WINDOW_MS", MINUTE_MS, DAY_MS);
  if (twapWindowMs % MINUTE_MS !== 0) throw new Error("BLAST_BUYBACK_TWAP_WINDOW_MS must be a whole number of minutes.");
  return Object.freeze({
    adminCapId: capId,
    minUsdCents: usdCents(environment),
    maxPoolShareBps: BigInt(integer(environment, "BLAST_BUYBACK_MAX_POOL_SHARE_BPS", 1, 10_000)),
    slippageBps: BigInt(integer(environment, "BLAST_BUYBACK_SLIPPAGE_BPS", 1, 9_999)),
    twapWindowMs,
    referenceMaxLagMs: integer(environment, "BLAST_BUYBACK_REFERENCE_MAX_LAG_MS", 1_000, 10 * MINUTE_MS),
    usdPriceMaxAgeMs: integer(environment, "BLAST_BUYBACK_USD_MAX_AGE_MS", 1_000, DAY_MS),
    maxPiecesPerDay: integer(environment, "BLAST_BUYBACK_MAX_PIECES_PER_DAY", 1, 96),
    minPieceGapMs: integer(environment, "BLAST_BUYBACK_MIN_PIECE_GAP_MS", MINUTE_MS, DAY_MS / 2),
    abortAlertAfter: integer(environment, "BLAST_BUYBACK_ABORT_ALERT_AFTER", 1, 100),
    discoveryMaxPages: integer(environment, "BLAST_BUYBACK_DISCOVERY_MAX_PAGES", 1, 1_000),
  });
}
