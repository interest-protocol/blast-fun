"use client";

import { readBrowserStorage, writeBrowserStorage } from "#web/lib/browser-storage.ts";
import { useEffect, useRef } from "react";

import { adoptAccountSound, soundChangeMark } from "#web/components/blast-feel/index.ts";
import { setDevicePref } from "#web/components/blast-ui/device-prefs.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { SocialSettingsResponse } from "@blast/core/web/contracts/settings.ts";

import { settingsQuery } from "../queries";
import type { TokenSource } from "#web/components/social/social-api.ts";
import { keepDeviceSound } from "./use-sound-switch";

const SYNCED_KEY = "blast.settingsSynced";
/**
 * Bumped when the sync starts doing something new (2: R3-12's sound; 3: an
 * account with no sound choice is handed this device's), so a tab already
 * synced reads once more.
 */
const SYNC_VERSION = "3";

function syncedAccount(): string | null {
  return readBrowserStorage("session", SYNCED_KEY);
}

function markSynced(accountId: string): void {
  writeBrowserStorage("session", SYNCED_KEY, `${accountId}:${SYNC_VERSION}`);
}

/**
 * Copies what a signed-in account keeps on the server onto this device, so
 * every page can act on it without a request:
 *
 *  - the **explorer** (Settings → Transactions), so transaction links follow
 *    the account;
 *  - the **sound** switch (Settings → Feel, R3-12), when the account has
 *    chosen: the Feel layer's live flag becomes that choice, unless the reader
 *    changed it on this device while the read was in flight (`soundMark`), in
 *    which case their newer choice stands. An account that has not chosen
 *    (`sound: null`) never turns sound on: the device keeps its own flag (off
 *    until the reader turns it on), and a choice the reader made here is
 *    handed to the account (`keepDeviceSound`) so it follows them.
 */
export function adoptAccountSettings(
  settings: Pick<SocialSettingsResponse, "explorer" | "sound">,
  soundMark: number,
  getAccessToken: TokenSource,
): void {
  setDevicePref("explorer", settings.explorer);
  const unsaved = adoptAccountSound(settings.sound, soundMark);
  if (unsaved !== null) void keepDeviceSound(getAccessToken, unsaved);
}

/**
 * One `GET /api/social/me/settings` per account per tab session, copied onto
 * the device (`adoptAccountSettings`); the settings page refreshes it on
 * every read. A visitor's choices stay on the device.
 */
export function useAccountSettingsSync(accountId: string | null, getAccessToken: TokenSource | undefined): void {
  const client = useAppQueryClient();
  const tokens = useRef(getAccessToken);
  useEffect(() => {
    tokens.current = getAccessToken;
  }, [getAccessToken]);
  useEffect(() => {
    const source = tokens.current;
    if (!accountId || !source || syncedAccount() === `${accountId}:${SYNC_VERSION}`) return;
    const controller = new AbortController();
    const mark = soundChangeMark();
    // The shared settings query (OA-38): on the settings page this is the page's own read.
    void client.fetchQuery(settingsQuery(source, accountId)).then(
      (settings) => {
        if (controller.signal.aborted) return;
        adoptAccountSettings(settings, mark, source);
        markSynced(accountId);
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [accountId, client]);
}
