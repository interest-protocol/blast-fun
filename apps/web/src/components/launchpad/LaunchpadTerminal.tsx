"use client";

import {
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { FocusSurface } from "./FocusSurface";
import { handOffFocus } from "./focus-return";
import styles from "./LaunchpadTerminal.module.css";
import { SectionBoundary } from "./primitives/SectionBoundary";
import {
  DESKTOP_DESTINATIONS,
  type DesktopDestination,
  type MobileView,
  nextDestination,
  TERMINAL_DESKTOP_MEDIA,
  type TerminalRegion,
  terminalRegionVisibility,
} from "./terminal-layout";

/**
 * The integration contract for terminal feature slices. Each slice owns one
 * slot and renders only its own content; the terminal owns placement,
 * headings, and navigation. `execution` holds transaction controls, review,
 * and status only — never cards, feeds, or social content.
 *
 * Each slot renders inside a SectionBoundary: a slot that fails degrades
 * alone. Page status belongs to the page: decide `notFound()` or
 * `redirect()` there, before the terminal renders its slots. Called inside a
 * streamed slot, `notFound()` can only produce a soft 404 (HTTP 200).
 */
export type TerminalSlots = Readonly<{
  /** Coin lists. A desktop column that can collapse; the mobile Discover view. */
  discovery: ReactNode;
  /** Selected-market header: identity or an honest "no coin selected" state. Hosts the page h1. */
  market: ReactNode;
  chart: ReactNode;
  overview: ReactNode;
  theses: ReactNode;
  activity: ReactNode;
  holders: ReactNode;
  /** Desktop right rail; the full-screen Trade surface on mobile. */
  execution: ReactNode;
}>;

/** The noun each slot shows, used when a slot fails to render. */
const SLOT_SUBJECTS: Record<keyof TerminalSlots, string> = {
  discovery: "coin lists",
  market: "the selected coin",
  chart: "the chart",
  overview: "the overview",
  theses: "thesis",
  activity: "activity",
  holders: "holders",
  execution: "trading controls",
};

const DESTINATION_LABELS: Record<DesktopDestination, string> = {
  overview: "Overview",
  theses: "Thesis",
  activity: "Activity",
  holders: "Holders",
};

function subscribeToDesktop(onChange: () => void) {
  const query = window.matchMedia(TERMINAL_DESKTOP_MEDIA);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** True on the desktop composition. The server renders desktop; CSS hides its rail on mobile until hydration. */
function useDesktopLayout() {
  return useSyncExternalStore(
    subscribeToDesktop,
    () => window.matchMedia(TERMINAL_DESKTOP_MEDIA).matches,
    () => true,
  );
}

/**
 * The responsive launchpad terminal. Desktop: collapsible discovery, the
 * chart workspace with Overview/Theses/Activity/Holders destinations, and a
 * dedicated execution rail. Mobile: Discover, Chart, Trade, Theses; Trade
 * opens a full-screen surface.
 */
export function LaunchpadTerminal({
  initialMobileView = "chart",
  initialDestination = "overview",
  ...slots
}: TerminalSlots & Readonly<{ initialMobileView?: MobileView; initialDestination?: DesktopDestination }>) {
  const [destination, setDestination] = useState<DesktopDestination>(initialDestination);
  const [mobileView, setMobileView] = useState<MobileView>(initialMobileView);
  const [discoveryCollapsed, setDiscoveryCollapsed] = useState(false);
  const [tradeOpen, setTradeOpen] = useState(false);
  const isDesktop = useDesktopLayout();
  // Crossing the breakpoint moves execution between the rail and the Trade
  // surface; a surface left open on the way out must not reappear later.
  const [layoutWasDesktop, setLayoutWasDesktop] = useState(isDesktop);
  if (layoutWasDesktop !== isDesktop) {
    setLayoutWasDesktop(isDesktop);
    setTradeOpen(false);
  }
  const tradeButtonRef = useRef<HTMLButtonElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const tabRefs = useRef(new Map<DesktopDestination, HTMLButtonElement>());
  const id = useId();

  const regionProps = (region: TerminalRegion) => {
    const visible = terminalRegionVisibility(region, { destination, mobileView });
    return {
      "data-desktop": visible.desktop ? "shown" : "hidden",
      "data-mobile": visible.mobile ? "shown" : "hidden",
    };
  };

  const onTabKeyDown = (event: KeyboardEvent, current: DesktopDestination) => {
    const next = nextDestination(current, event.key);
    if (!next) return;
    event.preventDefault();
    setDestination(next);
    tabRefs.current.get(next)?.focus();
  };

  // A slot that throws while rendering degrades alone; the page and its
  // sibling slots stay usable.
  const slot = (name: keyof TerminalSlots, heading?: ReactNode) => (
    <SectionBoundary subject={SLOT_SUBJECTS[name]} heading={heading}>
      {slots[name]}
    </SectionBoundary>
  );

  const mobileViewButton = (view: MobileView, label: string) => (
    <li>
      <button
        className={styles.mobileNavButton}
        type="button"
        aria-current={mobileView === view ? "true" : undefined}
        onClick={() => setMobileView(view)}
      >
        {label}
      </button>
    </li>
  );

  return (
    <div
      className={styles.terminal}
      data-discovery={discoveryCollapsed ? "collapsed" : "expanded"}
    >
      <aside className={styles.discovery} aria-labelledby={`${id}-discovery`} {...regionProps("discovery")}>
        <div className={styles.discoveryHeader}>
          <h2 className={styles.regionLabel} id={`${id}-discovery`}>Discover</h2>
          <button
            className={styles.collapseToggle}
            type="button"
            aria-expanded={!discoveryCollapsed}
            aria-controls={`${id}-discovery-body`}
            aria-label={discoveryCollapsed ? "Expand discovery" : "Collapse discovery"}
            onClick={() => setDiscoveryCollapsed((collapsed) => !collapsed)}
          >
            <span aria-hidden="true">{discoveryCollapsed ? "»" : "«"}</span>
          </button>
        </div>
        <div className={styles.discoveryBody} id={`${id}-discovery-body`}>
          {slot("discovery")}
        </div>
      </aside>

      <section className={styles.workspace} aria-label="Market workspace">
        <div className={styles.market} {...regionProps("market")}>
          {/* The market slot hosts the page h1; keep one if the slot fails. */}
          {slot("market", <h1 className={styles.marketTitle}>Trading terminal</h1>)}
        </div>
        <section className={styles.chart} aria-labelledby={`${id}-chart`} {...regionProps("chart")}>
          <h2 className={styles.regionLabel} id={`${id}-chart`}>Chart</h2>
          {slot("chart")}
        </section>
        <div className={styles.tabs} role="tablist" aria-label="Market details">
          {DESKTOP_DESTINATIONS.map((tab) => (
            <button
              key={tab}
              ref={(element) => {
                if (element) tabRefs.current.set(tab, element);
                else tabRefs.current.delete(tab);
              }}
              className={styles.tab}
              type="button"
              role="tab"
              id={`${id}-tab-${tab}`}
              aria-selected={tab === destination}
              aria-controls={`${id}-panel-${tab}`}
              tabIndex={tab === destination ? 0 : -1}
              onClick={() => setDestination(tab)}
              onKeyDown={(event) => onTabKeyDown(event, tab)}
            >
              {DESTINATION_LABELS[tab]}
            </button>
          ))}
        </div>
        {DESKTOP_DESTINATIONS.map((panel) => (
          <section
            key={panel}
            className={styles.panel}
            id={`${id}-panel-${panel}`}
            role={isDesktop ? "tabpanel" : undefined}
            tabIndex={isDesktop ? 0 : undefined}
            aria-labelledby={isDesktop ? `${id}-tab-${panel}` : `${id}-heading-${panel}`}
            {...regionProps(panel)}
          >
            <h2 className={styles.panelHeading} id={`${id}-heading-${panel}`}>
              {DESTINATION_LABELS[panel]}
            </h2>
            {slot(panel)}
          </section>
        ))}
      </section>

      {isDesktop ? (
        <aside
          ref={(rail) => {
            railRef.current = rail;
            if (!rail) return;
            // Crossing to mobile removes the rail; its focus goes to the Trade button.
            return () => {
              railRef.current = null;
              if (!window.matchMedia(TERMINAL_DESKTOP_MEDIA).matches) {
                handOffFocus(document, rail, tradeButtonRef.current);
              }
            };
          }}
          className={styles.rail}
          aria-labelledby={`${id}-trade`}
          tabIndex={-1}
          {...regionProps("execution")}
        >
          <h2 className={styles.regionLabel} id={`${id}-trade`}>Trade</h2>
          {slot("execution")}
        </aside>
      ) : (
        <FocusSurface
          open={tradeOpen}
          onClose={() => setTradeOpen(false)}
          title="Trade"
          layout="fullscreen"
          returnFocusRef={tradeButtonRef}
          fallbackFocusRef={railRef}
        >
          {slot("execution")}
        </FocusSurface>
      )}

      <nav className={styles.mobileNav} aria-label="Terminal views">
        <ul className={styles.mobileNavList}>
          {mobileViewButton("discover", "Discover")}
          {mobileViewButton("chart", "Chart")}
          <li>
            <button
              ref={tradeButtonRef}
              className={styles.mobileNavButton}
              type="button"
              aria-haspopup="dialog"
              aria-expanded={tradeOpen}
              onClick={() => setTradeOpen(true)}
            >
              Trade
            </button>
          </li>
          {mobileViewButton("theses", "Thesis")}
        </ul>
      </nav>
    </div>
  );
}
