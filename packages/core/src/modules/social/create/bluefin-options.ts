import { BLUEFIN_TIERS, type CreateDraft, type CreateIssue } from "@blast/core/modules/social/contracts/create.ts";

/** Bluefin permits arbitrary coin pairs; Blast's creation policy still controls the quote. */
export type BluefinCreateOptions =
  | Readonly<{ status: "ready"; min_tick: number; max_tick: number }>
  | Readonly<{ status: "unavailable" }>;

/** Mirrors `bluefin::new` and the aligned full-range position built by `bluefin::migrate`. */
export function bluefinTierSupported(options: BluefinCreateOptions, tickSpacing: number, feeRate: number): boolean {
  if (options.status !== "ready" || !Number.isInteger(tickSpacing) || tickSpacing < 1 || tickSpacing > 400 || !Number.isInteger(feeRate) || feeRate < 1 || feeRate > 20_000) {
    return false;
  }

  if (!Number.isInteger(options.min_tick) || !Number.isInteger(options.max_tick) || options.min_tick >= options.max_tick) {
    return false;
  }

  const lowerTick = Math.trunc(options.min_tick / tickSpacing) * tickSpacing;
  const upperTick = Math.trunc(options.max_tick / tickSpacing) * tickSpacing;
  return lowerTick >= options.min_tick && upperTick <= options.max_tick && lowerTick < upperTick;
}

export function bluefinCreationIssue(options: BluefinCreateOptions, tickSpacing: number, feeRate: number): string | null {
  if (options.status === "unavailable") {
    return "Bluefin pool settings could not be verified. Try again shortly.";
  }

  return bluefinTierSupported(options, tickSpacing, feeRate) ? null : "Bluefin does not support this tick spacing and pool fee.";
}

export function bluefinDraftIssue(draft: CreateDraft, options: BluefinCreateOptions): CreateIssue | null {
  if (draft.venue !== "bluefin") return null;
  const tier = BLUEFIN_TIERS.find(([, fee]) => fee === draft.pool_fee);
  if (!tier) return null; // The draft's static tier validation already explains this fee.
  const message = bluefinCreationIssue(options, tier[0], draft.pool_fee);
  return message ? { section: "raise", path: "pool_fee", message } : null;
}
