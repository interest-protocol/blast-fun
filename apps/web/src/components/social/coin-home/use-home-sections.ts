"use client";

import { useSyncExternalStore } from "react";

import { deviceStore } from "#web/components/ui-libraries/device-store.ts";

import { homeSectionsCookieLine, homeSectionsCookieValue, parseHomeSections, type HomeSectionPrefs } from "./home-sections";

/**
 * The device's Home sections as a store (`home-sections.ts` has the rules):
 * read from the `blast.home` cookie the first time they are asked for,
 * written back to it on every change (so the next server render lays the
 * page out the same way and skips the hidden sections' reads), and told to
 * every reader at once. While hydrating, the server's reading of the same
 * cookie is the snapshot, so the first paint and the hydrated page agree.
 */
const store = deviceStore<HomeSectionPrefs>(() => parseHomeSections(typeof document === "undefined" ? null : homeSectionsCookieValue(document.cookie)));

export function useHomeSections(server: HomeSectionPrefs): HomeSectionPrefs {
  return useSyncExternalStore(store.subscribe, store.get, () => server);
}

/** Remembers the sections on this device (the cookie may be refused; the choice then holds for the page's life) and tells every reader. */
export function setHomeSections(next: HomeSectionPrefs): void {
  try {
    document.cookie = homeSectionsCookieLine(next, window.location.protocol === "https:");
  } catch {
    // A refused cookie: the in-memory choice still holds.
  }
  store.set(next);
}
