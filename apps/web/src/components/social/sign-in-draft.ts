"use client";

import { useEffect, useRef } from "react";

export const SIGN_IN_DRAFT_EVENT = "blast:before-oauth";
type Fields = Readonly<Record<string, string>>;
const PREFIX = "blast:sign-in-draft:";

/** Unsigned form inputs only: never store account reads, balances, proofs or executable quotes. */
export function saveSignInDraft(storage: Pick<Storage, "setItem">, key: string, path: string, fields: Fields, now = Date.now()): boolean {
  try {
    storage.setItem(PREFIX + key, JSON.stringify({ path, fields, at: now }));
    return true;
  } catch {
    // Blocked storage still preserves inputs through sign-in in the mounted page.
    return false;
  }
}

export function takeSignInDraft(storage: Pick<Storage, "getItem" | "removeItem">, key: string, path: string, now = Date.now()): Fields | null {
  try {
    const raw = storage.getItem(PREFIX + key);
    if (raw === null) return null;
    storage.removeItem(PREFIX + key);
    if (raw.length > 128_000) return null;
    const saved = JSON.parse(raw);
    if (saved?.path !== path || typeof saved.at !== "number" || saved.at > now || now - saved.at > 30 * 60_000) return null;
    if (!saved.fields || typeof saved.fields !== "object" || Array.isArray(saved.fields) || !Object.values(saved.fields).every((value) => typeof value === "string")) return null;
    return saved.fields;
  } catch {
    return null;
  }
}

/** Save at the OAuth boundary, and restore once when the same route returns. */
export function useSignInDraft(key: string, fields: Fields | null, restore: (saved: Fields) => void, active = true): void {
  const latest = useRef({ fields, restore });
  useEffect(() => {
    latest.current = { fields, restore };
  });
  useEffect(() => {
    if (!active) return;
    let storage: Storage;
    try { storage = window.sessionStorage; } catch { return; }
    const saved = takeSignInDraft(storage, key, window.location.pathname);
    if (saved) latest.current.restore(saved);
    const save = () => {
      if (latest.current.fields) saveSignInDraft(storage, key, window.location.pathname, latest.current.fields);
    };
    document.addEventListener(SIGN_IN_DRAFT_EVENT, save);
    return () => document.removeEventListener(SIGN_IN_DRAFT_EVENT, save);
  }, [key, active]);
}
