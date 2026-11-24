const hour = 3_600_000;
export const DISCOVERY_WEIGHTS = { participants: 35, activity: 30, freshness: 25, context: 10 } as const;
export const DISCOVERY_PARTICIPANT_CAP = 8;
export const DISCOVERY_VOLUME_CAP = 1_000;
export const DISCOVERY_PRESALE_GOAL_FRACTION = 0.1;
const unit = (value: number) => Math.min(1, Math.max(0, value));
const logarithmic = (value: number, cap: number) => Math.log1p(Math.min(cap, Math.max(0, value))) / Math.log1p(cap);

export function discoveryFreshness(actionMs: number | null, now: number): number {
  return actionMs === null || actionMs > now ? 0 : unit(1 - (now - actionMs) / hour);
}

/** Breadth is worth more than size, so repeated activity or one large order has limited influence. */
export function discoveryRelevance(input: Readonly<{ participants: number; activity: number; freshness: number; context: number }>): number {
  return DISCOVERY_WEIGHTS.participants * logarithmic(input.participants, DISCOVERY_PARTICIPANT_CAP)
    + DISCOVERY_WEIGHTS.activity * unit(input.activity)
    + DISCOVERY_WEIGHTS.freshness * unit(input.freshness)
    + DISCOVERY_WEIGHTS.context * unit(input.context);
}

export function discoveryVolume(usd: number): number {
  return logarithmic(usd, DISCOVERY_VOLUME_CAP);
}

export function tradingRelevance(input: Readonly<{ volumeUsd: number; traders: number; lastTradeMs: number | null; now: number; changeBps?: number | null }>): number {
  if (input.volumeUsd <= 0 && input.traders === 0) return 0;
  return discoveryRelevance({
    participants: input.traders,
    activity: discoveryVolume(input.volumeUsd),
    freshness: discoveryFreshness(input.lastTradeMs, input.now),
    context: unit(Math.abs(input.changeBps ?? 0) / 1_000) * unit(input.volumeUsd / 25),
  });
}
