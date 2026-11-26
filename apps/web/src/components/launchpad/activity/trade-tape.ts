import { replaceEqualDeep } from "@tanstack/react-query";
import { isActivityTrade, type ActivityRow } from "@blast/core/modules/launchpad-contract/activity.ts";
import { compareEventCursors } from "@blast/core/modules/launchpad-contract/cursor.ts";
import { RECENT_TRADES_LIMIT } from "@blast/core/modules/social/contracts/trader-profiles.ts";
import { T3 } from "#web/components/blast-ui/motion-tokens.ts";

import { shownActivity, type ActivityFeed } from "./activity-feed";
import { listDisplay } from "./activity-model";

type PositionedTrade = Readonly<{ position: string }>;

export type TradeTapeSnapshot<Row = ActivityRow> = Readonly<{
  rows: readonly Row[];
  entering: string | null;
  leaving: Row | null;
  slide: boolean;
}>;

const EMPTY: TradeTapeSnapshot<never> = { rows: [], entering: null, leaving: null, slide: false };

type TapePorts = Readonly<{
  instant: () => boolean;
  observe: (sync: () => void) => () => void;
  schedule: (run: () => void, ms: number) => () => void;
}>;

const MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const browser: TapePorts = {
  instant: () => document.hidden || window.matchMedia?.(MOTION_QUERY).matches === true,
  observe: (sync) => {
    const motion = window.matchMedia?.(MOTION_QUERY);
    motion?.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      motion?.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  },
  schedule: (run, ms) => {
    const timer = window.setTimeout(run, ms);
    return () => window.clearTimeout(timer);
  },
};

/** Pace the compact list independently of ingestion, which still sees every frame immediately. */
export function createTradeTape(feed: Pick<ActivityFeed, "state" | "subscribe">, ports = browser) {
  const seedRows = feed.state().activity.view?.rows.filter(isActivityTrade);
  return createRecentTradeTape({
    subscribe: feed.subscribe,
    state() {
      const activity = shownActivity(feed.state());
      const display = listDisplay(activity);
      return display.kind === "rows"
        ? { rows: display.view.rows.filter(isActivityTrade), quiet: Boolean(display.stale || activity.newer) }
        : null;
    },
  }, RECENT_TRADES_LIMIT, ports, seedRows);
}

type TradeTapeFeed<Row> = Readonly<{
  state: () => Readonly<{ rows: readonly Row[]; quiet: boolean }> | null;
  subscribe: (sync: () => void) => () => void;
}>;

export function createRecentTradeTape<Row extends PositionedTrade>(
  feed: TradeTapeFeed<Row>,
  limit: number,
  ports = browser,
  seedRows?: readonly Row[],
) {
  const initial: TradeTapeSnapshot<Row> = seedRows ? { ...EMPTY, rows: seedRows.slice(0, limit) } : EMPTY;
  let snapshot = initial;
  let ready = false;
  let focused = false;
  let cancelBeat: (() => void) | null = null;
  let stopWatching: (() => void) | null = null;
  const listeners = new Set<() => void>();

  function publish(rows: readonly Row[], entering: string | null, leaving: Row | null, slide: boolean) {
    if (snapshot.entering === entering && snapshot.leaving === leaving && snapshot.slide === slide &&
        rows.length === snapshot.rows.length && rows.every((row, index) => row === snapshot.rows[index])) return;
    snapshot = { rows, entering, leaving, slide };
    for (const listener of listeners) listener();
  }

  function sync() {
    const activity = feed.state();
    if (!activity) {
      ready = false;
      publish([], null, null, false);
      return;
    }

    const settled = snapshot.rows.map((row) => replaceEqualDeep(row, activity.rows.find((current) => current.position === row.position) ?? row));
    const latest = activity.rows.slice(0, limit).map((row) => settled.find((current) => current.position === row.position) ?? row);
    const head = settled[0];
    const quiet = !ready || activity.quiet;
    if (quiet || ports.instant()) {
      ready = true;
      cancelBeat?.();
      cancelBeat = null;
      const entering = !quiet && !focused && latest[0] &&
        (!head || compareEventCursors(latest[0].position, head.position) > 0 || snapshot.entering === latest[0].position)
        ? latest[0].position : null;
      publish(focused ? settled : latest, entering, null, false);
      return;
    }

    if (cancelBeat || focused) {
      publish(settled, cancelBeat ? snapshot.entering : null, cancelBeat ? snapshot.leaving : null, cancelBeat !== null);
      return;
    }
    // Only the newest four can wait. Play those oldest first so a busy feed stays current.
    const next = latest.slice(0, RECENT_TRADES_LIMIT).findLast((row) => !head || compareEventCursors(row.position, head.position) > 0);
    if (!next) {
      publish(latest, null, null, false);
      return;
    }

    cancelBeat = ports.schedule(() => {
      cancelBeat = null;
      sync();
    }, T3);
    publish([next, ...settled].slice(0, limit), next.position, settled[limit - 1] ?? null, true);
  }

  return {
    snapshot: () => snapshot,
    serverSnapshot: () => initial,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        const stopFeed = feed.subscribe(sync);
        const stopSettings = ports.observe(sync);
        stopWatching = () => { stopFeed(); stopSettings(); };
        sync();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size) return;
        stopWatching?.();
        stopWatching = null;
        cancelBeat?.();
        cancelBeat = null;
        focused = false;
        ready = false;
        snapshot = initial;
      };
    },
    hold(hold: boolean) {
      if (hold === focused) return;
      focused = hold;
      if (!hold) sync();
    },
  };
}
