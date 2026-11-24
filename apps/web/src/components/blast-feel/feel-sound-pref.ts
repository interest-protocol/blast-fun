"use client";

import { useSyncExternalStore } from "react";

import { deviceStore } from "#web/components/ui-libraries/device-store.ts";

/**
 * The Feel layer's one live flag: whether sound is on, on this device.
 *
 * Kept under the gate's own key, `blast.sound`, as JSON, so a device that used
 * the prototype carries its choice over. Every surface reads this flag and
 * nothing else, so the Settings switch and the Blast mode button are always in
 * step.
 *
 * **Off until the reader turns it on** (the owner, 2026-10-06, amending OA-25
 * Q3a; the gate defaults it on):
 *
 *  - with **no choice stored** the flag reads **off**, for a visitor and for
 *    an account alike: signing in never turns it on by itself;
 *  - a **choice** is made only by the reader flipping a switch (Settings →
 *    Feel → Sound, or the Blast mode speaker button). It is stored here at once
 *    and kept: a stored `true` or `false` is never replaced by a default;
 *  - a signed-in account keeps the choice on the server
 *    (`social_accounts.sound`, `PUT /api/social/me/settings`), where **NULL
 *    means the account has not chosen** (migration 0099). When a session
 *    starts (`adoptAccountSound`), an account's explicit choice is copied
 *    onto the device. An account with none changes nothing here; if the
 *    reader made a choice on this device that no account has yet, it is
 *    handed back to be kept on the account, so it follows them to their next
 *    device. A choice copied from one account is never handed to another (a
 *    shared device);
 *  - the reader's own change on this device always beats an account read that
 *    was already in flight (`soundChangeMark`).
 *
 * The server snapshot is "off", so the server's HTML and the first client
 * render agree and the stored value arrives in the next render — no hydration
 * mismatch. Storage that is missing or refuses (a private window) keeps the
 * choice for the page's life. The page's copy of the choice is a zustand store
 * (OA-28 M6): written to storage first, then every reader — the synth's switch
 * among them — is told in the same call.
 */

export const FEEL_SOUND_KEY = "blast.sound";
/**
 * Set while this device's choice was made here by the reader and no account
 * has it yet — the one a session hands to an account that has not chosen.
 */
export const FEEL_SOUND_PENDING_KEY = "blast.soundPending";

/** Off until the reader turns it on, signed in or not. */
export const FEEL_SOUND_DEFAULT = false;

export type FeelPrefStorage = Pick<Storage, "getItem" | "setItem">;

function storedBoolean(storage: FeelPrefStorage | null, key: string): boolean | null {
  try {
    const raw = storage?.getItem(key);
    if (raw === null || raw === undefined) return null;
    const value: unknown = JSON.parse(raw);
    return typeof value === "boolean" ? value : null;
  } catch {
    return null;
  }
}

/** The reader's stored choice, or null when this device has none (nothing stored, malformed, or no storage). */
export function readSoundChoice(storage: FeelPrefStorage | null): boolean | null {
  return storedBoolean(storage, FEEL_SOUND_KEY);
}

/** The stored choice, or the default (off) when there is none. */
export function readSoundEnabled(storage: FeelPrefStorage | null): boolean {
  return readSoundChoice(storage) ?? FEEL_SOUND_DEFAULT;
}

/** Remembers the choice. False when storage refused it; the page keeps it in memory. */
export function writeSoundEnabled(storage: FeelPrefStorage | null, enabled: boolean): boolean {
  try {
    if (!storage) return false;
    storage.setItem(FEEL_SOUND_KEY, JSON.stringify(enabled));
    return true;
  } catch {
    return false;
  }
}

/** This device's choice (read on first use): null while there is none. */
const choice = deviceStore<boolean | null>(() => readSoundChoice(storage()));
/** The pending mark, for a page whose storage refuses it. */
let pendingInMemory = false;
/** Counts the reader's own changes on this device, so a late account read never undoes one. */
let localChanges = 0;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function choiceNow(): boolean | null {
  return choice.get();
}

function snapshot(): boolean {
  return choiceNow() ?? FEEL_SOUND_DEFAULT;
}

function pendingNow(): boolean {
  const stored = storedBoolean(storage(), FEEL_SOUND_PENDING_KEY);
  return stored ?? pendingInMemory;
}

function setPending(pending: boolean): void {
  pendingInMemory = pending;
  try {
    storage()?.setItem(FEEL_SOUND_PENDING_KEY, JSON.stringify(pending));
  } catch {
    // Storage refused: the mark holds for the page's life.
  }
}

/** Calls `listener` on every change of the flag, here or in another tab. Returns the unsubscribe. */
export function subscribeSoundEnabled(listener: () => void): () => void {
  const off = choice.subscribe(listener);
  // Another tab's change: read it again and tell every reader.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== FEEL_SOUND_KEY) return;
    choice.set(readSoundChoice(storage()));
  };
  const target = typeof window === "undefined" ? null : window;
  target?.addEventListener("storage", onStorage);
  return () => {
    off();
    target?.removeEventListener("storage", onStorage);
  };
}

/** Whether sound is on for this device (off while hydrating, and off by default). */
export function useSoundEnabled(): boolean {
  return useSyncExternalStore(subscribeSoundEnabled, snapshot, () => FEEL_SOUND_DEFAULT);
}

/**
 * Keeps `follow` (the synth's switch) in step with the flag: called now and,
 * synchronously, on every change — so nothing can sound in the moment between
 * the flag going off and a render catching up. Returns the unsubscribe.
 */
export function followSoundEnabled(follow: (enabled: boolean) => void): () => void {
  follow(snapshot());
  return subscribeSoundEnabled(() => follow(snapshot()));
}

function apply(enabled: boolean): void {
  if (choiceNow() === enabled) return;
  writeSoundEnabled(storage(), enabled);
  choice.set(enabled);
}

/**
 * The reader's own choice: sets the flag, remembers it on this device and
 * tells every reader. Until an account keeps it (`markSoundSaved`), it is
 * pending, so a session whose account has no choice yet takes this one.
 */
export function setSoundEnabled(enabled: boolean): void {
  localChanges += 1;
  apply(enabled);
  setPending(true);
}

/** A mark to pass to `adoptAccountSound`, taken before the account's settings are read. */
export function soundChangeMark(): number {
  return localChanges;
}

/**
 * A signed-in account's answer (`sound` from `GET /api/social/me/settings`),
 * read since `mark`:
 *
 *  - the reader changed the flag here since `mark`: nothing (their newer
 *    choice wins, and is on its way to the account);
 *  - the account has a choice: it becomes this device's, and nothing is
 *    pending any more;
 *  - the account has none (null): this device keeps its own value — off when
 *    it has never chosen.
 *
 * Returns the choice the account should now keep — this device's own, when
 * the account has none and the reader made one here that no account has —
 * or null when there is nothing to save.
 */
export function adoptAccountSound(account: boolean | null, mark: number): boolean | null {
  if (localChanges !== mark) return null;
  if (account !== null) {
    apply(account);
    setPending(false);
    return null;
  }
  const own = choiceNow();
  return own !== null && pendingNow() ? own : null;
}

/**
 * An account now keeps `enabled` (a save answered). Clears the pending mark
 * when that is still this device's choice, so it is never handed to another
 * account that signs in here.
 */
export function markSoundSaved(enabled: boolean): void {
  if (choiceNow() === enabled) setPending(false);
}

/** Test seam: forgets the cached value so the next read goes back to storage. */
export function resetSoundEnabledCache(): void {
  choice.forget(false);
  pendingInMemory = false;
}

/** The flag as it stands, outside React (a handler or a test). */
export function soundEnabledNow(): boolean {
  return snapshot();
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(listener: () => void): () => void {
  const list = window.matchMedia(REDUCED_MOTION_QUERY);
  list.addEventListener("change", listener);
  return () => list.removeEventListener("change", listener);
}

function reducedMotionSnapshot(): boolean {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/**
 * Whether the reader asked for reduced motion. Read during render only where
 * nothing in the server's HTML depends on it; everything the layer animates is
 * decided in an event handler, where `motionAllowed()` is read fresh.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, reducedMotionSnapshot, () => false);
}

/**
 * Whether the layer may animate at all, read at the moment of the gesture.
 * Under reduced motion the answer is no, and the layer then adds **no
 * animation**: no ball is created, no keyframes run, the charge glow gets no
 * transition. Not a shorter animation — none (FEEL-LAYER.md §6.2).
 */
export function motionAllowed(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return !window.matchMedia(REDUCED_MOTION_QUERY).matches;
}
