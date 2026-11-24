import { SOCIAL_PAGE_PATHS } from "@blast/core/lib/social-page-routes.ts";
import { SOCIAL_CALLSIGN_PATTERN } from "@blast/core/modules/social/contracts/accounts.ts";

/**
 * The shell's navigation (FEATURE-MAP §0.1, §1.2, §1.5): which item a path
 * belongs to and where each item goes. Paths arrive as the browser shows
 * them (`/`, `/@kai`) or as the server renders them after the proxy's
 * rewrites (`/feed`, `/crew/kai`); both map to the same item, so the server's
 * HTML and the browser's render agree.
 */

export type ShellNavKey = "home" | "presales" | "bonding" | "portfolio" | "alerts" | "profile";

export const SHELL_PHONE_QUERY = "(max-width: 760px)";

/** `/@<callsign>`: the canonical profile URL (OA-4). */
export function profilePath(callsign: string): string {
  return `/@${callsign}`;
}

/** The callsign a profile path names (`/@kai`, or `/crew/kai` as the server sees it), or null. */
export function profileCallsignOf(pathname: string): string | null {
  const match = /^\/(?:@|crew\/)([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  let callsign: string;
  try {
    callsign = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  return SOCIAL_CALLSIGN_PATTERN.test(callsign) ? callsign : null;
}

/**
 * The rail or tab item that is the current page for `pathname`, or null.
 * Only the viewer's own profile is "Profile"; someone else's belongs to Home,
 * as the design's `navKey` places it. Invites and Settings belong to Profile (OA-41's
 * `curKey`: `route === 'settings' ? 'profile' : navKey()`).
 */
export function shellNavKeyFor(pathname: string | null, ownCallsign: string | null): ShellNavKey | null {
  if (!pathname) return null;
  if (isHomePath(pathname)) return "home";
  if (pathname === PRESALES_PATH || pathname.startsWith(`${PRESALES_PATH}/`)) return "presales";
  if (pathname === BONDING_PATH || pathname === LAUNCH_PATH || pathname.startsWith(`${SOCIAL_PAGE_PATHS.coin}/`)) return "bonding";
  if (pathname === NOTIFICATIONS_PATH || pathname.startsWith(`${NOTIFICATIONS_PATH}/`)) return "alerts";
  if (pathname === PORTFOLIO_PATH || pathname.startsWith(`${PORTFOLIO_PATH}/`)) return "portfolio";
  if (pathname === INVITES_PATH) return "profile";
  if (pathname === SETTINGS_PATH || pathname.startsWith(`${SETTINGS_PATH}/`)) return "profile";
  const callsign = profileCallsignOf(pathname);
  if (callsign !== null && ownCallsign !== null && callsign.toLowerCase() === ownCallsign.toLowerCase()) return "profile";
  if (callsign !== null) return "home";
  return null;
}

/** Whether `pathname` is Home, whose right column is "What's happening" and can collapse. */
export function isHomePath(pathname: string | null): boolean {
  return pathname !== null && canonicalHomePath(pathname) === HOME_PATH;
}

export const {
  home: HOME_PATH,
  feed: FEED_PATH,
  presales: PRESALES_PATH,
  notifications: NOTIFICATIONS_PATH,
  portfolio: PORTFOLIO_PATH,
  portfolioClaims: CLAIMS_PATH,
  invites: INVITES_PATH,
  settings: SETTINGS_PATH,
  create: CREATE_PATH,
  launch: LAUNCH_PATH,
  bonding: BONDING_PATH,
} = SOCIAL_PAGE_PATHS;

const PAGE_LABELS: ReadonlyMap<string, string> = new Map([
  [HOME_PATH, "Home"],
  [PRESALES_PATH, "Presales"],
  [BONDING_PATH, "Bonding"],
  [NOTIFICATIONS_PATH, "Notifications"],
  [PORTFOLIO_PATH, "Portfolio"],
  [SETTINGS_PATH, "Settings"],
]);

export function pageLabel(pathname: string): string | null {
  return PAGE_LABELS.get(canonicalHomePath(pathname)) ?? null;
}

export function canonicalHomePath(pathname: string): string {
  return pathname === FEED_PATH ? HOME_PATH : pathname;
}

export type ShellActionName =
  | "openSignIn"
  | "openSearch"
  | "openNotifications"
  | "openFund"
  | "openDeposit"
  | "toggleBlastMode"
  // Settings (UI-07): the right column's Withdraw (§14.2).
  | "openWithdraw"
  // Coins (UI-14): one coin's sheet, by its key (`usdc`, `sui` or a presale id).
  | "openCoin"
  // Coins (UI-14 §14.2): the whole list, which is a screen and not a coin.
  | "openAllCoins"
  // Coins (R3-33/R3-34): the trade screen for a sale's coin, Buy or Sell (a sale page's phone bar); with no argument the plain swap.
  | "openTrade";

type SearchKey = Readonly<{
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
}>;

export function isSearchShortcut(event: SearchKey): boolean {
  // On some layouts Shift is needed to type the slash.
  return event.key === "/" && !(event.metaKey || event.ctrlKey || event.altKey || event.isComposing || event.repeat || event.defaultPrevented);
}

/**
 * `/` opens Search when focus is outside an editable field and no dialog is open.
 */
export function shortcutFor(
  event: SearchKey,
  target: Readonly<{ tagName: string; isContentEditable?: boolean }> | null,
  dialogOpen: boolean,
): ShellActionName | null {
  if (dialogOpen || !isSearchShortcut(event)) return null;
  if (target && (/^(input|textarea|select)$/i.test(target.tagName) || target.isContentEditable)) return null;
  return "openSearch";
}
