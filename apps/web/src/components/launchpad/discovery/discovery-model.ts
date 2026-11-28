import { coinDisplay } from "#web/components/social/coins/coin-display.ts";
import { bpsPercent } from "@blast/core/lib/bps.ts";
import { createQuoteOf } from "@blast/core/web/contracts/create.ts";
import { atomsGrouped, NO_VALUE } from "@blast/core/web/format.ts";
import { amtExact, atLeastPow10, exactAtoms, qtyExact } from "@blast/core/web/exact-amount.ts";
import type { Section } from "@blast/core/modules/launchpad-contract/section.ts";
import type {
  DiscoveryPageData,
  DiscoveryRow,
  DiscoveryViewName,
} from "@blast/core/modules/launchpad-discovery/rows.ts";
import { ageSectionState, mapSectionState, refreshFailed, type SectionState } from "../primitives/data-state.ts";

/**
 * The discovery rail's state and wording, browser-safe and pure. A view's
 * list is a SectionState of the pages read so far; an outage keeps listed
 * facts as Stale and never empties or zeroes them.
 */

export type ViewList = DiscoveryPageData;

/** Launches per page in the rail. */
export const RAIL_PAGE_SIZE = 10;

/** The least progress a curve needs to be listed as almost graduated: 60%. */
export { ALMOST_GRADUATED_BPS } from "@blast/core/modules/launchpad-discovery/rows.ts";

/**
 * The discovery resource's URL for a page of `view` after `cursor` (null: the first page).
 * Almost graduated reads the bonding catalog by progress, highest first: the
 * `near_graduation` view orders by raw quote left, which mixes coins and targets.
 */
export function discoveryPageUrl(
  view: DiscoveryViewName,
  cursor: string | null,
  limit = RAIL_PAGE_SIZE,
): string {
  const query = new URLSearchParams(
    view === "near_graduation" ? { catalog: "bonding", sort: "progress", q: "", limit: String(limit) } : { view, limit: String(limit) },
  );
  if (cursor) query.set("cursor", cursor);
  return `/api/launchpad/discovery?${query}`;
}

/** Loaded rows older than this are shown Stale until a refresh succeeds. */
export const RAIL_MAX_AGE_MS = 60_000;

/**
 * The view as shown at `now`: ready facts observed more than
 * `RAIL_MAX_AGE_MS` ago are Stale (T-010 aging). `now` 0 means the browser
 * clock is not running yet (server render), so nothing is aged.
 */
export function railDisplayState(state: SectionState<ViewList>, now: number): SectionState<ViewList> {
  return now === 0 ? state : ageSectionState(state, now, RAIL_MAX_AGE_MS);
}

/** What each view lists, how it orders, and what an empty view says. Hot is deliberately absent. */
export const VIEW_INFO: Readonly<Record<DiscoveryViewName, Readonly<{ label: string; order: string; empty: string }>>> = {
  new: {
    label: "New",
    order: "Newest launch first, by creation checkpoint.",
    empty: "No Blast launch has been created yet.",
  },
  near_graduation: {
    label: "Near graduation",
    order: "Highest progress first. Live and graduating launches at 60% or more.",
    empty: "No Blast launch is near graduation right now.",
  },
  graduated: {
    label: "Graduated",
    order: "Most recent graduation first.",
    empty: "No Blast launch has graduated yet.",
  },
};

const REASONS: Readonly<Record<string, string>> = {
  unreachable: "the indexer did not answer",
  not_ready: "the indexer is starting",
  no_checkpoint: "the indexer has not committed a checkpoint yet",
  lagging: "the indexer is behind the chain",
  "contract-violation": "the answer did not pass validation",
  "provenance-invalid": "the answer did not name its source",
  "network-mismatch": "the indexer serves another network",
  "deployment-mismatch": "the indexer serves another deployment",
  unconfigured: "market data is not configured",
  request: "the request did not complete",
};

/** A degraded read's reason in words. */
export function describeReason(reason: string): string {
  return REASONS[reason] ?? `the indexer answered ${reason}`;
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A served page: a discovery view's (which names its view), or a wallet's launches (the same rows). */
type PageResponse = Readonly<{ section: Section<ViewList>; view?: DiscoveryViewName }>;

function pageState(response: PageResponse | null) {
  return response === null
    ? { status: "unavailable" as const, reason: describeReason("request") }
    : mapSectionState(response.section, describeReason, sentence);
}

/** The view after reading its first page; `null` is a request that did not complete. */
export function afterFirstPage(previous: SectionState<ViewList>, response: PageResponse | null): SectionState<ViewList> {
  const next = pageState(response);
  if (next.status !== "unavailable") return next;

  const hasFacts = previous.status === "ready" || previous.status === "stale";
  return refreshFailed(previous, hasFacts ? `Refresh failed: ${next.reason}` : next.reason);
}

/**
 * The view after reading the page after its last row. Rows append in the
 * served order; a launch already listed is not listed twice (Near
 * graduation's later pages follow the order as it stands then).
 */
export function afterNextPage(previous: SectionState<ViewList>, response: PageResponse | null): SectionState<ViewList> {
  if (previous.status !== "ready" && previous.status !== "stale") return afterFirstPage(previous, response);
  const next = pageState(response);
  if (next.status === "unavailable") return refreshFailed(previous, `More launches could not be loaded: ${next.reason}`);
  if (next.status === "empty") return { ...previous, value: { ...previous.value, nextCursor: null } };
  const listed = new Set(previous.value.rows.map((row) => row.launchId));
  const value = {
    rows: [...previous.value.rows, ...next.value.rows.filter((row) => !listed.has(row.launchId))],
    nextCursor: next.value.nextCursor,
  };
  return next.status === "stale" ? { ...next, value } : { ...previous, value };
}

/** The quote coin's symbol from its type, such as `SUI`. */
export function quoteSymbol(quoteType: string): string {
  const symbol = quoteType.split("::").at(-1) ?? quoteType;
  return coinDisplay(quoteType, symbol, symbol).symbol;
}

/** Format only when the scale is known from the row or the quote registry. */
export function formatQuoteAmount(atomic: string, decimals: number | null, quoteType?: string): string {
  const scale = decimals ?? (quoteType && createQuoteOf(quoteType)?.decimals);
  return typeof scale === "number" ? atomsGrouped(atomic, scale) : NO_VALUE;
}

/**
 * A quote amount short enough for a narrow row ("5,000", "25.11", "0.000000007"): whole amounts round to the
 * quantity scale, small ones keep their first digits, and the exact figure stays with the caller (audit, Bonding).
 */
export function compactQuoteAmount(atomic: string, decimals: number | null, quoteType?: string): string {
  const scale = decimals ?? (quoteType && createQuoteOf(quoteType)?.decimals);
  const amount = typeof scale === "number" ? exactAtoms(atomic, scale) : null;
  if (!amount) return NO_VALUE;
  return atLeastPow10(amount, 0) ? qtyExact(amount) : amtExact(amount);
}

/** Absolute UTC to the second, so the server and the browser render the same text. */
export function formatUtc(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

export const LIFECYCLE_LABELS: Readonly<Record<DiscoveryRow["lifecycle"], string>> = {
  opening_round: "Opening round",
  live: "Live",
  migration_ready: "Graduating",
  migrated: "Graduated",
};

/** The fact a row's view orders it by, in words. */
export function orderFact(view: DiscoveryViewName, row: DiscoveryRow): string {
  switch (view) {
    case "new":
      return `Created ${formatUtc(row.createdAtMs)}`;
    case "near_graduation":
      if (row.quoteRemaining === null || row.progressBps === null) return "Progress unavailable";
      return `${formatQuoteAmount(row.quoteRemaining, row.quoteDecimals, row.quoteType)} ${quoteSymbol(row.quoteType)} to graduate · ${bpsPercent(row.progressBps)}`;
    case "graduated":
      return row.graduatedAtMs === null ? "Graduation time unavailable" : `Graduated ${formatUtc(row.graduatedAtMs)}`;
  }
}
