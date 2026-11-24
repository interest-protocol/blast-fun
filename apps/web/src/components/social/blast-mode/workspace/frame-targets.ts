"use client";

import { createContext } from "react";

export const WorkspaceToolbarTarget = createContext<HTMLElement | null>(null);
export const WorkspaceStatusTarget = createContext<HTMLElement | null>(null);
/** The header bar renders the save status's slot; the frame hands its element to the status. */
export const WorkspaceStatusSlot = createContext<((element: HTMLElement | null) => void) | null>(null);
