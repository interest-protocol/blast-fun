"use client";

import { useSyncExternalStore } from "react";

import { deviceStore } from "#web/components/ui-libraries/device-store.ts";

/**
 * Favourite coins (R3-10, FEATURE-MAP-R3 §14.2): up to five coins pinned to
 * the top of **every** list of your coins — the coins sheet's pickers, the
 * All-coins screen, Home's "Your coins" card, the collapsed right column and
 * the profile's holdings — in the order they were picked.
 *
 * The order is per device and has no server field (R3-DELTA §2 row 11): it
 * lives in `localStorage` under the prototype's key `blast.coinPins` as a
 * JSON array of coin keys (`usdc`, `sui`, or a presale id). Storage may be
 * missing or refuse writes (a private window): reads then fall back to no
 * favourites and the choice holds for the page's life. The server snapshot is
 * always "no favourites", so the first paint and hydration agree and the
 * stored order arrives in the next render.
 */

/** The most coins that can be starred; a sixth star is disabled. */
export const PIN_MAX = 5;

export const COIN_PINS_KEY = "blast.coinPins";

export type PinStorage = Pick<Storage, "getItem" | "setItem">;

const EMPTY: readonly string[] = Object.freeze([]);

function storage(): PinStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * The stored favourites: a de-duplicated list of coin keys, at most `PIN_MAX`
 * long. Anything missing or malformed reads as no favourites.
 */
export function readCoinPins(store: PinStorage | null): readonly string[] {
  let raw: string | null = null;
  try {
    raw = store?.getItem(COIN_PINS_KEY) ?? null;
  } catch {
    return EMPTY;
  }
  if (raw === null) return EMPTY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY;
  }
  if (!Array.isArray(parsed)) return EMPTY;
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const value of parsed) {
    if (typeof value !== "string" || value === "" || seen.has(value)) continue;
    keys.push(value);
    seen.add(value);
    if (keys.length === PIN_MAX) break;
  }
  return keys.length === 0 ? EMPTY : Object.freeze(keys);
}

/** Writes the favourites; false when storage refused them (the in-memory order still holds). */
export function writeCoinPins(store: PinStorage | null, pins: readonly string[]): boolean {
  try {
    store?.setItem(COIN_PINS_KEY, JSON.stringify(pins.slice(0, PIN_MAX)));
    return store !== null;
  } catch {
    return false;
  }
}

/**
 * Starring or unstarring one coin (the prototype's `togglePin`): a pinned
 * coin is dropped, an unpinned one is appended while there is room, and the
 * sixth star changes nothing.
 */
export function togglePin(pins: readonly string[], key: string): readonly string[] {
  if (pins.includes(key)) return pins.filter((pin) => pin !== key);
  return pins.length < PIN_MAX ? [...pins, key] : pins;
}

/** Favourites that name a coin the wallet still holds, in pin order (the prototype's `coinPins()`). */
export function livePins(pins: readonly string[], coins: readonly Readonly<{ key: string }>[]): readonly string[] {
  return pins.filter((pin) => coins.some((coin) => coin.key === pin));
}

/**
 * A coin list with its favourites first, in pin order, and everything else in
 * the order it came (the prototype's `pinSort`). Stable: no favourites leaves
 * the list untouched.
 */
export function pinSort<Coin extends Readonly<{ key: string }>>(coins: readonly Coin[], pins: readonly string[]): readonly Coin[] {
  if (pins.length === 0) return coins;
  const starred = pins.flatMap((pin) => coins.filter((coin) => coin.key === pin));
  if (starred.length === 0) return coins;
  const pinned = new Set(pins);
  return [...starred, ...coins.filter((coin) => !pinned.has(coin.key))];
}

/** A star's label and title: "Unpin USDC", "Pin USDC to favourites", or "Up to 5 favourites" when five are starred. */
export function pinLabel(name: string, pinned: boolean, full: boolean): string {
  if (pinned) return `Unpin ${name}`;
  return full ? `Up to ${PIN_MAX} favourites` : `Pin ${name} to favourites`;
}

// ---------- the live store (zustand, OA-28 M6) ----------

// `useSyncExternalStore` compares by identity, so the parsed list is held until it changes.
const pins = deviceStore(() => readCoinPins(storage()));

/** This device's favourite coins, in pin order (none while hydrating). */
export function useCoinPins(): readonly string[] {
  return useSyncExternalStore(pins.subscribe, pins.get, () => EMPTY);
}

/** Stars or unstars one coin on this device and tells every list at once. */
export function toggleCoinPin(key: string): readonly string[] {
  const next = togglePin(pins.get(), key);
  if (next === pins.get()) return next;
  const frozen = Object.freeze(next);
  writeCoinPins(storage(), frozen);
  pins.set(frozen);
  return frozen;
}

/** Forgets the parsed list, so the next read goes back to storage (tests, and another tab's write). */
export function resetCoinPinsCache(): void {
  pins.forget(true);
}
