import { pollInterval } from "#web/lib/query/polling.ts";

/**
 * The market reads' timer: every 15 s, or every 60 s once `heard`: the tab's stream is live (the
 * live screen) and has sent this coin's stats. A live stream that never sends the coin's stats keeps
 * the 15 s read, so its numbers never freeze. The stream sends the stats whenever a trade, balance or
 * lifecycle change moves them, so a quiet coin's last read stays current; the slow read keeps the
 * day's move, liquidity and top holders from going stale. A failed read retries at the 15 s pace.
 */
export function marketPoll(heard: boolean) {
  return (query: Parameters<typeof pollInterval>[1] & Readonly<{ state: Readonly<{ status: string }> }>) => pollInterval(heard && query.state.status !== "error" ? 60_000 : 15_000, query);
}
