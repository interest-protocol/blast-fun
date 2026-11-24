"use client";
import { Button, DisclosureButton, IconButton } from "#web/components/blast-ui/Button.tsx";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from "react";
import { Feedback, PointerActivationConstraints, PointerSensor } from "@dnd-kit/dom";
import { useDraggable, type DragDropEventHandlers } from "@dnd-kit/react";
import { Popover, PopoverSurface } from "#web/components/blast-ui/Popover.tsx";
import { BlastMenu, BlastMenuTrigger, BlastMenuItem, BlastMenuLinkItem, BlastMenuSeparator } from "#web/components/blast-ui/BlastMenu.tsx";
import { GripIcon, DotsIcon, CloseIcon, ExternalIcon } from "#web/components/blast-ui/Icons.tsx";
import { presalePath } from "@blast/core/modules/social/items/do-the-same.ts";
import { IntentLink } from "#web/components/blast-ui/NavigationLink.tsx";
import { PanelMark } from "./PanelMark";
import { usePanelIdentities, panelSymbol } from "./panel-identities";
import { flushSync } from "react-dom";
import { DragDropProvider } from "#web/components/ui-libraries/DragDropProvider.tsx";
import { createPanelSort, type PanelSortPoint } from "./panel-sort";
import { PanelIcon } from "./panels/PanelChrome";
import { PanelAssetContext, PanelHeaderSlotContext, PanelHeadingContext } from "./panels/panel-context";
import { createPortal } from "react-dom";
import { useWorkspace } from "./workspace-context";
import { WorkspaceTradeDockContext } from "./workspace-trade-dock-context";
import { CopyButton } from "#web/components/blast-ui/CopyButton.tsx";
import { keyboardInput } from "#web/components/blast-ui/feedback-motion.ts";
import { prefersReducedMotion } from "#web/components/blast-ui/use-shell-prefs.ts";
import { boxOf, fadeIn, growFromCard, radiusOf, shrinkToCard, type Box } from "./expand-motion";
import type { PanelSetup, WorkspaceV1 } from "@blast/core/modules/social/blast-workspace/setup.ts";
import type { WorkspaceStore } from "./model";
import styles from "./TrackedPanels.module.css";
import hostStyles from "./WorkspaceHost.module.css";

function markSorting(element: HTMLElement, active: boolean) {
  element.dataset.panelSorting = "true";
  if (active) element.dataset.panelDragging = "true";
}

const PANEL_SENSORS = [PointerSensor.configure({ activationConstraints: () => [new PointerActivationConstraints.Distance({ value: 4 })] })];
const PanelSortContext = createContext<Readonly<{ disabled: boolean; register: (id: string, element: HTMLElement | null) => void }> | null>(null);
type SortGesture = {
  id: string;
  initial: PanelSortPoint;
  origin: PanelSortPoint;
  offset: PanelSortPoint;
  sort: NonNullable<ReturnType<typeof createPanelSort>>;
  stop: () => void;
};

/** Projects movement on the existing keyed tiles; only a completed drop writes order. */
export function PanelSortProvider({ order, dispatch, disabled = false, children }: Readonly<{
  order: readonly string[];
  dispatch: WorkspaceStore;
  disabled?: boolean;
  children: ReactNode;
}>) {
  const elements = useRef(new Map<string, HTMLElement>());
  const gesture = useRef<SortGesture | null>(null);
  const reset = useCallback(() => {
    for (const element of elements.current.values()) {
      delete element.dataset.panelSorting;
      delete element.dataset.panelDragging;
      element.style.removeProperty("--panel-sort-x");
      element.style.removeProperty("--panel-sort-y");
    }
  }, []);
  const cancel = useCallback(() => {
    const active = gesture.current;
    gesture.current = null;
    reset();
    active?.stop();
  }, [reset]);
  const register = useCallback((id: string, element: HTMLElement | null) => {
    if (element) elements.current.set(id, element);
    else {
      if (gesture.current) cancel();
      elements.current.delete(id);
    }
  }, [cancel]);
  useLayoutEffect(() => {
    cancel();
    return cancel;
  }, [order, disabled, dispatch, cancel]);
  const context = useMemo(() => ({ disabled, register }), [disabled, register]);
  const onDragStart: DragDropEventHandlers["onDragStart"] = ({ operation }, manager) => {
    if (disabled) return;
    const id = String(operation.source?.id ?? "");
    const boxes = order.flatMap(key => {
      const element = elements.current.get(key);
      if (!element) return [];
      const { left, top, width, height } = element.getBoundingClientRect();
      return [{ id: key, left, top, width, height }];
    });
    const sort = createPanelSort(id, order, boxes);
    const box = boxes.find(box => box.id === id);
    if (!sort || !box) { manager.actions.stop({ canceled: true }); return; }
    gesture.current = { id, initial: operation.position.initial, origin: { x: box.left, y: box.top }, offset: { x: 0, y: 0 }, sort, stop: () => manager.actions.stop({ canceled: true }) };
    for (const [key, element] of elements.current) {
      markSorting(element, key === id);
    }
  };
  const onDragMove: DragDropEventHandlers["onDragMove"] = ({ operation, to }) => {
    const active = gesture.current;
    if (!active) return;
    const element = elements.current.get(active.id);
    if (!element) { cancel(); return; }
    const pointer = to ?? operation.position.current;
    const box = element.getBoundingClientRect();
    // Account for page/container scrolling without changing the grab offset.
    const delta = { x: pointer.x - active.initial.x - (box.left - active.offset.x - active.origin.x), y: pointer.y - active.initial.y - (box.top - active.offset.y - active.origin.y) };
    const projection = active.sort.move(delta);
    active.offset = delta;
    for (const [id, offset] of projection.offsets) {
      const tile = elements.current.get(id);
      tile?.style.setProperty("--panel-sort-x", `${offset.x}px`);
      tile?.style.setProperty("--panel-sort-y", `${offset.y}px`);
    }
  };
  const onDragEnd: DragDropEventHandlers["onDragEnd"] = ({ canceled }) => {
    const active = gesture.current;
    gesture.current = null;
    if (active) {
      flushSync(() => active.sort.finish(dispatch, canceled));
      reset();
      elements.current.get(active.id)?.querySelector<HTMLElement>("[data-panel-drag-handle]")?.focus({ preventScroll: true });
    }
  };
  return <DragDropProvider sensors={PANEL_SENSORS} plugins={defaults => defaults.filter(plugin => plugin !== Feedback)} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd}><PanelSortContext.Provider value={context}>{children}</PanelSortContext.Provider></DragDropProvider>;
}

export function MorePanels({
  snapshot,
  dispatch,
}: Readonly<{ snapshot: WorkspaceV1; dispatch: WorkspaceStore }>) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const identities = usePanelIdentities();
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const region = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<number | null>(null);
  const openedPanel = useRef<string | null>(null);
  const total = snapshot.retained_order.length;
  const lastPage = Math.max(0, Math.ceil(total / 8) - 1);
  const currentPage = Math.min(page, lastPage);
  const entries = snapshot.retained_order.slice(
    currentPage * 8,
    currentPage * 8 + 8,
  );
  useLayoutEffect(() => {
    if (pendingFocus.current === null) return;
    const rows = region.current?.querySelectorAll<HTMLButtonElement>(
      "li > button:first-of-type",
    );
    const index = Math.min(pendingFocus.current, (rows?.length ?? 0) - 1);
    (rows?.[index] ?? region.current?.querySelector<HTMLButtonElement>("[data-close-saved]") ?? trigger.current)?.focus();
    pendingFocus.current = null;
  }, [snapshot]);
  if (total === 0 && !open) return null;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
    <div
      className={styles.more}
      onKeyDownCapture={(event) => {
        if (!open || event.defaultPrevented || event.key !== "Escape") return;
        // A layer opened from a row (Inspect identity) closes first, on its own; this list closes on the next Escape (audit F4).
        const layer = event.target instanceof Element ? event.target.closest('[role="dialog"], [role="menu"], [role="listbox"]') : null;
        if (layer && !layer.contains(region.current)) return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        (total ? trigger.current : document.querySelector<HTMLButtonElement>("[data-add-chart]"))?.focus();
      }}
    >
      <Popover.Trigger render={<DisclosureButton variant="ghost" size="chip">
          <span aria-hidden="true" className={styles.savedMarks}>
            {snapshot.retained_order.slice(0, 3).map((panelId) => (
              <PanelMark identities={identities} key={panelId} panel={snapshot.panels[panelId]!} size={18} />
            ))}
          </span>
          <span className={styles.savedWord}>Recent</span>
          <span className={styles.savedCount}>{total}</span>
        </DisclosureButton>}
        data-more-panels-trigger=""
        aria-controls={id}
        aria-expanded={open}
        aria-label={`Recent panels (${total})`}
        className={styles.savedTrigger}
        onClick={() => { openedPanel.current = null; setPage(0); }}
        ref={trigger}
        type="button"
      />
      <PopoverSurface
        positioner={{ side: "bottom", align: "end", sideOffset: 8, collisionPadding: 16, className: styles.savedLayer }}
        popup={{
          "aria-label": "Recent panels",
          "data-blast-popover": "",
          "data-open": String(open),
          className: styles.disclosure,
          id,
          ref: region,
          role: "region",
          initialFocus: () => region.current?.querySelector<HTMLButtonElement>("li > button:first-of-type") ?? trigger.current,
          finalFocus: () => {
            const panelId = openedPanel.current;
            return (panelId ? document.querySelector<HTMLElement>(`[data-panel-id="${CSS.escape(panelId)}"]`) : null) ?? (total ? trigger.current : document.querySelector<HTMLButtonElement>("[data-add-chart]"));
          },
          onKeyDown: (event) => {
            if (event.key === "Tab") event.stopPropagation();
          },
        }}
      >
        <div className={styles.clip}>
          <div className={styles.history}>
            <h2>Recent panels</h2>
            {total === 0 ? (
              <p>No recent panels.</p>
            ) : (
              <>
                <ul className={styles.list}>
                  {entries.map((panelId, rowIndex) => {
                    const panel = snapshot.panels[panelId]!;
                    const name = panelSymbol(panel, identities);
                    const [address] = panel.coin_type.split("::");
                    return (
                      <li data-retained-panel-id={panelId} key={panelId}>
                        <PanelMark identities={identities} panel={panel} />
                        <div className={styles.identity}>
                          <strong>{name}</strong>
                          {/* The contract sits in the row with its own copy, so coins sharing a symbol read apart without a second layer (audit F3). */}
                          <span className={styles.coinType}>
                            {panel.active_namespace === "presale" ? "Presale" : "Coin"} ·{" "}
                            <span className="num">{address ? `${address.slice(0, 6)}…${address.slice(-4)}` : panel.network}</span>
                            <CopyButton size="sm" label={`Copy ${name} coin type`} onCopy={async () => { await navigator.clipboard.writeText(panel.coin_type); return true; }} />
                          </span>
                        </div>
                        <Button variant="primary" size="sm"
                          aria-label={`Open ${name} panel`}

                          onClick={() => {
                            openedPanel.current = dispatch.add(panel);
                            setOpen(false);
                          }}
                          type="button"
                        >
                          Open
                        </Button>
                        <IconButton variant="secondary" size="sm"
                          aria-label={`Remove ${name} from Recent`}
                          title="Remove"
                          onClick={(event) => {
                            if (document.activeElement === event.currentTarget) {
                              pendingFocus.current = rowIndex;
                            }
                            dispatch.remove(panelId);
                          }}
                          type="button"
                        >
                          <CloseIcon />
                        </IconButton>
                      </li>
                    );
                  })}
                </ul>
                {/* Eight fit on one page; a pager with two dead arrows there only adds noise (audit detail pass). */}
                {lastPage > 0 && <nav aria-label="Recent panel pages" className={styles.pages}>
                  <Button variant="secondary" size="sm"
                    aria-label="Previous recent panels"

                    disabled={currentPage === 0}
                    onClick={() => setPage(currentPage - 1)}
                    type="button"
                  >
                    ←
                  </Button>
                  <span role="status">
                    {currentPage * 8 + 1}–
                    {Math.min((currentPage + 1) * 8, total)} of {total}
                  </span>
                  <Button variant="secondary" size="sm"
                    aria-label="Next recent panels"

                    disabled={currentPage === lastPage}
                    onClick={() => setPage(currentPage + 1)}
                    type="button"
                  >
                    →
                  </Button>
                </nav>}
              </>
            )}
            <Button variant="secondary" size="sm"

              data-close-saved=""
              onClick={() => {
                setOpen(false);
                (total ? trigger.current : document.querySelector<HTMLButtonElement>("[data-add-chart]"))?.focus();
              }}
              type="button"
            >
              Close recent panels
            </Button>
          </div>
        </div>
      </PopoverSurface>
    </div>
    </Popover.Root>
  );
}

/** A card may still be mounted for a frame after removal (a closing menu can return focus into it). */
function focusPanel(dispatch: WorkspaceStore, id: string) {
  const snapshot = dispatch.getSnapshot();
  if (snapshot.focused_panel_id !== id && snapshot.visible_order.includes(id)) dispatch.focus(id);
}

/** What an expand moves: in the focus board the chart's section alone leaves the card; elsewhere the whole panel. */
function expandTarget(panel: HTMLElement): HTMLElement | null {
  return panel.dataset.expand === "chart" ? panel.querySelector<HTMLElement>('[data-workspace-section="chart"]') : panel;
}

export function TrackedPanel({
  panel,
  dispatch,
  children,
}: Readonly<{
  panel: PanelSetup;
  dispatch: WorkspaceStore;
  getDraggedPanel: () => string | null;
  onDragChange: (id: string | null) => void;
  children: ReactNode;
}>) {
  const dock = useContext(WorkspaceTradeDockContext);
  const workspace = useWorkspace();
  const { expanded, expandedTop, selfRef, changeExpanded } = usePanelExpansion();
  const [heading, setHeading] = useState<HTMLDivElement | null>(null);
  // In the focus board the chart card hosts this header (identity, full screen, options) as its top row.
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  const sorting = useContext(PanelSortContext);
  const { ref: dragRef, handleRef } = useDraggable({ id: panel.panel_id, disabled: !sorting || sorting.disabled });
  const register = sorting?.register;
  const sectionRef = useCallback((element: HTMLElement | null) => {
    selfRef.current = element;
    dragRef(element);
    register?.(panel.panel_id, element);
  }, [dragRef, register, panel.panel_id, selfRef]);
  const identities = usePanelIdentities();
  const name = panelSymbol(panel, identities);
  const panelHeader = <TrackedPanelHeader name={name} panel={panel} dispatch={dispatch} dragDisabled={!sorting || sorting.disabled} handleRef={handleRef} setHeading={setHeading} expanded={expanded} changeExpanded={changeExpanded} selfRef={selfRef} />;

  return (
    <section
      aria-label="Asset panel"
      className={`${hostStyles.panel} ${styles.sortable}`}
      style={expanded ? { "--expanded-top": `${expandedTop}px` } as CSSProperties : undefined}
      data-expanded={expanded}
      // In the focus board the panel's header lives in the chart card: expanding shows that card alone, over the whole page.
      data-expand={headerSlot ? "chart" : undefined}
      onKeyDown={event => { if (expanded && event.key === "Escape" && !event.defaultPrevented && !(event.target instanceof Element && event.target.closest('[role="dialog"],dialog,[role="menu"],[role="listbox"]'))) { event.preventDefault(); event.stopPropagation(); changeExpanded(false); } }}
      data-focus-hidden={workspace.snapshot.presentation === "focus" && (workspace.presentation.mobile ? workspace.snapshot.mobile_panel_id : workspace.snapshot.focused_panel_id) !== panel.panel_id}
      data-page-hidden={workspace.presentation.paged_panel_ids !== undefined && !workspace.presentation.paged_panel_ids.includes(panel.panel_id)}
      data-namespace={panel.active_namespace}
      data-panel-id={panel.panel_id}
      data-active={dock ? (dock.selectedId ?? dock.activeId) === panel.panel_id : dispatch.getSnapshot().focused_panel_id === panel.panel_id}
      onFocusCapture={()=>focusPanel(dispatch,panel.panel_id)}
      onPointerDownCapture={()=>focusPanel(dispatch,panel.panel_id)}
      ref={sectionRef}
      tabIndex={-1}
    >
      {headerSlot ? createPortal(panelHeader, headerSlot) : panelHeader}
      <div
        className={hostStyles.panelContent}
      >
        <PanelHeaderSlotContext value={setHeaderSlot}><PanelHeadingContext value={heading}><PanelAssetContext value={workspace.selectAsset ? () => { changeExpanded(false); workspace.selectAsset!(panel.panel_id); } : null}>{children}</PanelAssetContext></PanelHeadingContext></PanelHeaderSlotContext>
      </div>
    </section>
  );
}

function usePanelExpansion() {
  const [expanded, setExpanded] = useState(false);
  const [expandedTop, setExpandedTop] = useState(72);
  const selfRef = useRef<HTMLElement | null>(null);
  // The card an expand leaves (measured before it goes), and the expand's motion while it runs.
  const leaving = useRef<Readonly<{ card: Box; radius: number }> | null>(null);
  const motion = useRef<Animation | null>(null);
  const changeExpanded = useCallback((next: boolean) => {
    const panel = selfRef.current;
    const target = panel ? expandTarget(panel) : null;
    if (next) {
      if (panel === null) return setExpanded(true);
      leaving.current = target ? { card: boxOf(target), radius: radiusOf(target) } : null;
      // The fixed panel sits under the board's header from its first frame, so the grow lands where it ends.
      const layout = panel.closest<HTMLElement>("[data-data-open]");
      if (layout) setExpandedTop(Math.ceil(layout.getBoundingClientRect().top));
      return setExpanded(true);
    }
    if (panel === null || target === null || getComputedStyle(target).position !== "fixed" || keyboardInput() || prefersReducedMotion()) {
      motion.current?.cancel();
      motion.current = null;
      return setExpanded(false);
    }
    // Shrinks into the card, then restores; the card is measured with the panel back in place for one synchronous layout.
    const shrink = shrinkToCard(target, () => {
      panel.dataset.expanded = "false";
      const card = { card: boxOf(target), radius: radiusOf(target) };
      panel.dataset.expanded = "true";
      return card;
    });
    motion.current = shrink;
    shrink.onfinish = () => setExpanded(false);
  }, []);
  useLayoutEffect(() => {
    const card = leaving.current;
    leaving.current = null;
    if (!expanded) {
      // A finished shrink holds its last frame until the card is back; nothing is left behind.
      motion.current?.cancel();
      motion.current = null;
      return;
    }
    const target = selfRef.current ? expandTarget(selfRef.current) : null;
    if (card === null || target === null || getComputedStyle(target).position !== "fixed" || keyboardInput()) return;
    motion.current = prefersReducedMotion() ? fadeIn(target) : growFromCard(target, card.card, card.radius);
  }, [expanded]);
  useEffect(() => () => motion.current?.cancel(), []);
  useLayoutEffect(() => {
    if (!expanded) return;
    const element = selfRef.current;
    const layout = element?.closest<HTMLElement>("[data-data-open]");
    if (!layout) return;
    const measure = () => setExpandedTop(Math.ceil(layout.getBoundingClientRect().top));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layout);
    const frame = element?.closest("[data-workspace-host]");
    if (frame) for (const child of frame.querySelectorAll("header")) observer.observe(child);
    // Inserting Following can move a content-sized layout without resizing it.
    const siblings = new MutationObserver(measure);
    if (layout.parentElement) siblings.observe(layout.parentElement, { childList: true });
    window.addEventListener("resize", measure);
    return () => { observer.disconnect(); siblings.disconnect(); window.removeEventListener("resize", measure); };
  }, [expanded]);
  return { expanded, expandedTop, selfRef, changeExpanded };
}

function TrackedPanelHeader({ name, panel, dispatch, dragDisabled, handleRef, setHeading, expanded, changeExpanded, selfRef }: Readonly<{
  name: string; panel: PanelSetup; dispatch: WorkspaceStore; dragDisabled: boolean;
  handleRef: (element: Element | null) => void; setHeading: (element: HTMLDivElement | null) => void;
  expanded: boolean; changeExpanded: (next: boolean) => void; selfRef: import("react").RefObject<HTMLElement | null>;
}>) {
  const remove = () => {
    // The menu is portalled; focusing the card first lets removal hand focus to the slot's refill control.
    selfRef.current?.focus({ preventScroll: true });
    dispatch.remove(panel.panel_id);
  };
  return (
    <header className={hostStyles.panelControls}>
      <IconButton variant="ghost" size="sm"
        aria-label={`Drag ${name} panel`}
        className={styles.grip}
        data-panel-drag-handle=""
        disabled={dragDisabled}
        ref={handleRef}
        title="Drag to move this panel; Escape cancels."
        type="button"
      >
        <GripIcon />
      </IconButton>
      <div className={hostStyles.panelIdentity} ref={setHeading} />
      <IconButton variant="ghost" size="sm" type="button" className={styles.iconButton} aria-label={`${expanded ? "Restore" : "Expand"} ${name} panel`} title={expanded ? "Restore panel" : "Expand panel"} aria-pressed={expanded} onClick={() => changeExpanded(!expanded)}>
        <PanelIcon name={expanded ? "restore" : "expand"} />
      </IconButton>
      {/* One panel's own commands (audit 16): its page and its removal; nothing rearranges the board. A coin has only
          the removal, so it is the button itself instead of a menu of one (audit F12). */}
      {panel.presale_id ? (
        <BlastMenu anchored label={`Options for ${name} panel`} className={styles.panelMenu} placement={() => ({ side: "bottom", align: "end", sideOffset: 6, avoid: "flip", originX: "100%" })} trigger={<BlastMenuTrigger render={<IconButton aria-label={`Options for ${name} panel`} variant="ghost" size="sm" />} className={styles.iconButton} aria-label={`Options for ${name} panel`}><DotsIcon /></BlastMenuTrigger>}>
          <BlastMenuLinkItem className={styles.menuItem} render={<IntentLink href={presalePath(panel.presale_id)} />}>
            <ExternalIcon />Open {name} page
          </BlastMenuLinkItem>
          <BlastMenuSeparator className={styles.menuSeparator} />
          <BlastMenuItem className={styles.menuItem} data-destructive="" onClick={remove}><CloseIcon />Remove {name} panel</BlastMenuItem>
        </BlastMenu>
      ) : (
        <IconButton variant="ghost" size="sm" type="button" className={styles.iconButton} aria-label={`Remove ${name} panel`} title="Remove panel" onClick={remove}>
          <CloseIcon />
        </IconButton>
      )}
    </header>
  );
}
