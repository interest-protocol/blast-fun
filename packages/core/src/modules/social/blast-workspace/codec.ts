import { z } from "zod";
import { DATA_VIEWS, WorkspaceSchema, type WorkspaceV1 } from "./setup.ts";

export const WORKSPACE_MAX_BYTES = 1024 * 1024;
export const WORKSPACE_MAX_DEPTH = 16;
export type EncodeResult =
  | { ok: true; bytes: string }
  | { ok: false; reason: string };
export type DecodeResult =
  | { ok: true; workspace: WorkspaceV1; migrated: boolean }
  | { ok: false; reason: string; original_bytes: string };
export type WorkspaceWriteEnvelope = Readonly<{
  initialize_if_absent: boolean;
  writer_id: string;
  sequence: number;
  workspace: WorkspaceV1;
}>;
const writeEnvelope = z.strictObject({
  initialize_if_absent: z.boolean(),
  writer_id: z.string().min(1),
  sequence: z.number().int().positive(),
  workspace: z.unknown(),
});

function checkDepth(value: unknown, depth = 0): void {
  if (depth > WORKSPACE_MAX_DEPTH) throw new Error("nesting_too_deep");
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "__proto__") throw new Error("unsafe_key");
    checkDepth(child, depth + 1);
  }
}

function assertUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length)
    throw new Error("duplicate_membership");
}

function assertSelection(
  selected: string | null,
  enabled: readonly string[],
): void {
  assertUnique(enabled);
  if (selected === null ? enabled.length > 0 : !enabled.includes(selected))
    throw new Error("invalid_selection");
}

function assertMembership(workspace: WorkspaceV1): void {
  const all = [...workspace.visible_order, ...workspace.retained_order];
  assertUnique(all);
  if (
    all.length !== Object.keys(workspace.panels).length ||
    all.some((id) => !Object.hasOwn(workspace.panels, id))
  )
    throw new Error("invalid_membership");
  if (workspace.visible_order.length > workspace.desktop_capacity)
    throw new Error("invalid_capacity");
  for (const id of [workspace.focused_panel_id, workspace.mobile_panel_id]) {
    if (
      id === null
        ? workspace.visible_order.length > 0
        : !workspace.visible_order.includes(id)
    )
      throw new Error("invalid_focus");
  }
}

function assertPanels(workspace: WorkspaceV1): void {
  const assets = new Set<string>();
  for (const [id, panel] of Object.entries(workspace.panels)) {
    if (id !== panel.panel_id) throw new Error("invalid_panel_id");
    const key = JSON.stringify([panel.chain, panel.network, panel.coin_type]);
    if (assets.has(key)) throw new Error("duplicate_asset");
    assets.add(key);
    for (const setup of [panel.coin, panel.presale])
      assertSelection(setup.tabs.selected, setup.tabs.enabled);
  }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Validates untrusted setup without applying the write-size limit to in-memory edits. */
export function validateWorkspace(value: unknown): WorkspaceV1 {
  checkDepth(value);
  const beforeBonding = savedBeforeBonding(value);
  const parsed = WorkspaceSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid_setup");
  const workspace = {
    ...parsed.data,
    // Accept older Compare snapshots without losing their coins or trade drafts.
    presentation: "focus" as const,
    desktop_slots: parsed.data.desktop_slots ?? Array.from(
      { length: parsed.data.desktop_capacity },
      (_, index) => parsed.data.visible_order[index] ?? null,
    ),
  };
  const projection = workspace.desktop_slots.filter((id) => id !== null);
  if (workspace.desktop_slots.length !== workspace.desktop_capacity ||
      projection.length !== workspace.visible_order.length ||
      projection.some((id, index) => id !== workspace.visible_order[index]))
    throw new Error("invalid_slots");
  migratePanelViews(workspace, parsed.data.desktop_slots === undefined);
  if (beforeBonding) enableBondingView(workspace);
  assertMembership(workspace);
  workspace.mobile_panel_id = workspace.focused_panel_id;
  assertPanels(workspace);
  assertSelection(workspace.data.selected_view, workspace.data.enabled_views);
  return freeze(workspace);
}

function migratePanelViews(workspace: z.infer<typeof WorkspaceSchema>, legacySlots: boolean) {
  if (legacySlots) {
    for (const panel of Object.values(workspace.panels)) {
      if (panel.coin.tabs.enabled.length && !panel.coin.tabs.enabled.includes("posts"))
        panel.coin.tabs.enabled.push("posts");
    }
  }
  for (const panel of Object.values(workspace.panels)) migratePresaleViews(panel);
}

/** A setup saved before the Bonding view has no controls for it (parsing gives it the defaults). */
function savedBeforeBonding(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("data" in value)) return false;
  const { data } = value;
  if (!data || typeof data !== "object" || !("controls" in data)) return false;
  const { controls } = data;
  return !!controls && typeof controls === "object" && !Object.hasOwn(controls, "Bonding");
}

/** Such a setup shows the new view after Presales, unless every view is off. */
function enableBondingView(workspace: z.infer<typeof WorkspaceSchema>) {
  const enabled = workspace.data.enabled_views;
  if (enabled.length === 0 || enabled.includes("Bonding")) return;
  const after = enabled.indexOf("Presales");
  enabled.splice(after === -1 ? enabled.length : after + 1, 0, "Bonding");
}

function migratePresaleViews(panel: z.infer<typeof WorkspaceSchema>["panels"][string]) {
  if (panel.presale.views_version) return;
  panel.presale.tabs.enabled = [...new Set(panel.presale.tabs.enabled.map(tab => tab === "people" ? "activity" as const : tab))];
  if (panel.presale.tabs.selected === "people") panel.presale.tabs.selected = "activity";
  if (panel.presale.tabs.enabled.length && !panel.presale.tabs.enabled.includes("posts")) panel.presale.tabs.enabled.push("posts");
  panel.presale.views_version = 2;
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : "invalid_setup";
}

/** Encodes the raw local snapshot; account writes must validate their complete envelope separately. */
export function encodeWorkspace(workspace: WorkspaceV1): EncodeResult {
  try {
    const bytes = JSON.stringify(validateWorkspace(workspace));
    if (new TextEncoder().encode(bytes).length > WORKSPACE_MAX_BYTES)
      return { ok: false, reason: "envelope_too_large" };
    return { ok: true, bytes };
  } catch (error) {
    return { ok: false, reason: failureReason(error) };
  }
}

/** Measures the complete HTTP write body, including metadata, without issuing a request. */
export function encodeWorkspaceWriteEnvelope(
  envelope: WorkspaceWriteEnvelope,
): EncodeResult {
  try {
    const parsed = writeEnvelope.safeParse(envelope);
    if (!parsed.success) return { ok: false, reason: "invalid_write_envelope" };
    const bytes = JSON.stringify({
      ...parsed.data,
      workspace: validateWorkspace(parsed.data.workspace),
    });
    if (new TextEncoder().encode(bytes).length > WORKSPACE_MAX_BYTES)
      return { ok: false, reason: "envelope_too_large" };
    return { ok: true, bytes };
  } catch (error) {
    return { ok: false, reason: failureReason(error) };
  }
}

function migrateVisibility(value: unknown): {
  value: unknown;
  migrated: boolean;
} {
  if (!value || typeof value !== "object" || !("data" in value))
    return { value, migrated: false };
  const data = value.data;
  if (!data || typeof data !== "object" || Array.isArray(data))
    return { value, migrated: false };
  const missingEnabled = !Object.hasOwn(data, "enabled_views");
  const missingSelected = !Object.hasOwn(data, "selected_view");
  if (!missingEnabled && !missingSelected) return { value, migrated: false };
  const enabled = missingEnabled
    ? [...DATA_VIEWS]
    : "enabled_views" in data
      ? data.enabled_views
      : [];
  const selected = missingSelected
    ? Array.isArray(enabled)
      ? (enabled[0] ?? null)
      : null
    : "selected_view" in data
      ? data.selected_view
      : null;
  return {
    value: {
      ...value,
      data: { ...data, enabled_views: enabled, selected_view: selected },
    },
    migrated: true,
  };
}

export function decodeWorkspace(bytes: string): DecodeResult {
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    return { ok: false, reason: "malformed_json", original_bytes: bytes };
  }
  try {
    checkDepth(value);
    if (
      value &&
      typeof value === "object" &&
      "schema_version" in value &&
      value.schema_version !== 1
    )
      throw new Error("unsupported_schema");
    if (new TextEncoder().encode(bytes).length > WORKSPACE_MAX_BYTES)
      throw new Error("envelope_too_large");
    const migration = migrateVisibility(value);
    return {
      ok: true,
      workspace: validateWorkspace(migration.value),
      migrated: migration.migrated,
    };
  } catch (error) {
    return { ok: false, reason: failureReason(error), original_bytes: bytes };
  }
}
