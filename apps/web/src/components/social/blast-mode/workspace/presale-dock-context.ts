"use client";

import { createContext } from "react";

export const WorkspacePresaleDockContext = createContext<Readonly<{
  target: HTMLElement | null;
  activeId: string | null;
  open: (id: string) => void;
  close: () => void;
}> | null>(null);
