import { readBrowserStorage, writeBrowserStorage } from "#web/lib/browser-storage.ts";
import type { WorkspaceV1 } from "@blast/core/modules/social/blast-workspace/setup.ts";
import { DEFAULT_WORKSPACE_LAYOUT } from "@blast/core/modules/social/blast-workspace/workspace-layout-model.ts";

/** Geometry only. Never cache assets, account identity, balances, drafts or permissions here. */
export type WorkspacePreview = Readonly<{
  presentation: "focus" | "compare";
  panels: number;
  saved: boolean;
  discover: boolean;
  ticket: number | null;
  holders: number | null;
  activityHidden: boolean;
}>;
export const WORKSPACE_PREVIEW_KEY = "blast.workspace.preview:1";

/** Self-contained because the parser-time cover uses this same validator. */
export function parseWorkspacePreview(value: unknown): WorkspacePreview | undefined {
  if (!value || typeof value !== "object") return;
  const p = value as Record<string, unknown>;
  const length = (v: unknown) => v === null || typeof v === "number" && Number.isInteger(v) && v >= 170 && v <= 900;
  if ((p.presentation !== "focus" && p.presentation !== "compare") || typeof p.panels !== "number" || !Number.isInteger(p.panels) || p.panels < 1 || p.panels > 6 || typeof p.saved !== "boolean" || typeof p.discover !== "boolean" || typeof p.activityHidden !== "boolean" || !length(p.ticket) || !length(p.holders)) return;
  return { presentation: p.presentation, panels: p.panels, saved: p.saved, discover: p.discover, ticket: p.ticket as number | null, holders: p.holders as number | null, activityHidden: p.activityHidden };
}
export function workspacePreview(snapshot: WorkspaceV1): WorkspacePreview {
  return {
    presentation: snapshot.presentation ?? "focus", panels: Math.max(1, Math.min(6, snapshot.visible_order.length)),
    saved: snapshot.retained_order.length > 0, discover: !snapshot.data.collapsed,
    ticket: snapshot.layout?.heights?.trade ?? null, holders: snapshot.layout?.heights?.activity ?? null,
    activityHidden: snapshot.layout?.hidden.includes("activity") ?? false,
  };
}
export function readWorkspacePreview(): WorkspacePreview | undefined {
  try { return parseWorkspacePreview(JSON.parse(readBrowserStorage("session", WORKSPACE_PREVIEW_KEY) ?? "null")); } catch { return; }
}
export function rememberWorkspacePreview(snapshot: WorkspaceV1): void {
  writeBrowserStorage("session", WORKSPACE_PREVIEW_KEY, JSON.stringify(workspacePreview(snapshot)));
}
export function previewLayout(preview: WorkspacePreview) {
  return { ...DEFAULT_WORKSPACE_LAYOUT, hidden: preview.activityHidden ? ["activity" as const] : [], heights: { ...(preview.ticket === null ? {} : { trade: preview.ticket }), ...(preview.holders === null ? {} : { activity: preview.holders }) } };
}
