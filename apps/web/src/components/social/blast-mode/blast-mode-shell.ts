/** Home's own "Blast mode" button, where focus lands on leaving when the opener is gone. */
export const HOME_BLAST_BUTTON = '#view button[aria-keyshortcuts~="B"]';

/** What `coverShell` needs of the document; the tests pass a fake. */
export type ShellDocument = Readonly<{
  activeElement: Element | null;
  body: Element | null;
  getElementById(id: string): HTMLElement | null;
  querySelector(selector: string): Element | null;
  documentElement?: HTMLElement;
  defaultView?: Pick<Window, "scrollX" | "scrollY" | "scrollTo"> | null;
}>;

type Focusable = Readonly<{
  isConnected: boolean;
  focus(options?: FocusOptions): void;
}>;

function focusable(element: Element | null | undefined): Focusable | null {
  if (element === null || element === undefined) return null;
  const candidate = element as unknown as Partial<Focusable>;
  return typeof candidate.focus === "function"
    ? (element as unknown as Focusable)
    : null;
}

/** Announcers and toasts stay live while the mode covers the page: its own trades and saves report there. */
const STAYS_LIVE = '[aria-live], [role="status"], [role="alert"], [data-sonner-toaster], section[aria-label^="Notifications"], script, style, template';

/**
 * Everything beside `host` up to the body (Blast mode audit 29): the page's rail, top bar,
 * banners and stray portals. Returns what it made inert, to restore.
 */
function inertOthers(host: Element): readonly Element[] {
  const made: Element[] = [];
  for (let node: Element | null = host; node?.parentElement; node = node.parentElement) {
    for (const sibling of Array.from(node.parentElement.children)) {
      const element = sibling as Element & { inert?: boolean };
      if (sibling === node || element.inert || sibling.matches(STAYS_LIVE) || sibling.querySelector(STAYS_LIVE) && sibling.childElementCount === 1) continue;
      element.inert = true;
      made.push(sibling);
    }
    if (node.parentElement.tagName === "BODY") break;
  }
  return made;
}

/** Keep the originating shell inert and restore its focus and scroll on exit. */
export function coverShell(
  doc: ShellDocument,
  origin?: Readonly<{
    scroll_x: number;
    scroll_y: number;
    main_scroll_top: number;
  }> | null,
  host?: Element | null,
): () => void {
  const active = doc.activeElement;
  const opener =
    active !== null && active !== doc.body ? focusable(active) : null;
  const main = doc.getElementById("main");
  const mainScroll = origin?.main_scroll_top ?? main?.scrollTop ?? 0;
  const scrollX = origin?.scroll_x ?? doc.defaultView?.scrollX ?? 0;
  const scrollY = origin?.scroll_y ?? doc.defaultView?.scrollY ?? 0;
  const overflow = doc.documentElement?.style.overflow ?? "";
  if (doc.documentElement) doc.documentElement.style.overflow = "hidden";
  const shell = main?.parentElement ?? null;
  const wasInert = shell?.inert ?? false;
  if (shell !== null) shell.inert = true;
  const others = host ? inertOthers(host) : [];
  let covered = true;
  return () => {
    if (!covered) return;
    covered = false;
    for (const element of others) (element as Element & { inert?: boolean }).inert = false;
    if (shell !== null) shell.inert = wasInert;
    if (doc.documentElement) doc.documentElement.style.overflow = overflow;
    const fallback = doc.querySelector(HOME_BLAST_BUTTON) ?? main;
    if (fallback === main && main) main.setAttribute("tabindex", "-1");
    const target = opener?.isConnected === true ? opener : focusable(fallback);
    target?.focus({ preventScroll: true });
    if (main) main.scrollTop = mainScroll;
    doc.defaultView?.scrollTo(scrollX, scrollY);
  };
}
