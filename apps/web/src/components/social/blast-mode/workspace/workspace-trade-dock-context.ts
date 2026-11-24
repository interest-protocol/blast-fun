"use client";

import { createContext } from "react";

export const WorkspaceTradeDockContext = createContext<Readonly<{
  target: HTMLElement | null;
  activeId: string | null;
  selectedId?: string | null;
  select: (id: string) => void;
  openTrade?: (id: string) => void;
}> | null>(null);
