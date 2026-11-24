"use client";

import { useSyncExternalStore } from "react";

import { deviceStore } from "#web/components/ui-libraries/device-store.ts";

import { homeRowsCookieLine, homeRowsCookieValue, parseHomeRows } from "./home-rows";

/**
 * The device's rows per page as a store (`home-rows.ts` has the rules): read
 * from the `blast.home.rows` cookie the first time, written back on every
 * change, told to every reader at once. While hydrating, the server's
 * reading of the same cookie is the snapshot, so the first paint and the
 * hydrated page agree.
 */
const store = deviceStore<number>(() => parseHomeRows(typeof document === "undefined" ? null : homeRowsCookieValue(document.cookie)));

export function useHomeRows(server: number): number {
  return useSyncExternalStore(store.subscribe, store.get, () => server);
}

/** Remembers the count on this device (the cookie may be refused; the choice then holds for the page's life) and tells every reader. */
export function setHomeRows(rows: number): void {
  try {
    document.cookie = homeRowsCookieLine(rows, window.location.protocol === "https:");
  } catch {
    // A refused cookie: the in-memory choice still holds.
  }
  store.set(rows);
}
