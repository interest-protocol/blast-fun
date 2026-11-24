"use client";

import { createContext, useContext } from "react";
import type { DataView, WorkspaceV1 } from "@blast/core/modules/social/blast-workspace/setup.ts";
import type { WorkspaceStore } from "./model";

export type WorkspaceOwner =
  | Readonly<{ kind: "guest" }>
  | Readonly<{ kind: "account"; account_id: string; store?: WorkspaceStore }>;
export type WorkspaceOwnerResolver = (
  signal: AbortSignal,
) => Promise<WorkspaceOwner>;
export type WorkspaceOwnerState =
  | Readonly<{ status: "pending" }>
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "ready"; owner: WorkspaceOwner }>;

type WorkspacePresentation = Readonly<{
  mode_open: boolean;
  document_visible: boolean;
  visible_panel_ids: readonly string[];
  paged_panel_ids?: readonly string[];
  selected_mobile_id: string | null;
  mobile: boolean;
  data_covers_mobile_panel: boolean;
}>;
export type WorkspaceContextValue = Readonly<{
  snapshot: WorkspaceV1;
  dispatch: WorkspaceStore;
  owner: WorkspaceOwner;
  entry_generation: number;
  presale_history?: ReadonlySet<string>;
  selectAsset?: (panelId: string) => void;
  presentation: WorkspacePresentation;
  /** The views Discover offers, in order (every view less `WorkspaceSlots.unavailable`). */
  offered_views?: readonly DataView[];
}>;
export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace(): WorkspaceContextValue {
  const workspace = useContext(WorkspaceContext);
  if (!workspace)
    throw new Error("Workspace content must be mounted inside WorkspaceHost");
  return workspace;
}
