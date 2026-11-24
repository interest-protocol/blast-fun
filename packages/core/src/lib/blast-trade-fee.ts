import { z } from "zod";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * Blast's app fee on social trades (owner decision 2026-10-08; 0.3% of every
 * in-app trade since 2026-11-20). It rides the Cetus aggregator's
 * overlay fee: the swap context names a rate and a receiver, and the aggregator's
 * `router::confirm_swap_v3` splits that share off the swap's output and sends
 * it to the receiver inside the swap. The social trade path (quote and swap)
 * charges it, and the presale sponsor's `trade` policy admits exactly it.
 *
 * Server only, never `NEXT_PUBLIC_`:
 *
 * - `BLAST_TRADE_FEE_BPS`: whole basis points, 0 to 1000 (30 is 0.3%);
 * - `BLAST_TRADE_FEE_RECEIVER`: the canonical Sui address that is paid it
 *   (`0x` and 64 lowercase hex digits, never `0x0`).
 *
 * Both unset (or blank), or `BLAST_TRADE_FEE_BPS=0`: no fee. Anything else
 * that is not a valid pair — one without the other, a malformed value, the
 * zero address — throws, so a deployment that meant to charge a fee never
 * trades without it (the trade routes answer `service_unavailable`).
 */

export type BlastTradeFee = Readonly<{
  /** Basis points of the swap's output, 1 to 1000. */
  bps: number;
  /** The same rate in parts per million, as the aggregator's swap context takes it (`bps × 100`). */
  ppm: number;
  /** The canonical address the aggregator pays the fee to. */
  receiver: string;
}>;

export const BLAST_TRADE_FEE_BPS_ENV = "BLAST_TRADE_FEE_BPS";
export const BLAST_TRADE_FEE_RECEIVER_ENV = "BLAST_TRADE_FEE_RECEIVER";
/** 10%: the aggregator's own ceiling on an overlay fee. */
export const BLAST_TRADE_FEE_MAX_BPS = 1_000;

const ZERO_ADDRESS = `0x${"0".repeat(64)}`;
const feeBpsSchema = z.string().regex(/^(0|[1-9][0-9]{0,3})$/)
  .refine((text) => Number(text) <= BLAST_TRADE_FEE_MAX_BPS);
const feeReceiverSchema = z.string().regex(SUI_OBJECT_ID_PATTERN).refine((value) => value !== ZERO_ADDRESS);

/** The configured fee, null for none; throws on a configuration that is not a valid pair. */
export function parseBlastTradeFee(environment: Readonly<Record<string, string | undefined>>): BlastTradeFee | null {
  const bpsText = environment[BLAST_TRADE_FEE_BPS_ENV]?.trim() ?? "";
  const receiver = environment[BLAST_TRADE_FEE_RECEIVER_ENV]?.trim() ?? "";
  if (bpsText === "" && receiver === "") return null;
  if (bpsText === "") throw new Error(`${BLAST_TRADE_FEE_BPS_ENV} is unset while ${BLAST_TRADE_FEE_RECEIVER_ENV} is set`);
  if (!feeBpsSchema.safeParse(bpsText).success) {
    throw new Error(`${BLAST_TRADE_FEE_BPS_ENV} must be a whole number of basis points from 0 to ${BLAST_TRADE_FEE_MAX_BPS}`);
  }
  if (receiver !== "" && !feeReceiverSchema.safeParse(receiver).success) {
    throw new Error(`${BLAST_TRADE_FEE_RECEIVER_ENV} must be a canonical, nonzero Sui address`);
  }
  const bps = Number(bpsText);
  if (bps === 0) return null;
  if (receiver === "") throw new Error(`${BLAST_TRADE_FEE_RECEIVER_ENV} is unset while ${BLAST_TRADE_FEE_BPS_ENV} is ${bps}`);
  return Object.freeze({ bps, ppm: bps * 100, receiver });
}

/** The rate alone: what pricing a route needs, without the receiver a swap pays. */
export type BlastTradeFeeRate = Pick<BlastTradeFee, "bps" | "ppm">;

/**
 * The rate the browser's swap estimate assumes (owner decision 2026-11-20,
 * 0.3%, matching the live fee): the configured fee is server only, and the
 * quote sealed at press carries the real one.
 */
export const BLAST_TRADE_FEE_ESTIMATE_RATE: BlastTradeFeeRate = Object.freeze({ bps: 30, ppm: 3_000 });

/** The fee's share of `grossOut` atoms, as the aggregator takes it: `⌊gross × ppm ÷ 10⁶⌋`. */
export function blastTradeFeeAtoms(grossOut: bigint, fee: BlastTradeFeeRate | null): bigint {
  return fee === null ? 0n : (grossOut * BigInt(fee.ppm)) / 1_000_000n;
}
