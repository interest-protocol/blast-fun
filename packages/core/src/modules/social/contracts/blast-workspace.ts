import { z } from "zod";

import { validateWorkspace, WORKSPACE_MAX_DEPTH } from "../blast-workspace/codec.ts";
import { DataControlsSchema, PanelSchema, WorkspaceSchema, type WorkspaceV1 } from "../blast-workspace/setup.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";

export const BLAST_WORKSPACE_PATH = "/api/social/me/blast-workspace";
export const BLAST_WORKSPACE_READ_ROUTE = `GET ${BLAST_WORKSPACE_PATH}`;
export const BLAST_WORKSPACE_WRITE_ROUTE = `PUT ${BLAST_WORKSPACE_PATH}`;
export const BlastWorkspaceWriteSchema = z.strictObject({
  initialize_if_absent: z.boolean(),
  writer_id: z.string().min(1),
  sequence: z.number().int().positive().safe(),
  workspace: z.unknown().nonoptional(),
});
export type BlastWorkspaceWrite = Omit<z.infer<typeof BlastWorkspaceWriteSchema>, "workspace"> & { workspace: WorkspaceV1 };
export type BlastWorkspaceResponse = Readonly<Omit<z.infer<typeof blastWorkspaceResponseSchema>, "workspace"> & { workspace: WorkspaceV1 | null }>;
export type BlastWorkspaceAcknowledgement = Readonly<z.infer<typeof blastWorkspaceAcknowledgementSchema>>;

/**
 * The published structural contract predates layout and portfolio anchors.
 * Derive it from the live model without changing the codec's accepted saved
 * setups or its defaults. Publishing those extensions is a separate change.
 */
const publishedChartSchema = z.union(PanelSchema.shape.coin.shape.chart.options);
const publishedPanelSchema = PanelSchema.extend({
  coin: PanelSchema.shape.coin.extend({ chart: publishedChartSchema }),
  presale: PanelSchema.shape.presale.extend({ chart: publishedChartSchema }),
});
const publishedDataControlsSchema = DataControlsSchema.extend({
  Bonding: DataControlsSchema.shape.Bonding.removeDefault().optional(),
  Portfolio: DataControlsSchema.shape.Portfolio.extend({
    navigation: DataControlsSchema.shape.Portfolio.shape.navigation.omit({ anchor: true }),
  }),
});
export const blastWorkspaceSetupSchema = WorkspaceSchema.omit({ layout: true }).extend({
  panels: z.record(WorkspaceSchema.shape.panels.keyType, publishedPanelSchema),
  desktop_slots: WorkspaceSchema.shape.desktop_slots.unwrap().max(4).optional(),
  data: WorkspaceSchema.shape.data.extend({ controls: publishedDataControlsSchema }),
}).meta({ description: "WorkspaceV1 structural schema generated from the accepted model. Runtime validateWorkspace additionally enforces normalized Sui struct tags, uniqueness, membership, selections, focus, chart viewport order and nesting <=16. No retention cap." });

/** Published shape; the route first reads the envelope to preserve unsupported-version refusals. */
export const blastWorkspaceRequestSchema = BlastWorkspaceWriteSchema.extend({ workspace: blastWorkspaceSetupSchema });
export const blastWorkspaceResponseSchema = z.strictObject({
  account_id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  revision: z.string().regex(/^(0|[1-9][0-9]*)$/),
  saved_at_ms: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable(),
  workspace: blastWorkspaceSetupSchema.nullable(),
});
export const blastWorkspaceAcknowledgementSchema = z.strictObject({
  account_id: blastWorkspaceResponseSchema.shape.account_id,
  revision: z.string().regex(/^[1-9][0-9]*$/),
  saved_at_ms: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});

/** Bounds the entire envelope before model parsing, including unknown fields. */
function assertDepth(value: unknown, depth = 0): void {
  if (depth > WORKSPACE_MAX_DEPTH) throw new SocialRouteError("invalid_request");
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "__proto__") throw new SocialRouteError("invalid_request");
    assertDepth(child, depth + 1);
  }
}

export function parseBlastWorkspaceWrite(value: unknown): BlastWorkspaceWrite {
  assertDepth(value);
  const parsed = BlastWorkspaceWriteSchema.safeParse(value);
  if (!parsed.success) throw new SocialRouteError("invalid_request");
  const workspace = parsed.data.workspace;
  if (workspace !== null && typeof workspace === "object" && "schema_version" in workspace &&
      Number.isInteger(workspace.schema_version) && workspace.schema_version !== 1) {
    throw new SocialRouteError("workspace_schema_unsupported");
  }
  try {
    return { ...parsed.data, workspace: validateWorkspace(workspace) };
  } catch {
    throw new SocialRouteError("invalid_request");
  }
}
