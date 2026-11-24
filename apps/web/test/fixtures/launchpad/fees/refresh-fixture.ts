import type { FeesOutcome } from "#web/components/launchpad/fees/fees-model.ts";

export const requests: { resolve: (value: FeesOutcome) => void; reject: (error: Error) => void }[] = [];
export const poll: { refresh: (at: number | null) => void } = { refresh: () => {} };
export function readFees() {
  return new Promise<FeesOutcome>((resolve, reject) => { requests.push({ resolve, reject }); });
}
export function useMarketPoll({ onRefresh }: { onRefresh: (at: number | null) => void }) {
  poll.refresh = onRefresh;
}
export const browserMarketDependencies = () => ({});
export const atCheckpoint = () => ({});
