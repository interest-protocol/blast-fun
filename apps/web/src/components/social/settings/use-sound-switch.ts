"use client";

import { diagnosticMessage, type ErrorDiagnostic } from "#web/lib/errors.ts";

import { useCallback, useEffect, useRef } from "react";

import { markSoundSaved, useFeelSound } from "#web/components/blast-feel/index.ts";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { invalidateAfter } from "#web/lib/query/invalidate.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";

import { useSocialViewer } from "../SignInGate";
import type { ApiResult, TokenSource } from "#web/components/social/social-api.ts";
import { saveSettings } from "./settings-client";

/**
 * The toast when the account did not keep a sound choice. The device keeps it
 * either way: the reader asked for sound here, and this device honours it.
 */
export function soundSaveFailureMessage(on: boolean, diagnostic: ErrorDiagnostic = {}): string {
  return diagnosticMessage(`Sound is ${on ? "on" : "off"} on this device. Your account couldn’t save it, so another device keeps its own choice.`, diagnostic);
}

/** The last sound save in flight: each waits for the one before, so the server sees them in the reader's order. */
let saves: Promise<unknown> = Promise.resolve();

/**
 * Keeps a sound choice on the signed-in account (`PUT /api/social/me/settings
 * { sound }`, through `callSocialApi`, so a wallet session sends its cookie and
 * never a hand-built header, OA-16). Resolves to the toast to show, or null
 * when it was kept.
 *
 * Saves go one at a time, in order, so a session handing the account this
 * device's choice (`keepDeviceSound`) can never land after — and undo — a
 * switch the reader flipped a moment later. Once a save is kept, this
 * device's choice is no longer pending (`markSoundSaved`).
 */
export function saveAccountSound(getAccessToken: TokenSource, on: boolean, fetch?: typeof globalThis.fetch): Promise<string | null> {
  const saved = saves.then(async () => {
    const result: ApiResult<unknown> = await saveSettings(fetch ? { getAccessToken, fetch } : { getAccessToken }, { sound: on });
    if (result.status !== "ok") return soundSaveFailureMessage(on, result);
    markSoundSaved(on);
    return null;
  });
  saves = saved.catch(() => undefined);
  return saved;
}

let handing = false;

/**
 * Hands an account that has not chosen (`sound: null`) the choice the reader
 * made on this device (`adoptAccountSound`'s answer), so it follows them to
 * their next device. Quiet: nothing was asked of the reader just now, so a
 * failure shows no toast — the choice stays pending and the next session
 * tries again. Two reads answering at once hand it over once. Resolves to
 * whether the account kept it.
 */
export async function keepDeviceSound(getAccessToken: TokenSource, on: boolean, fetch?: typeof globalThis.fetch): Promise<boolean> {
  if (handing) return false;
  handing = true;
  try {
    return (await saveAccountSound(getAccessToken, on, fetch)) === null;
  } finally {
    handing = false;
  }
}

/**
 * The header's site-wide sound control under the social session:
 *
 *  - the device's live flag flips at once (and turning it on plays its one
 *    confirming tap), so nothing waits on a request;
 *  - a signed-in account also keeps the choice (`saveAccountSound`), so it
 *    follows the account to its next device and session; a visitor's choice
 *    stays on this device until they sign in to an account that has not
 *    chosen (`keepDeviceSound`).
 */
export function useSoundSwitch(): (on: boolean) => void {
  const { setSoundEnabled } = useFeelSound();
  const viewer = useSocialViewer();
  const toast = useToast();
  const client = useAppQueryClient();
  // A viewer with a callsign has a Blast Account (the session knows it once `me` answered).
  const latest = useRef({ signedIn: viewer.signedIn, hasAccount: viewer.callsign !== null, getAccessToken: viewer.getAccessToken });
  useEffect(() => {
    latest.current = { signedIn: viewer.signedIn, hasAccount: viewer.callsign !== null, getAccessToken: viewer.getAccessToken };
  });

  return useCallback(
    (on: boolean) => {
      setSoundEnabled(on);
      const { signedIn, hasAccount, getAccessToken } = latest.current;
      if (!signedIn || !hasAccount || !getAccessToken) return;
      void saveAccountSound(getAccessToken, on).then((message) => {
        if (message) toast(message);
        // Saved: the account's settings read is out of date (the next one reads the new choice).
        else void invalidateAfter(client, { kind: "settings" });
      });
    },
    [client, setSoundEnabled, toast],
  );
}
