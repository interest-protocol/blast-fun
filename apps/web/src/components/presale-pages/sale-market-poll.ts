import { pollInterval } from "#web/lib/query/polling.ts";

/**
 * The market reads' timer: every 15 s, or every 60 s while the live screen hears the coin's stats
 * (`useLiveListening`). The stream sends the coin's stats whenever a trade, balance or lifecycle
 * change moves them, so a quiet coin's last read stays current; the slow read keeps the day's move,
 * liquidity and top holders from going stale. A failed read retries at the 15 s pace.
 */
export function marketPoll(listening: boolean) {
  return (query: Parameters<typeof pollInterval>[1] & Readonly<{ state: Readonly<{ status: string }> }>) => pollInterval(listening && query.state.status !== "error" ? 60_000 : 15_000, query);
}
