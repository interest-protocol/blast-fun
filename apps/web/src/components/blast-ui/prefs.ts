import { SHELL_STATUS_DARK, SHELL_STATUS_LIGHT } from "../../lib/site-theme-colors.generated.ts";

/**
 * The shell's per-device preferences (canonical UI §1, tokens.md §1): the
 * theme, the collapsed rail, the collapsed right column, the hidden
 * amounts and the pinned recap. They live in `localStorage` under the prototype's keys, as JSON,
 * and never reach the server. The page root (`[data-blast-ui]`) carries them
 * as data attributes, which the CSS reads; `SHELL_PREFS_BOOT_SCRIPT` sets
 * those attributes before the first paint, so a stored dark theme or a
 * collapsed rail never flashes the default first.
 */

export type ThemeSetting = "system" | "light" | "dark";

export const THEME_SETTINGS: readonly ThemeSetting[] = ["system", "light", "dark"];

export type ShellPrefs = Readonly<{
  theme: ThemeSetting;
  /** The left rail at 80px (icons over short labels). */
  railMini: boolean;
  /** Home's right column folded to its 44px expand button. */
  asideCollapsed: boolean;
  /** The privacy eye: balances read `••••`. */
  amountsHidden: boolean;
  /** Omit holdings below one whole coin from lists, without changing totals. */
  hideSmallBalances: boolean;
  /** Home's "Today on Blast" pinned: it sticks to the top while the feed scrolls (FEATURE-MAP §16). */
  recapPinned: boolean;
}>;

export type ShellPrefName = keyof ShellPrefs;

/** Storage keys, as the prototype names them. */
export const SHELL_PREF_KEYS: Readonly<Record<ShellPrefName, string>> = {
  theme: "blast.theme",
  railMini: "blast.railMini",
  asideCollapsed: "blast.collapsed",
  amountsHidden: "blast.hideBal",
  hideSmallBalances: "blast.hideSmallBalances",
  recapPinned: "blast.recapPin",
};

/** Below this viewport width a first visit starts with the rail collapsed. */
export const RAIL_MINI_BELOW_PX = 1400;

/** What the server renders: nothing is known about the device yet. */
export const DEFAULT_SHELL_PREFS: ShellPrefs = Object.freeze({
  theme: "system",
  railMini: false,
  asideCollapsed: false,
  amountsHidden: false,
  hideSmallBalances: true,
  recapPinned: false,
});

export type PrefStorage = Pick<Storage, "getItem" | "setItem">;

function stored(storage: PrefStorage | null, key: string): unknown {
  try {
    const raw = storage?.getItem(key);
    return raw === null || raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isTheme(value: unknown): value is ThemeSetting {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * The device's preferences. Missing or unreadable values fall back to the
 * defaults; the rail's default is collapsed when `viewportWidth` is under
 * 1400 (a first visit), and the stored choice wins after that.
 */
export function readShellPrefs(storage: PrefStorage | null, viewportWidth: number): ShellPrefs {
  const theme = stored(storage, SHELL_PREF_KEYS.theme);
  const railMini = stored(storage, SHELL_PREF_KEYS.railMini);
  const asideCollapsed = stored(storage, SHELL_PREF_KEYS.asideCollapsed);
  const amountsHidden = stored(storage, SHELL_PREF_KEYS.amountsHidden);
  const recapPinned = stored(storage, SHELL_PREF_KEYS.recapPinned);
  return {
    theme: isTheme(theme) ? theme : "system",
    railMini: typeof railMini === "boolean" ? railMini : viewportWidth < RAIL_MINI_BELOW_PX,
    asideCollapsed: asideCollapsed === true,
    amountsHidden: amountsHidden === true,
    hideSmallBalances: stored(storage, SHELL_PREF_KEYS.hideSmallBalances) !== false,
    recapPinned: recapPinned === true,
  };
}

/** Remembers one preference on this device; storage that refuses keeps it for this page only. */
export function writeShellPref<K extends ShellPrefName>(storage: PrefStorage | null, name: K, value: ShellPrefs[K]): void {
  try {
    storage?.setItem(SHELL_PREF_KEYS[name], JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode, quota): the page keeps the value in memory.
  }
}

/**
 * The page root's attributes for `prefs`. `data-theme` is set only for an
 * explicit light or dark choice, so `system` follows `prefers-color-scheme`.
 */
export function shellPrefAttributes(prefs: ShellPrefs): Readonly<Record<string, string | null>> {
  return {
    "data-theme": prefs.theme === "system" ? null : prefs.theme,
    "data-theme-setting": prefs.theme,
    "data-rail": prefs.railMini ? "mini" : "full",
    "data-aside": prefs.asideCollapsed ? "collapsed" : "open",
    "data-amounts": prefs.amountsHidden ? "hidden" : "shown",
    "data-small-balances": prefs.hideSmallBalances ? "hidden" : "shown",
    "data-recap": prefs.recapPinned ? "pinned" : "free",
  };
}

/** Reads the preferences back from a root's attributes (the client's source of truth after boot). */
export function shellPrefsFromAttributes(read: (name: string) => string | null): ShellPrefs {
  const theme = read("data-theme-setting");
  return {
    theme: isTheme(theme) ? theme : "system",
    railMini: read("data-rail") === "mini",
    asideCollapsed: read("data-aside") === "collapsed",
    amountsHidden: read("data-amounts") === "hidden",
    hideSmallBalances: read("data-small-balances") !== "shown",
    recapPinned: read("data-recap") === "pinned",
  };
}

/** The status bar palette for pages inside the Blast shell. */
export const THEME_COLOR = Object.freeze({
  light: SHELL_STATUS_LIGHT,
  dark: SHELL_STATUS_DARK,
});

/**
 * Points every `theme-color` meta at the Blast UI's status bar colour: the
 * chosen theme's, or the system scheme's under `system`. The colour the
 * document arrived with (the launchpad's) is remembered on the tag, so
 * `restoreThemeColor` can give it back when no Blast UI page is on screen.
 */
export function syncThemeColor(doc: Document, theme: ThemeSetting, prefersDark: boolean): void {
  const dark = theme === "dark" || (theme === "system" && prefersDark);
  for (const meta of doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    if (meta.dataset.blastThemeColor === undefined) meta.dataset.blastThemeColor = meta.content;
    meta.content = dark ? THEME_COLOR.dark : THEME_COLOR.light;
  }
}

/** Gives back the colour the document had before a Blast UI page took it over. */
export function restoreThemeColor(doc: Document): void {
  for (const meta of doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const original = meta.dataset.blastThemeColor;
    if (original === undefined) continue;
    meta.content = original;
    delete meta.dataset.blastThemeColor;
  }
}

/** The account menu's Appearance item: System → Light → Dark → System. */
export function nextTheme(theme: ThemeSetting): ThemeSetting {
  return theme === "system" ? "light" : theme === "light" ? "dark" : "system";
}

/** "System", "Light" or "Dark". */
export function themeLabel(theme: ThemeSetting): string {
  return theme[0]!.toUpperCase() + theme.slice(1);
}

/**
 * Runs inline as the first child of the page root, before anything paints:
 * it copies the stored preferences onto the root. Self-contained on purpose
 * (it is serialised into the page); `prefs.test.ts` runs the serialised
 * script against `readShellPrefs` and `shellPrefAttributes`.
 */
function bootShellPrefs(
  root: HTMLElement,
  storage: PrefStorage | null,
  width: number,
  statusColors: Readonly<Record<"light" | "dark", string>>,
): void {
  const read = (key: string): unknown => {
    try {
      const raw = storage ? storage.getItem(key) : null;
      return raw === null ? undefined : JSON.parse(raw);
    } catch {
      return undefined;
    }
  };
  const theme = read("blast.theme");
  const setting = theme === "light" || theme === "dark" || theme === "system" ? theme : "system";
  const rail = read("blast.railMini");
  if (setting === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", setting);
  root.setAttribute("data-theme-setting", setting);
  const applyThemeColor = () => {
    // The status bar follows the theme from the first paint too (`syncThemeColor`).
    const scheme = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
    const dark = setting === "dark" || (setting === "system" && scheme?.matches === true);
    const metas = root.ownerDocument?.querySelectorAll?.('meta[name="theme-color"]') ?? [];
    for (const meta of Array.from(metas) as HTMLMetaElement[]) {
      if (meta.dataset.blastThemeColor === undefined) meta.dataset.blastThemeColor = meta.content;
      meta.content = dark ? statusColors.dark : statusColors.light;
    }
  };
  applyThemeColor();
  root.setAttribute("data-rail", (typeof rail === "boolean" ? rail : width < 1400) ? "mini" : "full");
  root.setAttribute("data-aside", read("blast.collapsed") === true ? "collapsed" : "open");
  root.setAttribute("data-amounts", read("blast.hideBal") === true ? "hidden" : "shown");
  root.setAttribute("data-small-balances", read("blast.hideSmallBalances") !== false ? "hidden" : "shown");
  root.setAttribute("data-recap", read("blast.recapPin") === true ? "pinned" : "free");
}

/** The inline boot script (needs the request's CSP nonce). */
export const SHELL_PREFS_BOOT_SCRIPT = `(${bootShellPrefs.toString()})(document.currentScript.parentElement,(function(){try{return window.localStorage}catch(e){return null}})(),window.innerWidth,${JSON.stringify(THEME_COLOR)});`;
