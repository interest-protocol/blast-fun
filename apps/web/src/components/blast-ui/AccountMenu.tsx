"use client";

import clsx from "clsx";

import styles from "./AppShell.module.css";
import { BlastMenu, BlastMenuItem, type MenuHandle } from "./BlastMenu";
import { Button } from "./Button";
import { ChevronIcon, VerifiedBadge } from "./Icons";
import { accountMenuPlacement } from "./menu-placement.ts";
import { themeLabel, type ThemeSetting } from "./prefs";
import type { ShellViewer } from "./shell-viewer";
import { ShellAvatar } from "./ShellAvatar";

export const ACCOUNT_MENU_ID = "blast-account-menu";

/**
 * The account menu (FEATURE-MAP §1.4; OA-41's `accountMenuHTML`, oa41
 * 8831–8839) on base-ui's `Menu` (`BlastMenu`): the viewer's row (`@handle ·
 * View profile` and a chevron, to their profile), Invites, Settings
 * ("Notifications, privacy, wallets"; it left the rail and the tab bar),
 * Appearance (cycles System → Light → Dark and stays open, as the gate's
 * does), and Log out. Words only: no dividers or item icons (2026-11-14
 * design pass), and Log out does not repeat the handle the first row shows.
 * Its trigger is the top bar's avatar (`AppShell`), detached through `handle`.
 */
export function AccountMenu({
  handle,
  viewer,
  theme,
  onProfile,
  onPortfolio,
  onSettings,
  onInvites,
  onCycleTheme,
  onLogOut,
}: Readonly<{
  handle: MenuHandle<undefined>;
  viewer: ShellViewer | null;
  theme: ThemeSetting;
  onProfile: () => void;
  onPortfolio: () => void;
  onSettings: () => void;
  onInvites: () => void;
  onCycleTheme: (origin: HTMLElement) => void;
  onLogOut: () => void;
}>) {
  if (viewer === null) return null;
  const handleText = viewer.callsign ? `@${viewer.callsign}` : null;
  return (
    <BlastMenu
      className={styles.menu}
      handle={handle}
      id={ACCOUNT_MENU_ID}
      label="Account"
      placement={accountMenuPlacement}
      // Keyboard closes return to the avatar; pointer closes keep the clicked target's focus.
      finalFocus={(closeType) => closeType === "keyboard"}
    >
      <BlastMenuItem nativeButton aria-label={`View ${handleText ?? "your"} profile`} className={clsx(styles.mitem, styles.acctMe)} onClick={onProfile} render={<button type="button" />}>
        <ShellAvatar size={40} viewer={viewer} />
        <span className={styles.mtext}>
          <b>
            <span className="nm">{viewer.displayName ?? viewer.callsign ?? "Your account"}</span>
            {viewer.verified ? <VerifiedBadge className="verified" /> : null}
          </b>
          <span>{handleText ?? "View profile"}</span>
        </span>
        <ChevronIcon />
      </BlastMenuItem>
      <BlastMenuItem nativeButton className={styles.mitem} onClick={onPortfolio} render={<Button variant="ghost" />}>
        <span className={styles.mtext}><b>Portfolio</b></span>
      </BlastMenuItem>
      <BlastMenuItem nativeButton className={styles.mitem} onClick={onInvites} render={<button type="button" />}>
        <span className={styles.mtext}><b>Invites</b></span>
      </BlastMenuItem>
      <BlastMenuItem nativeButton className={styles.mitem} onClick={onSettings} render={<button type="button" />}>
        <span className={styles.mtext}>
          <b>Settings</b>
        </span>
      </BlastMenuItem>
      <BlastMenuItem
        nativeButton
        className={styles.mitem}
        closeOnClick={false}
        onClick={(event) => onCycleTheme(event.currentTarget)}
        render={<button type="button" />}
      >
        <span className={styles.mtext}>
          <b>Appearance</b>
          <span>{themeLabel(theme)}</span>
        </span>
      </BlastMenuItem>
      <BlastMenuItem nativeButton className={clsx(styles.mitem, styles.danger)} onClick={onLogOut} render={<button type="button" />}>
        Log out
      </BlastMenuItem>
    </BlastMenu>
  );
}
