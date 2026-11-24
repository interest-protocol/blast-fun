"use client";

import { useSyncExternalStore } from "react";

import { deviceStore } from "#web/components/ui-libraries/device-store.ts";

import { DEFAULT_SOCIAL_EXPLORER, isSocialExplorer, type SocialExplorer } from "@blast/core/modules/social/contracts/settings.ts";

/**
 * Per-device preferences outside the shell's no-flash set (`prefs.ts`):
 *
 * - `celebrate`: Settings → Notifications → "Celebrations" (quiet presale
 *   funding and migration notices), on by default. Per device, as the
 *   prototype keeps it (FEATURE-MAP §7, §19).
 * - `explorer`: where transaction links open, Suiscan by default. A
 *   signed-in account's choice is stored on the server (`PUT
 *   /api/social/me/settings`) and copied here whenever it is read or saved,
 *   so every page can build links without a request; a visitor's choice
 *   lives only here.
 *
 * Stored in `localStorage` under the prototype's `blast.<name>` keys as JSON.
 * Storage may be missing or refuse writes (private windows): reads fall back
 * to the defaults and the choice holds for the page's life. The server
 * snapshot is the defaults, so hydration matches and the stored values
 * arrive in the next render. The page's copy is a zustand store (OA-28 M6).
 */
export type DevicePrefs = Readonly<{ celebrate: boolean; explorer: SocialExplorer }>;
export type DevicePrefName = keyof DevicePrefs;

export const DEVICE_PREF_KEYS: Readonly<Record<DevicePrefName, string>> = {
  celebrate: "blast.celebrate",
  explorer: "blast.explorer",
};

export const DEFAULT_DEVICE_PREFS: DevicePrefs = Object.freeze({ celebrate: true, explorer: DEFAULT_SOCIAL_EXPLORER });

type PrefStorage = Pick<Storage, "getItem" | "setItem">;

function parsed(storage: PrefStorage | null, key: string): unknown {
  try {
    const raw = storage?.getItem(key);
    return raw === null || raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** The stored preferences; anything missing or malformed reads as its default. */
export function readDevicePrefs(storage: PrefStorage | null): DevicePrefs {
  const celebrate = parsed(storage, DEVICE_PREF_KEYS.celebrate);
  const explorer = parsed(storage, DEVICE_PREF_KEYS.explorer);
  return {
    celebrate: typeof celebrate === "boolean" ? celebrate : DEFAULT_DEVICE_PREFS.celebrate,
    explorer: isSocialExplorer(explorer) ? explorer : DEFAULT_DEVICE_PREFS.explorer,
  };
}

/** Writes one preference; false when storage refused it (the in-memory value still holds). */
export function writeDevicePref<Name extends DevicePrefName>(
  storage: PrefStorage | null,
  name: Name,
  value: DevicePrefs[Name],
): boolean {
  try {
    if (!storage) return false;
    storage.setItem(DEVICE_PREF_KEYS[name], JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const prefs = deviceStore(() => readDevicePrefs(storage()));

function subscribe(listener: () => void): () => void {
  const off = prefs.subscribe(listener);
  // Another tab's change: read again, and tell this reader (each reader hears it from its own listener).
  const onStorage = (event: StorageEvent) => {
    if (event.key && !Object.values(DEVICE_PREF_KEYS).includes(event.key)) return;
    prefs.hold(readDevicePrefs(storage()));
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    off();
    window.removeEventListener("storage", onStorage);
  };
}

/** This device's preferences (the defaults while hydrating). */
export function useDevicePrefs(): DevicePrefs {
  return useSyncExternalStore(subscribe, prefs.get, () => DEFAULT_DEVICE_PREFS);
}

/** Sets one preference on this device and tells every reader. */
export function setDevicePref<Name extends DevicePrefName>(name: Name, value: DevicePrefs[Name]): void {
  const current = prefs.get();
  if (current[name] === value) return;
  const next = { ...current, [name]: value };
  writeDevicePref(storage(), name, value);
  prefs.set(next);
}
