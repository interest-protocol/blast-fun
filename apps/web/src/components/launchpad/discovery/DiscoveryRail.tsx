"use client";

import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import { useEffect, useEffectEvent, useId, useRef, useState, useSyncExternalStore } from "react";

import { DISCOVERY_VIEW_NAMES, type DiscoveryViewName } from "@blast/core/modules/launchpad-discovery/rows.ts";

import type { SectionState } from "../primitives/data-state";
import styles from "./Discovery.module.css";
import { readRailPage } from "./discovery-client";
import { DiscoveryList } from "./DiscoveryList";
import { afterFirstPage, afterNextPage, railDisplayState, VIEW_INFO, type ViewList } from "./discovery-model";
import { clockNow, serverClockNow, subscribeClock } from "./rail-clock";
import { recallRail, rememberRail } from "./rail-memory";

type States = Record<DiscoveryViewName, SectionState<ViewList>>;

const LOADING: States = { new: { status: "loading" }, near_graduation: { status: "loading" }, graduated: { status: "loading" } };

/**
 * The terminal's discovery slot: Blast launches in three explained views
 * (New, Near graduation, Graduated), a page at a time, each row a link to
 * its coin. There is no Hot view and no hidden score. An outage keeps the
 * last verified rows as Stale; without them the view is Unavailable, and
 * rows read more than a minute ago turn Stale until a refresh succeeds.
 * Choosing a launch keeps the view, its pages and focus on the coin route.
 */
export function DiscoveryRail({ selectedLaunchId }: Readonly<{ selectedLaunchId: string | null }>) {
  const [restored] = useState(recallRail);
  const [view, setView] = useState<DiscoveryViewName>(restored?.view ?? "new");
  const [states, setStates] = useState<States>(restored?.states ?? LOADING);
  const now = useSyncExternalStore(subscribeClock, clockNow, serverClockNow);
  const root = useRef<HTMLDivElement>(null);
  const chosen = useRef<string | null>(null);
  const [pending, setPending] = useState<Partial<Record<DiscoveryViewName, "first" | "more">>>({});
  // The latest request per view; an earlier answer that arrives later is dropped.
  const latest = useRef<Partial<Record<DiscoveryViewName, number>>>({});
  const id = useId();

  /** Reads a page of `target` and settles its state; an earlier answer arriving later is dropped. */
  const settle = async (target: DiscoveryViewName, mode: "first" | "more", cursor: string | null) => {
    const ticket = (latest.current[target] ?? 0) + 1;
    latest.current[target] = ticket;
    const answer = await readRailPage(target, cursor);
    if (latest.current[target] !== ticket) return;
    setStates((current) => ({
      ...current,
      [target]: mode === "more" ? afterNextPage(current[target], answer) : afterFirstPage(current[target], answer),
    }));
    setPending((current) => ({ ...current, [target]: undefined }));
  };

  const load = (target: DiscoveryViewName, mode: "first" | "more") => {
    const previous = states[target];
    const cursor = mode === "more" && (previous.status === "ready" || previous.status === "stale") ? previous.value.nextCursor : null;
    setPending((current) => ({ ...current, [target]: mode }));
    void settle(target, mode, cursor);
  };

  // The view shown first loads if it has nothing yet (it starts in Loading, so nothing is set
  // before its answer); after choosing a launch, focus returns to its row.
  const onMount = useEffectEvent(() => {
    if (states[view].status === "loading") void settle(view, "first", null);
    const focus = restored?.focusLaunchId;
    if (focus) root.current?.querySelector<HTMLAnchorElement>(`a[data-launch-id="${focus}"]`)?.focus();
  });
  useEffect(() => {
    onMount();
  }, []);

  useEffect(() => {
    rememberRail({ view, states, focusLaunchId: chosen.current });
  }, [view, states]);

  const choose = (launchId: string) => {
    chosen.current = launchId;
    rememberRail({ view, states, focusLaunchId: launchId });
  };

  const show = (target: DiscoveryViewName) => {
    setView(target);
    if (states[target].status === "loading" && !pending[target] && latest.current[target] === undefined) load(target, "first");
  };

  const busy = pending[view];
  return (
    <div className={styles.rail} ref={root}>
      <div className={styles.views} role="group" aria-label="Discovery views">
        {DISCOVERY_VIEW_NAMES.map((name) => (
          <button
            key={name}
            className={styles.view}
            type="button"
            aria-pressed={name === view}
            aria-controls={`${id}-list`}
            onClick={() => show(name)}
          >
            {VIEW_INFO[name].label}
          </button>
        ))}
      </div>
      <div className={styles.orderLine}>
        <p className={styles.order}>{VIEW_INFO[view].order}</p>
        <button
          className={styles.textButton}
          type="button"
          onClick={() => load(view, "first")}
          disabled={busy !== undefined}
          aria-busy={busy === "first" || undefined}
        >
          {busy === "first" && states[view].status !== "loading" ? <LoadingIndicator label="Refreshing launches">Refresh</LoadingIndicator> : "Refresh"}
        </button>
      </div>
      <div id={`${id}-list`} className={styles.listRegion}>
        <DiscoveryList
          view={view}
          state={railDisplayState(states[view], now)}
          selectedLaunchId={selectedLaunchId}
          loadingMore={busy === "more"}
          onLoadMore={() => load(view, "more")}
          onShowView={show}
          onChoose={choose}
        />
      </div>
    </div>
  );
}
