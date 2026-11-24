import type { QueryClient } from "@tanstack/react-query";

import { HINTED_KEYS } from "#web/lib/query/invalidate.ts";
import { queryKeys } from "#web/lib/query/keys.ts";

import { recordHintPainted } from "./home/activity-hints";
import { browserGapTimers, hintedGap, NEW_POSTS_MIN_GAP_MS, type FeedFreshnessSource, type FreshnessHint, type GapTimers } from "./home/feed-freshness";

/** The bridge's name in the hint metrics (R3-26's `surface`). */
export const LIVE_QUERIES_SURFACE = "queries";

/** The viewer's own reads a phase change can move; they bypass the edge cache. */
const VIEWER_KEYS = [queryKeys.me.wallet(), queryKeys.me.portfolio(), queryKeys.me.presales(), queryKeys.me.presaleViewerAll];
/** A phase change does not move a balance, and the You pay panel's own read is already fresh on open, on focus and after every confirm: a hint must not fan it out to every open panel. */
const notPaymentBalance = (query: { queryKey: readonly unknown[] }) => query.queryKey[3] !== "balance";
/** Each tab reads its viewer state within this long of a phase change, and of its 30 s follow-up. */
export const VIEWER_SPREAD_MS = 10_000;

/**
 * blast-infra's activity hints (`/v1/ws`, T-035, R3-26) as cache
 * invalidation (OA-38). On each hint — a commit, a claim or a lifecycle row
 * landed somewhere, or the socket (re)connected and may have missed some —
 * the discovery reads a hint can move (`HINTED_KEYS`: every presale list page)
 * and sale details are invalidated: the ones on screen read again, once each however many
 * components show them, and the rest are marked stale for their next mount.
 * Lifecycle hints and resumed streams also refresh allocations, wallet metadata
 * and vesting, because a hidden tab may have missed a phase change; after a
 * phase change each tab spreads those private reads over `VIEWER_SPREAD_MS`.
 * Separate lifecycle admission replaces an older in-flight phase read once, then
 * coalesces further transitions for five seconds. Local mutation refreshes stay immediate.
 * Ordinary activity looks at most once per 5 s, keeping a hint inside the floor
 * (`hintedGap`, as every live reader does).
 *
 * This replaces the per-surface hint subscription of the list readers
 * (Blast mode's lanes keep only their 30 s poll on the mode's registry), so a
 * hint costs one read per list whoever shows it. Home's tape, the ticker and
 * the feed's new-items pill keep their own readers' gates. A hint is a signal
 * only: nothing is read from the frame.
 */
export function hintInvalidation(client: QueryClient, source: FeedFreshnessSource, timers: GapTimers = browserGapTimers(), random = Math.random): () => void {
  let followup: unknown = null;
  let lifecyclePending = false;
  let viewer: unknown = null;
  let viewerCancels = false;
  let scheduled: unknown = null;
  let scheduledHint: FreshnessHint | undefined;
  const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
  // A phase change reaches every open tab at once, and the viewer's reads skip the
  // edge cache, so each tab spreads them over `VIEWER_SPREAD_MS`. A waiting read
  // absorbs the next one either way and keeps the stronger `cancelRefetch`, so a
  // phase change still replaces a read that began before it. A catch-up is this
  // tab's own event, so it reads at once.
  const readViewer = (spread: boolean, cancelRefetch: boolean) => {
    viewerCancels ||= cancelRefetch;
    const run = () => {
      const cancel = viewerCancels;
      viewer = null;
      viewerCancels = false;
      if (visible()) void Promise.all(VIEWER_KEYS.map((queryKey) => client.invalidateQueries({ queryKey, predicate: notPaymentBalance }, { cancelRefetch: cancel })));
    };
    if (!spread) {
      if (viewer !== null) timers.clearTimeout(viewer);
      return run();
    }
    if (viewer !== null) return;
    const delay = Math.floor(random() * VIEWER_SPREAD_MS);
    if (delay === 0) run();
    else viewer = timers.setTimeout(run, delay);
  };
  // A hint can beat the CDN's 10 s cache plus 20 s stale-revalidation window.
  const look = (hint?: FreshnessHint) => {
    const phase = hint?.presaleId !== undefined;
    const lifecycle = phase || hint?.catchUp === true;
    lifecyclePending ||= lifecycle;
    if (followup === null) followup = timers.setTimeout(() => {
      followup = null;
      if (visible()) void Promise.all(HINTED_KEYS.map((queryKey) => client.invalidateQueries({ queryKey }, { cancelRefetch: false })));
      if (lifecyclePending) readViewer(true, false);
      lifecyclePending = false;
    }, 30_100 + Math.floor(random() * 5_000));
    // The sale reads are public and edge-cached, so they go now. Plain hints leave the
    // viewer's reads alone; its 60 s poll and the follow-up above cover them.
    if (lifecycle) readViewer(phase, true);
    void Promise.all(HINTED_KEYS.map((queryKey) => client.invalidateQueries({ queryKey }, { cancelRefetch: lifecycle }))).then(() =>
      recordHintPainted(LIVE_QUERIES_SURFACE, hint),
    );
  };
  const signal = (hint?: FreshnessHint) => {
    const lifecycle = hint?.presaleId !== undefined || hint?.catchUp === true;
    if (!(lifecycle ? lifecycleGate.admit(hint) : gate.admit(hint))) return;
    if (!(scheduledHint?.presaleId || scheduledHint?.catchUp) || lifecycle) scheduledHint = hint;
    if (scheduled !== null) return;
    const delay = Math.floor(random() * 1_000);
    const flush = () => {
      const next = scheduledHint;
      scheduled = null;
      scheduledHint = undefined;
      if (typeof document === "undefined" || document.visibilityState !== "hidden") look(next);
    };
    if (delay === 0) flush();
    else scheduled = timers.setTimeout(flush, delay);
  };
  const gate = hintedGap(NEW_POSTS_MIN_GAP_MS, timers, signal);
  const lifecycleGate = hintedGap(NEW_POSTS_MIN_GAP_MS, timers, signal);
  const off = source.subscribe(signal);
  return () => {
    off();
    gate.cancel();
    lifecycleGate.cancel();
    if (scheduled !== null) timers.clearTimeout(scheduled);
    if (followup !== null) timers.clearTimeout(followup);
    if (viewer !== null) timers.clearTimeout(viewer);
  };
}
