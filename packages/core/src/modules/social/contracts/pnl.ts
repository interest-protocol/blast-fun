import { z } from "zod";

import { socialAddressSchema } from "./primitives.ts";

/** Null means incomplete acquisition costs, history, or USD pricing. */
const pnlUsdSchema = z.string().regex(/^-?(0|[1-9][0-9]*)\.[0-9]{2}$/).nullable();

export const pnlFiguresSchema = z.strictObject({
  realized_usd: pnlUsdSchema,
  unrealized_usd: pnlUsdSchema,
  total_usd: pnlUsdSchema,
});

export type PnlFigures = Readonly<z.infer<typeof pnlFiguresSchema>>;

export const pnlAssetSchema = pnlFiguresSchema.extend({
  presale_id: socialAddressSchema.nullable(),
  launch_id: socialAddressSchema.optional(),
  coin_type: z.string(),
  symbol: z.string(),
  icon_url: z.string().nullable(),
  tracked_balance: z.string().regex(/^(0|[1-9][0-9]*)$/),
  basis_usd: pnlUsdSchema,
}).refine((asset) => asset.presale_id !== null || asset.launch_id !== undefined).meta({
  anyOf: [
    { properties: { presale_id: { type: "string" } } },
    { properties: { launch_id: { type: "string" } }, required: ["launch_id"] },
  ],
});

export type PnlAsset = Readonly<z.infer<typeof pnlAssetSchema>>;

export const pnlWalletSyncSchema = z.strictObject({
  status: z.enum(["ready", "syncing", "stale"]),
  checkpoint: z.string().regex(/^[0-9]+$/).nullable(),
  as_of_ms: z.number().nonnegative().refine(Number.isInteger).meta({ type: "integer" }).nullable(),
});

/**
 * GET /api/social/me/pnl and GET /api/social/profiles/{callsign}/pnl.
 * Every linked wallet: indexed trades of Blast-launched coins since the launch checkpoint,
 * across all venues, valued from confirmed chain activity rather than
 * submitted quotes. Wallet kind and transaction submission route do not
 * change eligibility. Prelaunch trades are excluded; opening holdings have unknown cost.
 * Includes presale and bonding-curve origins and closed positions; gas is excluded.
 * Public access uses the existing portfolio opt-in and account privacy gate.
 */
export const socialPnlSchema = z.strictObject({
  scope: z.literal("indexed_sale_coins"),
  period: z.literal("since_launch"),
  totals: pnlFiguresSchema,
  assets: z.array(pnlAssetSchema),
  history_complete: z.boolean(),
  wallet_sync: pnlWalletSyncSchema,
});

export type SocialPnl = Readonly<Omit<z.infer<typeof socialPnlSchema>, "assets"> & {
  assets: readonly PnlAsset[];
}>;

// The generator keeps the published local references and allOf presentation.
export const pnlSchemaDefinitions = { usd: pnlUsdSchema, figures: pnlFiguresSchema };

export const SOCIAL_PNL_PATH = "/api/social/me/pnl";

export function socialPublicPnlPath(callsign: string): string {
  return `/api/social/profiles/${encodeURIComponent(callsign)}/pnl`;
}
