import { BLAST_DEPLOYMENTS, deploymentFingerprint } from "@interest-protocol/blast-sdk/deployments";
import { z } from "zod";
import type { ExpectedDeployment } from "../launchpad-contract/provenance.ts";
import { AFTERMATH_DAO_PACKAGE } from "../sponsor/aftermath-dao.ts";
import type { NativeReplayState } from "./accounting.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

export const METHODOLOGY = "blast-defi-v4";
export const DEFILLAMA_READ_POOL_MAX = 2;
export const HOUR_SECONDS = 3600;
export const DAY_SECONDS = 24 * HOUR_SECONDS;
export const METRICS = [
  "volume",
  "fees",
  "supply_side_revenue",
  "revenue",
  "protocol_revenue",
  "holders_revenue",
] as const;
export type Metric = (typeof METRICS)[number];
export type Coverage = Record<
  Metric,
  { status: "complete" | "unavailable" | "not_applicable"; reason: string | null }
>;
export type ScopeCoverage = Record<"launchpad" | "frontend_router" | "vault_yield", Coverage>;
export type Amounts = Record<Metric, string | null>;
export type Item = {
  component: string;
  coin_type: string;
  included_in_totals: boolean;
  underlying_venue_overlap: boolean;
  accounting_basis: "execution" | "payment" | "collection";
  metrics: Amounts;
  evidence: Record<string, string>;
};
export type Contract = {
  object_id: string;
  kind: "curve" | "presale" | "vault";
  meme_type: string;
  quote_type: string;
  created_timestamp_ms: number;
  tvl: "read_user_quote_custody" | "requires_attribution_review";
};
export type FrontendFeePolicy = {
  first_checkpoint: number;
  end_checkpoint_exclusive: number;
  receivers: string[];
  cetus_packages: string[];
  aftermath_package: typeof AFTERMATH_DAO_PACKAGE | null;
};
export type FrontendFeeCoverage = {
  status: "complete" | "unavailable";
  reason: "frontend_fee_policy_incomplete" | "frontend_fee_source_incomplete" | null;
};
export type Profile = {
  network: "mainnet";
  deployment_fingerprint: string;
  launchpad_original_package: string;
  presale_original_package: string;
  vault_original_package: string;
  core_original_package: string;
  admin_original_package: string;
  // Release evidence must put this at/before EVERY configured package's publication.
  first_checkpoint: string;
  excluded_meme_packages: string[];
  policy_version: string;
};
export type Snapshot = {
  schema_version: 1;
  chain: "sui";
  date: string;
  start_timestamp: number;
  end_timestamp: number;
  methodology_version: typeof METHODOLOGY;
  profile: Profile;
  source: { checkpoint: string; digest: string; timestamp_ms: number; history_start_ms: number };
  coverage: Coverage;
  frontend_fee_coverage: FrontendFeeCoverage;
  scope_coverage: ScopeCoverage;
  frontend_fee_policy: FrontendFeePolicy[];
  items: Item[];
  contracts: Contract[];
  native_replay?: NativeReplayState;
};

export class DefillamaError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function dayInterval(date: string, now = Date.now()): { start: number; end: number } {
  const start = Date.parse(`${date}T00:00:00Z`);
  if (
    !z.string().regex(/^\d{4}-\d{2}-\d{2}$/).safeParse(date).success ||
    !Number.isFinite(start) ||
    new Date(start).toISOString().slice(0, 10) !== date
  ) {
    throw new DefillamaError("invalid_date");
  }
  const end = start + DAY_SECONDS * 1000;
  if (end > now) {
    throw new DefillamaError("day_not_complete", 409);
  }
  return { start, end };
}

export function hourStarts(start: number, end: number, now = Date.now()): number[] {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start % HOUR_SECONDS !== 0 ||
    end % HOUR_SECONDS !== 0 ||
    end <= start ||
    end - start > DAY_SECONDS
  ) {
    throw new DefillamaError("invalid_hour_window");
  }
  if (end * 1000 > now) {
    throw new DefillamaError("hour_not_complete", 409);
  }
  return Array.from({ length: (end - start) / HOUR_SECONDS }, (_, i) => start + i * HOUR_SECONDS);
}

const packageIdSchema = z.string().regex(SUI_OBJECT_ID_PATTERN);
const frontendFeeHistorySchema = z.array(z.object({
  first_checkpoint: z.number().int().positive(),
  end_checkpoint_exclusive: z.number().int().positive(),
  receivers: z.array(packageIdSchema.refine((id) => !/^0x0+$/.test(id))).max(16),
  cetus_packages: z.array(packageIdSchema).max(16),
  aftermath_package: z.literal(AFTERMATH_DAO_PACKAGE).nullable(),
}).strict()).max(500).refine((windows) => windows.every((window, index) =>
  window.first_checkpoint < window.end_checkpoint_exclusive &&
  (window.receivers.length === 0 || window.cetus_packages.length > 0) &&
  (index === 0 || windows[index - 1]!.end_checkpoint_exclusive <= window.first_checkpoint)));

export const defillamaProfileSchema = z.object({
  network: z.literal("mainnet"), deployment_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  launchpad_original_package: packageIdSchema, presale_original_package: packageIdSchema,
  vault_original_package: packageIdSchema, core_original_package: packageIdSchema,
  admin_original_package: packageIdSchema,
  first_checkpoint: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
  policy_version: z.string().regex(/^[a-z0-9-]{1,64}$/),
  excluded_meme_packages: z.array(packageIdSchema).max(1000),
}).refine((profile) => new Set([
  profile.launchpad_original_package, profile.presale_original_package,
  profile.vault_original_package, profile.core_original_package, profile.admin_original_package,
]).size === 5);

export function parseProfile(value: unknown): Profile {
  const parsed = defillamaProfileSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid DefiLlama profile");
  return {
    ...parsed.data,
    excluded_meme_packages: [...new Set(parsed.data.excluded_meme_packages)].sort(),
  };
}

/** Historical release evidence. An empty receiver list explicitly marks fees disabled. */
export function parseFrontendFeeHistory(value: unknown): FrontendFeePolicy[] {
  return frontendFeeHistorySchema.parse(value).map((window) => ({
    ...window,
    receivers: [...new Set(window.receivers)].sort(),
    cetus_packages: [...new Set(window.cetus_packages)].sort(),
  }));
}

/** An existing report feed can keep its identity when the same lineage uses a newer SDK manifest. */
export function assertPublishedProfile(profile: Profile, source: ExpectedDeployment | null = null): void {
  const manifest = BLAST_DEPLOYMENTS[profile.network];
  if (!manifest || (source && source.network !== profile.network) ||
    deploymentFingerprint(manifest) !== (source?.deployment ?? profile.deployment_fingerprint) ||
    manifest.packages.launchpad.originalPackageId !== profile.launchpad_original_package ||
    manifest.packages.presale.originalPackageId !== profile.presale_original_package ||
    manifest.packages.vault.originalPackageId !== profile.vault_original_package ||
    manifest.packages.core.originalPackageId !== profile.core_original_package ||
    manifest.packages.admin.originalPackageId !== profile.admin_original_package) {
    throw new Error("DefiLlama profile does not match the published deployment");
  }
}
