import type { SocialAccountWallet, SocialWalletKind } from "@blast/core/web/contracts/me.ts";
import {
  NOTIFICATION_PREFERENCE_KEYS,
  type NotificationPreferenceKey,
  type SocialSettingsResponse,
} from "@blast/core/web/contracts/settings.ts";

import { SETTINGS_PATH, pageLabel, profileCallsignOf } from "#web/components/blast-ui/nav.ts";

/**
 * The settings page's copy and formats (FEATURE-MAP §7, verbatim from the
 * canonical UI) and the pure rules behind its controls.
 */

/** The notification switches, in the design's order, with their title and line. */
export const NOTIFICATION_ROWS: readonly Readonly<{ key: NotificationPreferenceKey; title: string }>[] = [
  { key: "opens_soon", title: "Opens soon" },
  { key: "almost_full", title: "80% filled" },
  { key: "last_hour", title: "Last hour" },
  { key: "funded", title: "Funded" },
  { key: "claims_open", title: "Claims open" },
  { key: "unlocks", title: "Unlocks" },
  // `FEATURE-MAP-R3.md` §7 (R3-05): "When someone you follow commits" became this.
  { key: "people_you_follow", title: "People you follow" },
  // A coin you called rising past +50%, +100%, +200%, +500% or +1,000% ("WAL is up 100% since your call").
  { key: "call_moves", title: "Up since your call" },
];
// Every stored switch has a row, and only those.
if (NOTIFICATION_ROWS.map((row) => row.key).join() !== NOTIFICATION_PREFERENCE_KEYS.join()) {
  throw new Error("NOTIFICATION_ROWS must list every notification preference in order.");
}

export const COPY = {
  celebrations: { title: "Celebrations" },
  buyAlerts: { title: "Buy alerts from people you follow" },
  // The Settings board's lines: sentence fragments, no closing period.
  private: {
    title: "Private account",
    off: "Your blasts and claims appear to followers",
    on: "Blast never shows your name on your actions",
  },
  publicPortfolio: {
    title: "Public portfolio",
    off: "Only you can see it",
    on: "Anyone can see your balances and holdings",
  },
  privacyNote: "Onchain data is public. A private account can still appear by wallet address in big-move posts, without your name.",
  holdCoin: { title: "Hold-to-commit coin", label: "Hold-to-commit coin", sale: "Each sale’s coin" },
  explorer: { title: "Explorer" },
  confirmTrades: { title: "Confirm Blast mode trades", sub: "Review before every buy and sell" },
  theme: { title: "Theme" },
  link: { title: "Link a Sui wallet" },
  signIn: { title: "Sign in" },
  logOut: { title: "Log out" },
} as const;

export const TOASTS = {
  copied: "Address copied",
  linked: (wallet: string) => `${wallet} wallet linked`,
  logOutFailed: "Sign-out did not finish. You are still signed in. Try again.",
} as const;

export const LINK_WALLET_BUTTON_ID = "settings-link-wallet";
export const UNLINK_FAILED = "Couldn’t finish unlinking Slush. Check your wallets and try again.";

/** What a wallet is called in the list: "Blast wallet", "Slush", or an external wallet. */
export function walletName(kind: SocialWalletKind): string {
  if (kind === "embedded") return "Blast wallet";
  if (kind === "slush") return "Slush";
  return "External wallet";
}

/**
 * `0x3f9a8c21…e7b1c21d`: the reference's `addrShort`, now the one rule for a
 * wallet address of your own wherever it is shown — the settings rows, the
 * wallet card, the deposit screen (`FEATURE-MAP-R3.md` §1, §7). The old build
 * hard-coded truncated literals and so showed the settings rows one digit
 * shorter than the card; both now read the same real address.
 */
export function shortWallet(address: string): string {
  if (address.length <= 19) return address;
  return `${address.slice(0, 10)}…${address.slice(-8)}`;
}

/** "Created Oct 1" for the Blast wallet, "Linked Oct 2" for any other, in the viewer's time zone. */
export function walletSince(wallet: Pick<SocialAccountWallet, "kind" | "linked_at_ms">, timeZone?: string): string {
  const day = new Date(wallet.linked_at_ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
  return `${wallet.kind === "embedded" ? "Created" : "Linked"} ${day}`;
}

/** The wallets in the list's order: the Blast wallet first, then the others as they were linked. */
export function walletRows(wallets: readonly SocialAccountWallet[]): SocialAccountWallet[] {
  return [...wallets].sort((a, b) => {
    const embedded = Number(b.kind === "embedded") - Number(a.kind === "embedded");
    return embedded || a.linked_at_ms - b.linked_at_ms || a.address.localeCompare(b.address);
  });
}

/** A change the page sends: any subset of the settings `PUT` accepts. */
export type SettingsPatch = Readonly<{
  private?: boolean;
  public_portfolio?: boolean;
  commit_too_coin_type?: string | null;
  explorer?: SocialSettingsResponse["explorer"];
  sound?: boolean;
  blast_mode_confirm_actions?: boolean;
  notifications?: Partial<Record<NotificationPreferenceKey, boolean>>;
}>;

/** Two patches as one: later values win, notification switches merge. */
export function mergePatches(first: SettingsPatch, second: SettingsPatch): SettingsPatch {
  const notifications = first.notifications || second.notifications ? { ...first.notifications, ...second.notifications } : undefined;
  return { ...first, ...second, ...(notifications ? { notifications } : {}) };
}

/** `settings` with `patch` applied, as the page shows it before the server answers. */
export function applyPatch(settings: SocialSettingsResponse, patch: SettingsPatch): SocialSettingsResponse {
  return {
    ...settings,
    ...(patch.private === undefined ? {} : { privacy: patch.private ? ("private" as const) : ("public" as const) }),
    ...(patch.public_portfolio === undefined ? {} : { public_portfolio: patch.public_portfolio }),
    ...(patch.commit_too_coin_type === undefined ? {} : { commit_too_coin_type: patch.commit_too_coin_type }),
    ...(patch.explorer === undefined ? {} : { explorer: patch.explorer }),
    ...(patch.sound === undefined ? {} : { sound: patch.sound }),
    ...(patch.blast_mode_confirm_actions === undefined ? {} : { blast_mode_confirm_actions: patch.blast_mode_confirm_actions }),
    notifications: { ...settings.notifications, ...patch.notifications },
  };
}

/** Whether a patch changes nothing. */
export function isEmptyPatch(patch: SettingsPatch): boolean {
  return Object.entries(patch).every(([key, value]) =>
    value === undefined || (key === "notifications" && Object.keys(value as object).length === 0));
}


/**
 * The back bar over Settings (oa41 `backbar`, R3-76) names the page a path is
 * — the gate's `routeTitle`, with Portfolio — or null for a page the path
 * alone cannot name (a sale, someone else's profile: their names are not in
 * the path), which leaves the bar at its default, "‹ Profile".
 */
export function backLabelOf(pathname: string, ownCallsign: string | null): string | null {
  const label = pathname === SETTINGS_PATH ? null : pageLabel(pathname);
  if (label !== null) return label;
  const callsign = profileCallsignOf(pathname);
  return callsign !== null && ownCallsign !== null && callsign.toLowerCase() === ownCallsign.toLowerCase() ? "Profile" : null;
}
