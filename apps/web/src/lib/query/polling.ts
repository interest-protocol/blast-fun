/**
 * Spreads a repeating read over a 20% window, so tabs that loaded together
 * (after a deploy, every open tab reloads at once) drift apart instead of
 * reaching the server in step. The offset is the millisecond of `at`: it
 * differs between tabs and between rounds, yet stays the same for one `at`.
 * That matters because TanStack recomputes `refetchInterval` on every render
 * and restarts its timer when the value changes: a fresh random number would
 * push a busy screen's poll back forever.
 */
export function spreadMs(baseMs: number, at: number, from = 1, width = 0.2): number {
  return Math.round(baseMs * (from + width * ((((at % 1_000) + 1_000) % 1_000) / 1_000)));
}

type AnsweredQuery = Readonly<{ state: Readonly<{ dataUpdatedAt: number; errorUpdatedAt: number; dataUpdateCount: number; errorUpdateCount: number }> }>;

/**
 * A `refetchInterval` of `baseMs`, spread by when the query last answered.
 * While a query has at most one answer and it succeeded (a seeded query gets
 * this twice), the next read lands anywhere in 20–120% of the period, so tabs
 * that all loaded at one deploy spread over a whole period instead of a fifth
 * of one. Later reads, and any read after a failure, wait 100–120%, so a busy
 * backend is never asked again sooner.
 */
export function pollInterval(baseMs: number, query: AnsweredQuery): number {
  const { dataUpdatedAt, errorUpdatedAt, dataUpdateCount, errorUpdateCount } = query.state;
  const at = Math.max(dataUpdatedAt, errorUpdatedAt);
  return dataUpdateCount + errorUpdateCount <= 1 && dataUpdatedAt >= errorUpdatedAt ? spreadMs(baseMs, at, 0.2, 1) : spreadMs(baseMs, at);
}
