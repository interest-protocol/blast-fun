"use client";

import { type BoardLength, type Band, boardBands, boardSizes, clampLength, narrowWorkspaceBoard, withLength } from "./workspace-board.ts";
import { Button } from "#web/components/blast-ui/Button.tsx";

import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentType, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { SearchIcon } from "#web/components/blast-ui/Icons.tsx";
import { DEFAULT_WORKSPACE_LAYOUT, type TerminalColumn, type WorkspaceLayout, type WorkspaceSection } from "@blast/core/modules/social/blast-workspace/workspace-layout-model.ts";
import type { WorkspaceStore } from "./model";
import { WorkspaceContext } from "./workspace-context";
import { DISCOVER_SHEET_QUERY } from "./discover-default";
import styles from "./WorkspaceLayout.module.css";

const LayoutContext = createContext<Readonly<{
  layout: WorkspaceLayout;
  setLayout: (layout: WorkspaceLayout) => void;
}> | null>(null);

export function WorkspaceLayoutProvider({ saved, store, children }: Readonly<{ saved?: WorkspaceLayout; store: WorkspaceStore; children: ReactNode }>) {
  return <LayoutContext value={{ layout: saved ?? DEFAULT_WORKSPACE_LAYOUT, setLayout: next => store.setLayout(next) }}>{children}</LayoutContext>;
}

export function useWorkspaceSectionVisible(section: "activity" | "details") {
  return !useContext(LayoutContext)?.layout.hidden.includes(section);
}
const STEP_PX = 8;

export type WorkspaceLayoutTriggerProps = Readonly<{
  layoutDisabled: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  /** The board's ticket width or holders height differs from the approved board's. */
  resized: boolean;
  onRestoreSizes: () => void;
  activityShown: boolean;
  onActivityShown: (shown: boolean) => void;
}>;

/** The workspace bar's Layout menu: the board's lengths and the holders card's visibility. */
export function WorkspaceLayoutTools({ disabled = false, className, trigger: Trigger }: Readonly<{
  disabled?: boolean;
  className?: string;
  trigger: ComponentType<WorkspaceLayoutTriggerProps>;
}>) {
  const context = useContext(LayoutContext);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!context) return null;
  const { layout, setLayout } = context;
  return <div className={`${styles.tools} ${className ?? ""}`}>
    <Trigger
      layoutDisabled={disabled}
      triggerRef={trigger}
      resized={layout.heights?.trade !== undefined || layout.heights?.activity !== undefined}
      onRestoreSizes={() => setLayout({ ...layout, heights: undefined })}
      activityShown={!layout.hidden.includes("activity")}
      onActivityShown={shown => setLayout({ ...layout, hidden: shown ? layout.hidden.filter(item => item !== "activity") : [...layout.hidden, "activity"] })}
    />
  </div>;
}

/** The root font size the fluid Blast UI scale is drawing at (16px at the 1440px board). */
function rootFontPx() {
  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return 16;
  return Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
}

/** The viewport's height in board px (the 1156px board at 1440 wide). */
function viewportBoardHeight() {
  if (typeof window === "undefined") return 1156;
  return window.innerHeight / (rootFontPx() / 16);
}

/**
 * The approved board (BlastMode.dc.html), drawn by CSS grid in one fixed arrangement: the chart
 * card with the holders card under it, and the ticket column beside both. Two splitters resize
 * the ticket column and the holders card a little; narrow containers stack the board.
 */
export function CoinWorkspaceLayout({ sections, presale = false, detailsFallback, onActivitySelect, pendingLayout }: Readonly<{ pendingLayout?: WorkspaceLayout; sections: Record<WorkspaceSection, ReactNode>; presale?: boolean; detailsFallback?: ReactNode; onActivitySelect?: () => void }>) {
  const { layout, activityHidden, bands, sizes, grid, board, drag, setDrag, narrow, shownView, ids, setView, commit } = useCoinBoard(pendingLayout);
  const splitter = (length: BoardLength) => <BoardSplitter
    length={length}
    value={sizes[length]}
    controls={length === "ticket" ? ids.trade : ids.activity}
    label={length === "ticket" ? (presale ? "Resize the participation column" : "Resize the trade column") : (presale ? "Resize the participants card" : "Resize the holders card")}
    band={bands[length]}
    onDrag={value => setDrag(value === null ? null : { length, value: clampLength(bands[length], value) })}
    onCommit={value => { setDrag(null); commit(length, value); }}
  />;
  return <div className={styles.workspace}>
    <div ref={grid} className={pendingLayout ? styles.pendingBoard : undefined} data-terminal-grid={narrow ? "stacked" : "desktop"} data-compact-view={narrow ? shownView : undefined} data-board="">
      <div ref={board} className={styles.board} data-activity-hidden={activityHidden || undefined} data-resizing={drag ? drag.length : undefined}>
        {(["chart", "trade", "activity"] as const).map(section => <div key={section} id={ids[section]} className={styles.section} data-workspace-section={section} inert={activityHidden && section === "activity"} aria-hidden={activityHidden && section === "activity" || undefined}>
          <div className={styles.content} data-section-content>{sections[section]}</div>
        </div>)}
        {!pendingLayout && !narrow && splitter("ticket")}
        {!pendingLayout && !narrow && !activityHidden && splitter("holders")}
      </div>
    </div>
    <WorkspaceDetails hidden={layout.hidden.includes("details")} fallback={detailsFallback}>{sections.details}</WorkspaceDetails>
    {!pendingLayout && narrow && <MobileSectionNav grid={grid} view={shownView} onView={setView} activity={!activityHidden} presale={presale} onActivitySelect={onActivitySelect} />}
  </div>;
}

/**
 * One splitter on the board's gap: a separator whose value is the length it sets, in board px.
 * Dragging follows the pointer (Escape restores the start); arrows step 8px, Home and End reach
 * the limits. Moving left or up makes the ticket column or the holders card larger.
 */
function BoardSplitter({ length, band: { min, max }, value, controls, label, onDrag, onCommit }: Readonly<{
  length: BoardLength;
  band: Band;
  value: number;
  controls: string;
  label: string;
  onDrag: (value: number | null) => void;
  onCommit: (value: number) => void;
}>) {
  const start = useRef<Readonly<{ pointer: number; value: number; id: number }> | null>(null);
  const vertical = length === "ticket";
  const position = (event: PointerEvent<HTMLDivElement>) => vertical ? event.clientX : event.clientY;
  const valueAt = (event: PointerEvent<HTMLDivElement>) => start.current!.value - (position(event) - start.current!.pointer) / (rootFontPx() / 16);
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && start.current) {
      event.preventDefault(); event.stopPropagation();
      start.current = null;
      onDrag(null);
      return;
    }
    const grow = vertical ? "ArrowLeft" : "ArrowUp";
    const shrink = vertical ? "ArrowRight" : "ArrowDown";
    const next = event.key === grow ? value + STEP_PX : event.key === shrink ? value - STEP_PX : event.key === "Home" ? min : event.key === "End" ? max : null;
    if (next === null) return;
    event.preventDefault(); event.stopPropagation();
    onCommit(next);
  }
  return <div
    role="separator"
    tabIndex={0}
    aria-label={label}
    aria-orientation={vertical ? "vertical" : "horizontal"}
    aria-controls={controls}
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={value}
    aria-valuetext={`${value} pixels ${vertical ? "wide" : "high"}`}
    className={styles.splitter}
    data-board-splitter={length}
    onKeyDown={keyDown}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus({ preventScroll: true });
      start.current = { pointer: position(event), value, id: event.pointerId };
      onDrag(value);
    }}
    onPointerMove={event => { if (start.current?.id === event.pointerId) onDrag(valueAt(event)); }}
    onPointerUp={event => {
      if (start.current?.id !== event.pointerId) return;
      const next = valueAt(event);
      start.current = null;
      onCommit(next);
    }}
    onPointerCancel={() => { start.current = null; onDrag(null); }}
  />;
}

function WorkspaceDetails({ hidden, fallback, children }: Readonly<{ hidden: boolean; fallback?: ReactNode; children: ReactNode }>) {
  if (hidden ? !fallback : !children) return null;
  return <div className={styles.details} data-workspace-section={hidden ? undefined : "details"}>{hidden ? fallback : children}</div>;
}

/**
 * The compact section bar (Blast mode audit 24/26, 2026-10-28): Discover opens its sheet;
 * Chart, Trade and Activity each show their section alone, so the selected task is always the
 * one on screen. The selection is the view itself, not a scroll position.
 */
function MobileSectionNav({ grid, view, onView, activity, presale, onActivitySelect }: Readonly<{ grid: RefObject<HTMLDivElement | null>; view: TerminalColumn; onView: (view: TerminalColumn) => void; activity: boolean; presale: boolean; onActivitySelect?: () => void }>) {
  const workspace = useContext(WorkspaceContext);
  const [navigation, setNavigation] = useState<{ section: TerminalColumn } | null>(null);
  function show(section: TerminalColumn) {
    if (section === "activity") onActivitySelect?.();
    onView(section);
    setNavigation({ section });
  }
  useLayoutEffect(() => {
    if (!navigation) return;
    const { section } = navigation;
    const target = grid.current?.querySelector<HTMLElement>(`[data-workspace-section="${section}"]`);
    if (!target) return;
    target.closest<HTMLElement>("[data-workspace-scroll]")?.scrollTo({ top: 0, behavior: "instant" });
    const input = section === "trade" ? target.querySelector<HTMLInputElement>("[data-panel-amount]") : null;
    if (input && !input.disabled) input.focus({ preventScroll: true });
    else { target.tabIndex = -1; target.focus({ preventScroll: true }); }
  }, [navigation, grid]);
  const label = (section: TerminalColumn) => section === "chart" ? (presale ? "Funding" : "Chart") : section === "trade" ? (presale ? "Participate" : "Trade") : "Activity";
  const button = (section: TerminalColumn) => <Button variant="ghost" size="sm" type="button" aria-current={view === section ? "true" : undefined} onClick={() => show(section)}><span>{label(section)}</span></Button>;
  return <nav className={styles.mobileNav} aria-label="Selected market navigation">
    <Button variant="ghost" size="sm" type="button" aria-haspopup="dialog" onClick={() => {
      workspace?.dispatch.setDataViewEnabled("Coins", true);
      workspace?.dispatch.selectDataView("Coins");
      workspace?.dispatch.setDataCollapsed(false);
    }}><SearchIcon /><span>Discover</span></Button>
    {button("chart")}
    {button("trade")}
    {activity && button("activity")}
    <span className="sr" role="status">{view === "trade" ? (presale ? "Participation" : "Trade form") : view === "activity" ? (presale ? "Market activity" : "Holders, trades and coin info") : (presale ? "Funding" : "Chart")}</span>
  </nav>;
}

function useViewportBoardHeight() {
  const [viewportHeight, setViewportHeight] = useState(viewportBoardHeight);
  useEffect(() => {
    const measure = () => setViewportHeight(viewportBoardHeight());
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return viewportHeight;
}

function useBoardWidth(grid: RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = grid.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [grid]);
  return width;
}

function useCoinBoard(pendingLayout: WorkspaceLayout | undefined) {
  const context = useContext(LayoutContext);
  const layout = context?.layout ?? pendingLayout ?? DEFAULT_WORKSPACE_LAYOUT;
  const activityHidden = layout.hidden.includes("activity");
  const viewportHeight = useViewportBoardHeight();
  const bands = boardBands(viewportHeight);
  const saved = boardSizes(layout, bands);
  const [drag, setDrag] = useState<Readonly<{ length: BoardLength; value: number }> | null>(null);
  const sizes = drag ? { ...saved, [drag.length]: drag.value } : saved;
  const grid = useRef<HTMLDivElement>(null);
  const board = useRef<HTMLDivElement>(null);
  const width = useBoardWidth(grid);
  // Unmeasured (0) is not narrow: the layout effect measures before the first paint. Where Discover
  // is a sheet (below 1100px), a board under 960px is one task view at a time (Blast mode audit,
  // 2026-10-28): Chart, Trade or Activity from the section bar. Beside Discover's column it stays
  // the side-by-side board down to 680px, so opening Discover on a laptop keeps the ticket in view.
  const sheetDiscover = useContext(WorkspaceContext)?.presentation.mobile ?? (typeof window !== "undefined" && window.matchMedia?.(DISCOVER_SHEET_QUERY).matches === true);
  const narrow = width > 0 && narrowWorkspaceBoard(width / (rootFontPx() / 16), sheetDiscover);
  const [view, setView] = useState<TerminalColumn>("chart");
  const shownView = activityHidden && view === "activity" ? "chart" : view;
  const ids = { chart: useId(), trade: useId(), activity: useId() };
  // The page's CSP allows no inline style attribute, so the lengths reach the grid through the DOM.
  useLayoutEffect(() => {
    board.current?.style.setProperty("--board-ticket", `${sizes.ticket / 16}rem`);
    board.current?.style.setProperty("--board-holders", `${sizes.holders / 16}rem`);
  }, [sizes.ticket, sizes.holders]);
  const commit = (length: BoardLength, value: number) => {
    const next = clampLength(bands[length], value);
    if (next !== saved[length]) context?.setLayout(withLength(layout, length, next, bands));
  };
  return { layout, activityHidden, bands, sizes, grid, board, drag, setDrag, narrow, shownView, ids, setView, commit };
}
