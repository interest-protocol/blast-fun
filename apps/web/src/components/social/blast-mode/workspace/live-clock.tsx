"use client";

import { createContext, useContext, useId, useState, type ReactNode } from "react";
import { workspaceLiveClock, type WorkspaceLiveClock } from "./live-read";

const LiveClock = createContext(workspaceLiveClock);

export function WorkspaceLiveProvider({ clock, children }: Readonly<{ clock: WorkspaceLiveClock; children: ReactNode }>) {
  return <LiveClock value={clock}>{children}</LiveClock>;
}

export function useWorkspaceLiveClock() {
  return useContext(LiveClock);
}

/** Executable quote caches cannot authorize a later presentation from an earlier offer. */
export function useWorkspaceLiveKey(visible: boolean) {
  const mount = useId();
  const [entry, setEntry] = useState({ visible, generation: 0 });
  if (entry.visible !== visible) setEntry({ visible, generation: entry.generation + 1 });
  return `${mount}:${entry.generation}`;
}
