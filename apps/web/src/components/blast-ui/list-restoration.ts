"use client";

import { useLayoutEffect, useRef, useSyncExternalStore } from "react";

type Position = Readonly<{ top: number; left: number; row: string | null; offset: number; focus: string | null }>;
type SavedList<T> = Readonly<{ value: T; position: Position; positionKey?: string }>;
const STATE_KEY = "blastLists";
const LIST_TRAVERSAL_EVENT = "blast:list-traversal";
const pendingScrollPositions = new Map<string, Position>();
export const captureLists = () => window.dispatchEvent(new window.Event("blast:capture-lists"));

let traversedEntry: {
  href: string;
  entry: string | undefined;
  snapshot?: Readonly<{ lists: unknown; content: unknown }>;
} | undefined;
let checkedDocumentTraversal = false;

function recordTraversal(state: { blastLists?: unknown; blastListContent?: unknown } | null): void {
  // The router can replace the entry before it mounts the destination.
  traversedEntry = {
    href: window.location.href,
    entry: window.navigation?.currentEntry?.key,
    snapshot: { lists: state?.[STATE_KEY], content: state?.blastListContent },
  };
}

export function useListTraversal(matchesPath: (pathname: string) => boolean): void {
  useLayoutEffect(() => {
    const traversed = (event: PopStateEvent) => {
      if (!matchesPath(window.location.pathname)) return;
      recordTraversal(event.state);
      // The router may have mounted the destination during this event.
      window.dispatchEvent(new window.Event(LIST_TRAVERSAL_EVENT));
    };
    window.addEventListener("popstate", traversed, true);
    return () => window.removeEventListener("popstate", traversed, true);
  }, [matchesPath]);
}

function currentTraversal() {
  if (traversedEntry?.href === window.location.href && traversedEntry.entry === window.navigation?.currentEntry?.key) return traversedEntry;
  traversedEntry = undefined;
}

function recordDocumentTraversal(): void {
  if (checkedDocumentTraversal) return;
  checkedDocumentTraversal = true;
  const [navigation] = (window.performance.getEntriesByType?.("navigation") ?? []) as PerformanceNavigationTiming[];
  if (navigation?.type === "back_forward" && navigation.name === window.location.href && !currentTraversal()) {
    recordTraversal(window.history.state);
  }
}

function restoreTraversedLists(): boolean {
  const traversal = currentTraversal();
  const snapshot = traversal?.snapshot;
  if (!traversal || !snapshot) return false;
  // A child content hook may claim the saved state before its parent list mounts.
  traversal.snapshot = undefined;
  const state = window.history.state ?? {};
  if ((!state[STATE_KEY] && snapshot.lists) || (!state.blastListContent && snapshot.content)) {
    window.history.replaceState({
      ...state,
      [STATE_KEY]: state[STATE_KEY] ?? snapshot.lists,
      blastListContent: state.blastListContent ?? snapshot.content,
    }, "");
    return true;
  }
  return false;
}

/** Form-driven navigation uses the same contextual return path as a list link. */
export function rememberListOrigin(href: string): void {
  captureLists();
  stageListOrigin(href);
}

function stageListOrigin(href: string): void {
  try {
    window.sessionStorage.setItem("blast:list-origin", JSON.stringify({
      from: window.location.href,
      fromEntry: window.navigation?.currentEntry?.key,
      to: new URL(href, window.location.href).href,
      at: Date.now(),
    }));
  } catch { /* Storage may be unavailable. */ }
}

/** Preserve Next's private history fields; each entry owns its own list snapshots. */
export function savedList<T>(identity: string): SavedList<T> | undefined {
  return typeof window === "undefined" ? undefined : window.history.state?.[STATE_KEY]?.[identity];
}

function scroller(root: HTMLElement): HTMLElement {
  for (let node = root.parentElement; node; node = node.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) return node;
  }
  return (document.scrollingElement ?? document.documentElement) as HTMLElement;
}

const restorableRow = "[data-list-row]:not([data-visual-copy] *)";

function rowAt(root: HTMLElement, key: string | null): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>(restorableRow)).find(row => row.dataset.listRow === key);
}

function positionOf(root: HTMLElement, target?: Element | null): Position {
  const scroll = scroller(root);
  const edge = scroll === document.scrollingElement ? 0 : scroll.getBoundingClientRect().top;
  const focused = document.activeElement;
  const origin = target && root.contains(target) ? target : focused && root.contains(focused) ? focused : null;
  const row = origin?.closest<HTMLElement>(restorableRow) ?? Array.from(root.querySelectorAll<HTMLElement>(restorableRow)).find(row => row.getBoundingClientRect().bottom > edge);
  return { top: scroll.scrollTop, left: scroll.scrollLeft, row: row?.dataset.listRow ?? null, offset: (row?.getBoundingClientRect().top ?? edge) - edge,
    focus: target?.closest("a[href]")?.getAttribute("href") ?? (focused?.matches("a[href]") && root.contains(focused) ? focused.getAttribute("href") : null) };
}

/** Update a list entry that already has a detail page in its forward history. */
export function updateSavedList<T>(identity: string, value: T, root: HTMLElement | null): void {
  const state = window.history.state;
  const previous = state?.[STATE_KEY]?.[identity];
  if (!previous || !root) return;
  window.history.replaceState({
    ...state,
    [STATE_KEY]: { ...state[STATE_KEY], [identity]: { value, position: positionOf(root) } },
  }, "");
}

function restorePosition(root: HTMLElement, position: Position): void {
  const scroll = scroller(root);
  const row = rowAt(root, position.row);
  const edge = scroll === document.scrollingElement ? 0 : scroll.getBoundingClientRect().top;
  scroll.scrollTop = row ? scroll.scrollTop + row.getBoundingClientRect().top - edge - position.offset : position.top;
  scroll.scrollLeft = position.left;
  const focus = row && [row, ...row.querySelectorAll<HTMLElement>("a[href]")].find(link => link.matches("a[href]") && link.getAttribute("href") === position.focus);
  focus?.focus({ preventScroll: true });
}

/** Restore content first, then anchor once its local loading has settled. No timed scroll retries. */
export function useListRestoration<T>(
  identity: string,
  value: T | (() => T),
  restore: (value: T) => void,
  { restoreOnMount = "always" }: Readonly<{ restoreOnMount?: "always" | "history-traversal" }> = {},
) {
  const root = useRef<HTMLDivElement>(null);
  const current = useRef({ value, restore });
  const saveChanges = useRef<(() => void) | undefined>(undefined);
  useLayoutEffect(() => { current.current = { value, restore }; });
  useLayoutEffect(() => { saveChanges.current?.(); }, [value]);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const historyOnly = restoreOnMount === "history-traversal";
    let observer: MutationObserver | undefined;
    let frame = 0;
    let scrollTimer = 0;
    let keepEntryCurrent = false;
    let waitingForPosition = false;
    const writeEntry = (target?: Element | null, retainPosition = false) => {
      const state = window.history.state ?? {};
      const previous = savedList<T>(identity);
      const positionKey = historyOnly ? previous?.positionKey ?? window.crypto.randomUUID() : undefined;
      if (positionKey && !retainPosition) pendingScrollPositions.delete(positionKey);
      const position = retainPosition && previous ? previous.position : positionOf(element, target);
      // A snapshot reader can include committed child state at the moment history is written.
      const { value } = current.current;
      const snapshot = typeof value === "function" ? (value as () => T)() : value;
      const saved = { value: snapshot, position, ...(positionKey ? { positionKey } : {}) };
      window.history.replaceState({ ...state, [STATE_KEY]: { ...state[STATE_KEY], [identity]: saved } }, "");
    };
    const saveCurrent = () => {
      // A visible preview can change while its content still delays the scroll anchor.
      if (keepEntryCurrent || waitingForPosition) writeEntry(undefined, waitingForPosition);
    };
    const saveScroll = (event: Event) => {
      if (!keepEntryCurrent) return;
      const scroll = scroller(element);
      if (event.target !== scroll && event.target !== document) return;
      const entry = savedList<T>(identity);
      if (!entry?.positionKey) return;
      const top = scroll.scrollTop;
      // Keep scroll in memory until it settles so immediate history traversal
      // sees the latest offset without rewriting history on every scroll event.
      pendingScrollPositions.set(entry.positionKey, {
        ...entry.position, top, left: scroll.scrollLeft, offset: entry.position.offset + entry.position.top - top,
      });
      window.clearTimeout(scrollTimer);
      if (event.type === "scrollend") {
        saveCurrent();
      } else if (!("onscrollend" in document)) {
        scrollTimer = window.setTimeout(() => {
          if (entry === savedList<T>(identity)) saveCurrent();
        }, 150);
      }
    };
    const startSaving = () => {
      if (!historyOnly) return;
      waitingForPosition = false;
      keepEntryCurrent = true;
      writeEntry();
    };
    const initializeEntry = () => {
      if (!historyOnly) return;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(startSaving);
    };
    const capture = (target?: Element | null) => {
      observer?.disconnect();
      window.cancelAnimationFrame(frame);
      window.dispatchEvent(new window.Event("blast:capture-content"));
      writeEntry(target);
    };
    const restoreEntry = () => {
      keepEntryCurrent = false;
      waitingForPosition = false;
      window.clearTimeout(scrollTimer);
      restoreTraversedLists();
      const saved = savedList<T>(identity);
      if (!saved) {
        initializeEntry();
        return;
      }
      const position = (saved.positionKey && pendingScrollPositions.get(saved.positionKey)) || saved.position;
      waitingForPosition = historyOnly;
      current.current.restore(saved.value);
      observer?.disconnect();
      window.cancelAnimationFrame(frame);
      const finish = () => {
        if (element.querySelector('[aria-busy="true"], [data-restoration-pending="true"]')) return;
        observer?.disconnect();
        window.cancelAnimationFrame(frame);
        // Let React commit restored controls/expanded content and Next finish its own scroll pass.
        frame = window.requestAnimationFrame(() => {
          restorePosition(element, position);
          startSaving();
        });
      };
      observer = new MutationObserver(finish);
      observer.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-busy", "data-restoration-pending"] });
      frame = window.requestAnimationFrame(finish);
    };
    const leaving = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      const link = target?.closest<HTMLAnchorElement>("a[href]");
      if (link && link.origin === window.location.origin && link.target !== "_blank") {
        capture(target);
        stageListOrigin(link.href);
      }
    };
    const pagehide = () => capture();
    const traversalEvent = historyOnly ? LIST_TRAVERSAL_EVENT : "popstate";
    if (historyOnly) {
      recordDocumentTraversal();
      // Browser Forward may leave Home without a link click or pagehide.
      saveChanges.current = saveCurrent;
      document.addEventListener("scrollend", saveScroll, true);
      document.addEventListener("scroll", saveScroll, true);
    }
    if (!historyOnly || currentTraversal()) restoreEntry();
    else initializeEntry();
    document.addEventListener("click", leaving, true);
    window.addEventListener("pagehide", pagehide);
    window.addEventListener("blast:capture-lists", pagehide);
    window.addEventListener(traversalEvent, restoreEntry);
    return () => {
      if (historyOnly) {
        currentTraversal();
        saveChanges.current = undefined;
        document.removeEventListener("scrollend", saveScroll, true);
        document.removeEventListener("scroll", saveScroll, true);
        window.clearTimeout(scrollTimer);
      }
      observer?.disconnect();
      window.cancelAnimationFrame(frame);
      document.removeEventListener("click", leaving, true);
      window.removeEventListener("pagehide", pagehide);
      window.removeEventListener("blast:capture-lists", pagehide);
      window.removeEventListener(traversalEvent, restoreEntry);
    };
  }, [identity, restoreOnMount]);
  return root;
}

/** Ordered items belong to the same history entry as its controls and scroll anchor. */
export function savedListContent<T>(identity: string): T | undefined {
  return typeof window === "undefined" ? undefined : window.history.state?.blastListContent?.[identity];
}

/** Record control choices at interaction time; pagehide can run after a reload has saved its entry. */
export function saveListContent<T>(identity: string, value: T): void {
  const state = window.history.state ?? {};
  window.history.replaceState({ ...state, blastListContent: { ...state.blastListContent, [identity]: value } }, "");
}

export function useListContent<T>(
  identity: string,
  value: T,
  restore: (value: T) => void,
  { restoreOnMount = false } = {},
): void {
  const current = useRef({ value, restore });
  useLayoutEffect(() => { current.current = { value, restore }; });
  useLayoutEffect(() => {
    const capture = () => {
      saveListContent(identity, current.current.value);
    };
    const back = () => {
      restoreTraversedLists();
      const saved = savedListContent<T>(identity);
      if (saved !== undefined) current.current.restore(saved);
    };
    if (restoreTraversedLists() || restoreOnMount) back();
    window.addEventListener("blast:capture-content", capture);
    window.addEventListener(LIST_TRAVERSAL_EVENT, back);
    window.addEventListener("popstate", back);
    return () => {
      window.removeEventListener("blast:capture-content", capture);
      window.removeEventListener(LIST_TRAVERSAL_EVENT, back);
      window.removeEventListener("popstate", back);
    };
  }, [identity, restoreOnMount]);
}

/** The destination entry keeps its own contextual Back link, including browsers without Navigation API. */
const originSnapshot = (): string | null => {
  const origin = window.history.state?.blastOrigin;
  return typeof origin === "string" ? origin : null;
};
const serverOrigin = () => null;
export function listOriginHistoryState(): Readonly<{ blastOrigin: string | null; blastOriginEntry?: string }> {
  const entry = window.history.state?.blastOriginEntry;
  return { blastOrigin: originSnapshot(), blastOriginEntry: typeof entry === "string" ? entry : undefined };
}

function writeListOrigin(state: ReturnType<typeof listOriginHistoryState>): void {
  window.history.replaceState({ ...window.history.state, ...state }, "");
  window.dispatchEvent(new window.Event("blast:list-origin"));
}

function subscribeOrigin(change: () => void) {
  window.addEventListener("blast:list-origin", change);
  window.addEventListener("popstate", change);
  return () => { window.removeEventListener("blast:list-origin", change); window.removeEventListener("popstate", change); };
}
export function useListOrigin(route: string): string | null {
  const origin = useSyncExternalStore(subscribeOrigin, originSnapshot, serverOrigin);
  const remembered = useRef<{
    entry: string | undefined;
    pathname: string;
    route: string;
    origin: ReturnType<typeof listOriginHistoryState>;
  } | null>(null);
  useLayoutEffect(() => {
    // Even two entries for the same URL can have different origins.
    const traversed = (event: PopStateEvent) => {
      remembered.current = null;
      recordTraversal(event.state);
    };
    window.addEventListener("popstate", traversed);
    return () => window.removeEventListener("popstate", traversed);
  }, []);

  useLayoutEffect(() => {
    const entry = window.navigation?.currentEntry?.key;
    const pathname = window.location.pathname;
    const current = listOriginHistoryState();
    const previous = remembered.current;
    if (current.blastOrigin) {
      remembered.current = { entry, pathname, route, origin: current };
    } else if (previous?.route === route && previous.pathname === pathname && previous.entry === entry) {
      // Next's router refresh can replace the current history state before layout effects run.
      writeListOrigin(previous.origin);
    } else {
      remembered.current = null;
    }
  });

  useLayoutEffect(() => {
    if (originSnapshot()) return;
    try {
      const raw = window.sessionStorage.getItem("blast:list-origin");
      if (!raw) return;
      const pending = JSON.parse(raw);
      if (pending.to !== window.location.href || Date.now() - pending.at > 30_000) return;
      window.sessionStorage.removeItem("blast:list-origin");
      const from = new URL(pending.from);
      if (from.origin !== window.location.origin) return;
      writeListOrigin({ blastOrigin: from.href, blastOriginEntry: typeof pending.fromEntry === "string" ? pending.fromEntry : undefined });
    } catch { /* A direct visit or unavailable storage uses the default Back link. */ }
  }, [route]);
  return origin;
}
