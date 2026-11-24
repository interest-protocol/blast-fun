import { z } from "zod";
import {
  DefillamaError,
  HOUR_SECONDS,
  METRICS,
  METHODOLOGY,
  dayInterval,
  hourStarts,
  type Metric,
} from "./contracts.ts";
import { sumFeeSummaries } from "./daily-fees.ts";
import type { Catalogue, Publication, PublishedDay, ReportingReads, Selector } from "./store.ts";

type Cursor = { snapshot: string; selector: string; after: number; created: number };
export const ENDPOINTS = {
  metadata: "/api/v1/defillama/metadata",
  fees: "/api/v1/defillama/fees",
  metrics: "/api/v1/defillama/metrics",
  contracts: "/api/v1/defillama/contracts",
};

export function createDefillamaRead(reads: () => ReportingReads, now = Date.now) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const operation = url.pathname.split("/").at(-1);
      if (operation === "metadata") {
        requireParameters(url, []);
        return Response.json(metadata(await reads().publications()));
      }
      if (operation === "fees") {
        return await readFees(url, reads, now());
      }
      if (operation !== "metrics" && operation !== "contracts") {
        throw new DefillamaError("not_found", 404);
      }
      const parameter = operation === "metrics" ? "date" : "timestamp";
      requireParameters(url, [parameter, "cursor"]);
      const value = url.searchParams.get(parameter);
      if (value === null) {
        throw new DefillamaError(`missing_${parameter}`);
      }
      const selector = parseSelector(operation, value, now());
      const selectorKey = `${operation}:${value}`;
      const cursor = parseCursor(url.searchParams.get("cursor"), selectorKey);
      const store = reads();
      const publication = await store.publication(selector, cursor?.snapshot);
      const rows = await store.page(
        publication.id,
        operation === "metrics" ? "items" : "contracts",
        cursor?.after ?? -1,
        "timestamp" in selector ? selector.timestamp : undefined,
        cursor?.created ?? -1,
      );
      const page = rows.slice(0, 100);
      const next = nextCursor(rows, publication.id, selectorKey);
      return pageResponse(
        publication,
        selector,
        page.map((row) => row.payload),
        next,
      );
    } catch (error) {
      const known = error instanceof DefillamaError;
      return Response.json(
        { error: { code: known ? error.code : "defillama_unavailable" } },
        {
          status: known ? error.status : 503,
          headers: {
            "Cache-Control": "private, no-store",
            ...(!known ? { "Retry-After": "30" } : {}),
          },
        },
      );
    }
  };
}

async function readHourlyFees(
  url: URL,
  reads: () => ReportingReads,
  now: number,
): Promise<Response> {
  requireParameters(url, ["start_timestamp", "end_timestamp"]);
  const start = feeTimestamp(url, "start_timestamp");
  const end = feeTimestamp(url, "end_timestamp");
  const hours = hourStarts(start, end, now);
  const publications = await reads().feeHours(hours);
  const summaries = hours.map((hour) => {
    const publication = publications.get(hour);
    if (
      !publication?.summary.daily_fees ||
      publication.summary.end_timestamp !== hour + HOUR_SECONDS
    ) {
      throw new DefillamaError("fees_not_published", 404);
    }
    return publication.summary.daily_fees;
  });
  return Response.json({
    start_timestamp: start,
    end_timestamp: end,
    ...(summaries.length === 1 ? summaries[0] : sumFeeSummaries(summaries)),
  });
}

function feeTimestamp(url: URL, key: string): number {
  const value = url.searchParams.get(key);
  if (value === null || !/^(0|[1-9][0-9]{0,9})$/.test(value)) {
    throw new DefillamaError(`invalid_${key}`);
  }
  return Number(value);
}

async function readFees(url: URL, reads: () => ReportingReads, now: number): Promise<Response> {
  if (url.searchParams.has("start_timestamp") || url.searchParams.has("end_timestamp")) {
    return readHourlyFees(url, reads, now);
  }
  requireParameters(url, ["date"]);
  const date = url.searchParams.get("date");
  if (date === null) {
    throw new DefillamaError("missing_date");
  }
  dayInterval(date, now);

  const { id, revision, summary } = await reads().publication({ date });
  if (!summary.daily_fees) {
    throw new DefillamaError("fees_not_published", 404);
  }
  return Response.json({
    date: summary.date,
    snapshot_id: id,
    revision,
    ...summary.daily_fees,
  });
}

function pageResponse(
  publication: Publication,
  selector: Selector,
  items: unknown[],
  next: string | null,
): Response {
  const { summary } = publication;
  return Response.json({
    schema_version: 1,
    chain: "sui",
    network: summary.profile.network,
    deployment_fingerprint: summary.profile.deployment_fingerprint,
    methodology_version: summary.methodology_version,
    policy_version: summary.profile.policy_version,
    snapshot_id: publication.id,
    revision: publication.revision,
    published_at: publication.published_at.toISOString(),
    source: summary.source,
    ...("date" in selector
      ? {
          date: summary.date,
          start_timestamp: summary.start_timestamp,
          end_timestamp: summary.end_timestamp,
          coverage: summary.coverage,
          scope_coverage: summary.scope_coverage,
          frontend_fee_coverage: summary.frontend_fee_coverage,
          frontend_fee_policy: summary.frontend_fee_policy,
        }
      : { timestamp: selector.timestamp }),
    items,
    next_cursor: next,
  });
}

function nextCursor(
  rows: Awaited<ReturnType<ReportingReads["page"]>>,
  snapshot: string,
  selector: string,
): string | null {
  const last = rows[99];
  if (rows.length <= 100 || !last) {
    return null;
  }
  return Buffer.from(
    JSON.stringify({
      snapshot,
      selector,
      after: last.ordinal,
      created: Number(last.created_ms ?? -1),
    } satisfies Cursor),
  ).toString("base64url");
}

function requireParameters(url: URL, allowed: string[]): void {
  for (const key of url.searchParams.keys()) {
    if (!z.enum(allowed).safeParse(key).success || url.searchParams.getAll(key).length !== 1) {
      throw new DefillamaError("invalid_parameters");
    }
  }
}

function parseSelector(operation: "metrics" | "contracts", value: string, now: number): Selector {
  if (operation === "metrics") {
    dayInterval(value, now);
    return { date: value };
  }
  const timestamp = Number(value);
  if (!z.string().regex(/^(0|[1-9][0-9]{0,9})$/).safeParse(value).success || !z.number().int().safeParse(timestamp).success) {
    throw new DefillamaError("invalid_timestamp");
  }
  if (timestamp * 1000 > now) {
    throw new DefillamaError("future_timestamp", 409);
  }
  return { timestamp };
}

function parseCursor(raw: string | null, selector: string): Cursor | null {
  if (raw === null) {
    return null;
  }
  try {
    if (!z.string().regex(/^[A-Za-z0-9_-]{1,512}$/).safeParse(raw).success) {
      throw new Error();
    }
    const decoded: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return z.object({
      selector: z.literal(selector),
      snapshot: z.string().regex(/^[0-9a-f]{64}$/),
      after: z.number().int().min(0).max(1_000_000),
      created: z.number().int().min(-1).max(10_000_000_000_000),
    }).passthrough().parse(decoded) as Cursor;
  } catch {
    throw new DefillamaError("invalid_cursor");
  }
}

function metadata({ latest, days }: Catalogue) {
  if (!latest) {
    throw new DefillamaError("not_published", 404);
  }
  return {
    schema_version: 1,
    chain: "sui",
    network: latest.summary.profile.network,
    deployment_fingerprint: latest.summary.profile.deployment_fingerprint,
    methodology_version: METHODOLOGY,
    policy_version: latest.summary.profile.policy_version,
    endpoints: ENDPOINTS,
    profile: latest.summary.profile,
    latest_publication: new Date(
      Math.max(...days.map((p) => p.published_at.getTime())),
    ).toISOString(),
    page_size: 100,
    latest_completed_date: latest.summary.date,
    metrics_cadence: { seconds: 86400, alignment: "UTC", completed_only: true },
    scope_coverage: latest.summary.scope_coverage,
    contract_discovery: {
      from_timestamp_ms: latest.summary.source.history_start_ms,
      through_timestamp_exclusive: latest.summary.end_timestamp,
    },
    metrics: Object.fromEntries(
      METRICS.map((metric) => [
        metric,
        {
          ...latest.summary.coverage[metric],
          available_ranges: dateRanges(days, metric),
        },
      ]),
    ),
    components: {
      curve_swaps: { included_in_totals: true, accounting_basis: "execution" },
      creation: { included_in_totals: true, accounting_basis: "execution" },
      presale_raise: { included_in_totals: true, accounting_basis: "payment" },
      migration: { included_in_totals: true, accounting_basis: "execution" },
      migration_minted_allocations: {
        included_in_totals: false,
        reason: "token_issuance_not_user_paid_fee",
      },
      presale_minted_allocations: {
        included_in_totals: false,
        reason: "token_issuance_not_user_paid_fee",
      },
      vault_collections: {
        included_in_totals: true,
        accounting_basis: "collection",
        product: "yield",
        underlying_venue_overlap: true,
      },
      migration_residuals: { included_in_totals: false, reason: "unspent_lp_funding_principal" },
      curve_settlements: {
        included_in_totals: false,
        reason: "settlement_of_previously_accrued_fees",
      },
      vault_owner_withdrawals: { included_in_totals: false, reason: "withdrawal_of_previously_recorded_balances" },
      vault_settlements: { included_in_totals: false, reason: "settlement_of_collected_income" },
      frontend_router_fees: {
        included_in_totals: true,
        accounting_basis: "payment",
        underlying_venue_overlap: false,
        coverage: latest.summary.frontend_fee_coverage,
      },
    },
    methodology: {
      fee_scope: "curve_creation_graduation_presale_raise_collected_vault_yield_and_frontend_router_fees",
      amounts: "atomic_decimal_strings",
      token_ids: "unprefixed_normalized_move_types",
      buy_volume: "quote_in",
      sell_volume: "quote_out_gross",
      partner_allocation: "mutable_at_claim_time_blocks_dependent_metrics",
      vault_fees: "collected_position_yield_not_same_day_venue_swap_fees",
      presale_issued_meme: "token_issuance_excluded_from_fees_and_revenue",
      vault_overlap: "separate_yield_adapter_with_underlying_dex_doublecounted_treatment",
      holders_revenue: "no_verified_blast_governance_tokenholder_mechanism",
      tvl: "discovery_only_read_historical_user_quote_custody_onchain_exclude_virtual_reserves_unissued_supply_and_fee_ledgers",
      frontend_router_fees: "settled_cetus_overlay_and_aftermath_output_split_to_reviewed_blast_receiver",
      graduated_volume: "external_venue_volume_excluded",
    },
  };
}

function dateRanges(days: PublishedDay[], metric: Metric): { from: string; through: string }[] {
  const dates = days
    .filter((p) => p.coverage[metric].status === "complete")
    .map((p) => p.date)
    .sort();
  const ranges: { from: string; through: string }[] = [];
  for (const date of dates) {
    const last = ranges.at(-1);
    if (last && Date.parse(date) - Date.parse(last.through) === 86_400_000) {
      last.through = date;
    } else {
      ranges.push({ from: date, through: date });
    }
  }
  return ranges;
}
