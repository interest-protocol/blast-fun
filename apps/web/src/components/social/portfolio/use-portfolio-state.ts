"use client";

import { useState, useSyncExternalStore, type SetStateAction } from "react";
import { savedListContent, saveListContent } from "#web/components/blast-ui/list-restoration.ts";
import { useSocialViewer } from "../SignInGate";

const CHANGED = "blast:portfolio-controls";
function subscribe(change: () => void) {
  window.addEventListener(CHANGED, change);
  window.addEventListener("popstate", change);
  return () => {
    window.removeEventListener(CHANGED, change);
    window.removeEventListener("popstate", change);
  };
}

/** History is the source of truth: save on interaction, restore after hydration, isolate each viewer. */
export function usePortfolioState<T>(key: string, initial: T) {
  const viewer = useSocialViewer();
  const identity = `portfolio:${viewer.callsign ?? "visitor"}:${key}`;
  const [fallback] = useState(initial);
  const read = () => savedListContent<T>(identity) ?? fallback;
  const value = useSyncExternalStore(subscribe, read, () => fallback);
  const setValue = (next: SetStateAction<T>) => {
    const selected = typeof next === "function" ? (next as (value: T) => T)(read()) : next;
    saveListContent(identity, selected);
    window.dispatchEvent(new Event(CHANGED));
  };
  return [value, setValue] as const;
}
