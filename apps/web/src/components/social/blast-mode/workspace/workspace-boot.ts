import { SHELL_PHONE_QUERY } from "#web/components/blast-ui/nav.ts";
import { DISCOVER_CHOSEN_KEY, DISCOVER_DEFAULT_OPEN_WIDTH, DISCOVER_SHEET_WIDTH } from "./discover-default";
import { workspaceSessionCodec } from "./session";
import { boardBands, clampLength, narrowWorkspaceBoard } from "./workspace-board";
import { WORKSPACE_PREVIEW_KEY, parseWorkspacePreview } from "./workspace-preview";

const bootSettings = {
  phoneQuery: SHELL_PHONE_QUERY,
  previewKey: WORKSPACE_PREVIEW_KEY,
  discoverChosenKey: DISCOVER_CHOSEN_KEY,
  discoverSheetWidth: DISCOVER_SHEET_WIDTH,
  discoverDefaultOpenWidth: DISCOVER_DEFAULT_OPEN_WIDTH,
};

const bootFunctions = { workspaceSessionCodec, parseWorkspacePreview, boardBands, clampLength, narrowWorkspaceBoard };

/** Runs as the parser reaches the root, before the underlying route can paint. No account reads. */
function bootWorkspaceCover(source: HTMLElement, settings: typeof bootSettings, functions: typeof bootFunctions): void {
  let cover: HTMLElement | undefined;
  try {
    const phone = window.matchMedia?.(settings.phoneQuery);
    if (phone?.matches) return;
    const session = functions.workspaceSessionCodec();
    const origin = session.readOpenOrigin(window.sessionStorage.getItem(session.key), window.location.origin);
    if (!origin || origin.path !== window.location.pathname + window.location.search + window.location.hash) return;
    const root = source.closest("[data-blast-ui]");
    if (!root || root.querySelector("[data-workspace-boot], [data-workspace-host]")) return;
    const mount = root.querySelector("[data-workspace-cover-mount]");
    if (!mount) return;
    cover = source.firstElementChild!.cloneNode(true) as HTMLElement;
    cover.setAttribute("data-workspace-boot", "");
    cover.setAttribute("role", "dialog");
    cover.setAttribute("aria-modal", "true");
    cover.setAttribute("aria-label", "Restoring Blast workspace");
    const readPreview = () => {
      try { return functions.parseWorkspacePreview(JSON.parse(window.sessionStorage.getItem(settings.previewKey) ?? "null")); }
      catch { return undefined; }
    };
    const preview = readPreview();
    const focus = preview?.presentation !== "compare";
    const discoverIsSheet = window.innerWidth < settings.discoverSheetWidth;
    const discoverOnScreen = () => {
      if (discoverIsSheet) return false;
      if (window.innerWidth >= settings.discoverDefaultOpenWidth) return true;
      try { return window.localStorage.getItem(settings.discoverChosenKey) === "1"; } catch { return false; }
    };
    const discover = preview?.discover === true && (!focus || discoverOnScreen());
    const layout = cover.querySelector<HTMLElement>("[data-pending-layout]")!;
    const panels = cover.querySelector<HTMLElement>("[data-pending-panels]")!;
    layout.dataset.presentation = panels.dataset.presentation = focus ? "focus" : "compare";
    layout.dataset.dataOpen = String(discover);
    cover.querySelector<HTMLElement>("[data-pending-discover]")!.hidden = !discover;
    cover.querySelector<HTMLElement>("[data-pending-edge]")!.hidden = focus ? discover : true;
    if (preview?.saved === false) cover.querySelector("[data-pending-saved]")?.remove();
    const compare = cover.querySelector<HTMLElement>("[data-compare-placeholder]")!;
    const prepareFocus = (cover: HTMLElement) => {
      compare.remove();
      const board = cover.querySelector<HTMLElement>("[data-board] > div")!;
      const font = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const height = window.innerHeight / (font / 16);
      const bands = functions.boardBands(height);
      board.style.setProperty("--board-ticket", `${functions.clampLength(bands.ticket, preview?.ticket ?? undefined) / 16}rem`);
      board.style.setProperty("--board-holders", `${functions.clampLength(bands.holders, preview?.holders ?? undefined) / 16}rem`);
      if (preview?.activityHidden) board.setAttribute("data-activity-hidden", "true");
      const grid = cover.querySelector<HTMLElement>("[data-terminal-grid]")!;
      // Measure the board after insertion so it has a layout width.
      mount.append(cover);
      const narrow = functions.narrowWorkspaceBoard(grid.clientWidth / (font / 16), discoverIsSheet);
      grid.dataset.terminalGrid = narrow ? "stacked" : "desktop";
      if (narrow) grid.dataset.compactView = "chart";
    };
    if (focus) prepareFocus(cover);
    else {
      const row = compare.firstElementChild!;
      panels.replaceChildren(...Array.from({ length: preview?.panels ?? 1 }, () => row.cloneNode(true)));
      panels.dataset.count = String(preview?.panels ?? 1);
    }
    if (!cover.isConnected) mount.append(cover);
    const close = () => {
      try { window.sessionStorage.setItem(session.key, session.encode(false, origin)); } catch { /* Exit still works. */ }
      window.dispatchEvent(new Event(session.closeEvent));
      cover?.remove();
      document.removeEventListener("keydown", escape);
    };
    const exit = cover.querySelector("button");
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
      else if (event.key === "Tab") { event.preventDefault(); exit?.focus({ preventScroll: true }); }
    };
    exit?.addEventListener("click", close);
    exit?.focus({ preventScroll: true });
    document.addEventListener("keydown", escape);
    const onViewportChange = (event: MediaQueryListEvent) => {
      if (event.matches && cover?.isConnected) close();
    };
    phone?.addEventListener("change", onViewportChange);
    // Release the boot-only listeners when the cover closes or the live frame takes over.
    const observer = new MutationObserver(() => {
      if (cover?.isConnected) return;
      document.removeEventListener("keydown", escape);
      phone?.removeEventListener("change", onViewportChange);
      observer.disconnect();
    });
    observer.observe(mount, { childList: true });
  } catch { cover?.remove(); /* Denied/corrupt storage must never obscure an otherwise usable page. */ }
}

const serializedFunctions = Object.entries(bootFunctions)
  .map(([name, implementation]) => `${name}:(${implementation.toString()})`)
  .join(",");

export const WORKSPACE_BOOT_SCRIPT = `(${bootWorkspaceCover.toString()})(document.currentScript.previousElementSibling,${JSON.stringify(bootSettings)},{${serializedFunctions}});`;
