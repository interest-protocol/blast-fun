/**
 * The v1 projection applies at the backend and web partner boundaries.
 * Shared owners also serve the web's first-party
 * reads with every field. The social presale routes have grown fields the published partner contract does not
 * carry (docs.blast.fun `partner-api-v1.json`, pinned in
 * `apps/web/scripts/partner-api-live/contract.json`), and v1 is closed to them
 * (`additionalProperties: false`), so each read answers the shared one less those fields:
 *
 * - the list page: `status_counts` (the redesign's tab counts);
 * - every sale: `coin_type` (the frontend canonical artwork identity);
 * - each detail activity row's `presale`: also `verified_team` (the Known deployer badge);
 * - every list and featured summary: `backers_sample` (the redesign's facepile);
 * - the detail's `terms`: `launch_fdv_quote` (the launch FDV in the raise coin) and `trading_fee_ppm`
 *   (the migration pool's fee), and the web's public and eligible-wallet buying windows;
 * - every sale's `metadata.cover` (each summary's, the detail's `presale`): `source` (the size of
 *   the uploaded image);
 * - each USD price history: `price_as_of_ms` (the Swap freshness check);
 * - the Graduated discovery catalog: `legacyMarket` and `legacyFdvUsd` (the website’s V1 pool figures);
 * - each discovery, pool and coin market summary: `fdv_usd` (the website's total-supply valuation).
 *
 * One published field also keeps its v1 form: each detail activity row's `amounts.usd` is rounded
 * to cents (`FeedItemUsd`), while the first-party feed carries it unrounded so dust prices stay real.
 *
 * A new field reaches partners only with a new published contract, its pin and this adapter
 * together. Any other answer (an error, a refusal) passes through unchanged.
 */

import { toUsd } from "@blast/core/modules/social/items/decimal.ts";

import { partnerEndpointBucket, type PartnerV1Read } from "./paths.ts";

/** Fields of the shared reads that v1 does not publish. */
export const V1_UNPUBLISHED = Object.freeze({
  page: Object.freeze(["status_counts"]),
  summary: Object.freeze(["backers_sample", "coin_type"]),
  identity: Object.freeze(["coin_type"]),
  activity: Object.freeze(["coin_type", "verified_team"]),
  terms: Object.freeze(["launch_fdv_quote", "trading_fee_ppm", "public_buy", "eligible_uncapped_from_ms"]),
  cover: Object.freeze(["source"]),
  price: Object.freeze(["price_as_of_ms"]),
  market: Object.freeze(["fdv_usd"]),
  discovery: Object.freeze(["legacyMarket", "legacyFdvUsd"]),
});

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function without(value: unknown, fields: readonly string[]): unknown {
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)));
}

/** A sale (a summary, the detail's `presale`) with its cover less what v1 does not publish. */
function v1Sale(sale: unknown): unknown {
  if (!isObject(sale) || !isObject(sale.metadata) || !isObject(sale.metadata.cover)) return sale;
  return { ...sale, metadata: { ...sale.metadata, cover: without(sale.metadata.cover, V1_UNPUBLISHED.cover) } };
}

/** A list page or the featured answer: the page and each summary less what v1 does not publish. */
export function v1PresaleSummaries(body: unknown): unknown {
  if (!isObject(body) || !Array.isArray(body.presales)) return body;
  const page = without(body, V1_UNPUBLISHED.page) as Json;
  return { ...page, presales: body.presales.map((summary) => v1Sale(without(summary, V1_UNPUBLISHED.summary))) };
}

/** An activity row's amounts with `usd` in its published v1 form, cents (`FeedItemUsd`). */
function v1Amounts(amounts: unknown): unknown {
  if (!isObject(amounts) || typeof amounts.usd !== "string") return amounts;
  return { ...amounts, usd: toUsd(amounts.usd) };
}

/** A detail activity row less what v1 does not publish, its USD in cents. */
function v1Activity(item: unknown): unknown {
  if (!isObject(item)) return item;
  const presale = isObject(item.presale) ? { presale: without(item.presale, V1_UNPUBLISHED.activity) } : {};
  const amounts = "amounts" in item ? { amounts: v1Amounts(item.amounts) } : {};
  return { ...item, ...presale, ...amounts };
}

/** The detail: its sale, its terms and its activity less what v1 does not publish. */
export function v1PresaleDetail(body: unknown): unknown {
  if (!isObject(body)) return body;
  const terms = isObject(body.terms) ? without(body.terms, V1_UNPUBLISHED.terms) : body.terms;
  const activity = Array.isArray(body.activity) ? body.activity.map(v1Activity) : null;
  return { ...body, presale: v1Sale(without(body.presale, V1_UNPUBLISHED.identity)), terms, ...(activity ? { activity } : {}) };
}

/** Keep the published v1 price history shape. OHLCV answers pass through. */
export function v1Prices(body: unknown): unknown {
  if (!isObject(body) || !Array.isArray(body.prices)) return body;
  return { ...body, prices: body.prices.map((price) => without(price, V1_UNPUBLISHED.price)) };
}

function v1MarketSummary(body: unknown): unknown {
  if (!isObject(body) || !("market" in body)) return body;
  return { ...body, market: without(body.market, V1_UNPUBLISHED.market) };
}

function v1Discovery(body: unknown): unknown {
  if (!isObject(body)) return body;
  const published = without(body, V1_UNPUBLISHED.discovery) as Json;
  if (!isObject(body.metrics)) return published;
  const metrics = Object.fromEntries(
    Object.entries(body.metrics).map(([launch, summary]) => [launch, v1MarketSummary(summary)]),
  );
  return { ...published, metrics };
}

function v1Pool(body: unknown): unknown {
  if (!isObject(body) || !("pool" in body)) return body;
  return { ...body, pool: v1MarketSummary(body.pool) };
}

/** `response` with its JSON body projected by `project` when it is a 200, else as it is. */
export async function projectedResponse(response: Response, project: (body: unknown) => unknown): Promise<Response> {
  if (response.status !== 200 || !(response.headers.get("content-type") ?? "").includes("application/json")) return response;
  const body = project(await response.json());
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(body), { status: response.status, headers });
}

/** The projection of this partner read's answer, or null for a read v1 publishes as it is. */
export function v1Projection(name: PartnerV1Read, path: string): ((body: unknown) => unknown) | null {
  if (name === "presales" || name === "featured") return v1PresaleSummaries;
  if (name === "presale") return v1PresaleDetail;
  if (name === "prices") return v1Prices;
  if (name === "discovery") return v1Discovery;
  if (name === "market") {
    switch (partnerEndpointBucket(path)) {
      case "launchpad_market_coin": return v1MarketSummary;
      case "launchpad_market_pool": return v1Pool;
    }
  }
  return null;
}
