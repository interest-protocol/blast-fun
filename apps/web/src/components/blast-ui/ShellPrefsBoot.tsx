"use client";

import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";

import {
  RAIL_MINI_BELOW_PX,
  readShellPrefs,
  restoreThemeColor,
  SHELL_PREFS_BOOT_SCRIPT,
  shellPrefAttributes,
  shellPrefsFromAttributes,
  syncThemeColor,
} from "./prefs";
import { notifyShellPrefs } from "./use-shell-prefs";

const noSubscription = () => () => undefined;

/**
 * Puts the device's preferences on the page root before it paints. In the
 * server's HTML that is an inline script (with the CSP nonce) that runs as
 * the parser reaches it. A root mounted by a client-side navigation (from a
 * social page to Settings, say) gets no script, which React would not run
 * anyway; a layout effect applies the same preferences before that paint.
 */
export function ShellPrefsBoot({ nonce }: Readonly<{ nonce: string | null }>) {
  // True on the server and while hydrating its HTML; false for a root mounted on the client.
  const fromServer = useSyncExternalStore(noSubscription, () => false, () => true);
  useLayoutEffect(() => {
    let changed = false;
    const roots = document.querySelectorAll<HTMLElement>("[data-blast-ui]");
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      // Private browsing keeps the current page's choice in memory.
    }
    for (const root of roots) {
      if (root.hasAttribute("data-theme-setting")) continue;
      for (const [name, value] of Object.entries(shellPrefAttributes(readShellPrefs(storage, window.innerWidth)))) {
        if (value === null) root.removeAttribute(name);
        else root.setAttribute(name, value);
      }
      changed = true;
    }
    if (changed) notifyShellPrefs();

    const width = window.matchMedia(`(min-width: ${RAIL_MINI_BELOW_PX}px)`);
    const updateRail = () => {
      const rail = readShellPrefs(storage, window.innerWidth).railMini ? "mini" : "full";
      for (const root of roots) {
        if (!root.hasAttribute("data-rail-selected")) root.setAttribute("data-rail", rail);
      }
      notifyShellPrefs();
    };
    width.addEventListener("change", updateRail);
    return () => width.removeEventListener("change", updateRail);
  }, []);
  /*
   * The phone's status bar follows the theme (`FEATURE-MAP-R3.md` §1): the
   * inline script already set it for the first paint, and this keeps it in
   * step with the system scheme while the choice is `system` — and gives the
   * document's own colour back when no Blast UI page is on screen.
   */
  useEffect(() => {
    const root = document.querySelector<HTMLElement>("[data-blast-ui]");
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const theme = shellPrefsFromAttributes((name) => root?.getAttribute(name) ?? null).theme;
      syncThemeColor(document, theme, scheme.matches);
    };
    apply();
    scheme.addEventListener("change", apply);
    return () => {
      scheme.removeEventListener("change", apply);
      restoreThemeColor(document);
    };
  }, []);
  useEffect(() => {
    const keyboard = () => { document.documentElement.dataset.blastInput = "keyboard"; };
    const pointer = () => { document.documentElement.dataset.blastInput = "pointer"; };
    document.addEventListener("keydown", keyboard, true);
    document.addEventListener("pointerdown", pointer, true);
    return () => {
      document.removeEventListener("keydown", keyboard, true);
      document.removeEventListener("pointerdown", pointer, true);
      delete document.documentElement.dataset.blastInput;
    };
  }, []);
  if (!fromServer) return null;
  return <script dangerouslySetInnerHTML={{ __html: SHELL_PREFS_BOOT_SCRIPT }} nonce={nonce ?? undefined} suppressHydrationWarning />;
}
