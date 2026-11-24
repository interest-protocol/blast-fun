import { launchCoinType } from "@blast/core/modules/launchpad-coin/contracts.ts";
import { shortAddress as shortId } from "@blast/core/lib/format.ts";
import type { Destination } from "@interest-protocol/blast-sdk";
import type { AllocationPlan } from "@interest-protocol/blast-sdk/launchpad";

import { createQuoteOf } from "@blast/core/web/contracts/create.ts";
import { coinDisplay } from "#web/components/social/coins/coin-display.ts";
// How the coin page names its states, sources and reasons. The section
// mapping keeps every indexed fact with its own provenance; nothing here
// computes a market value.

import { LIFECYCLE_FROM_SDK } from "@blast/core/modules/launchpad-coin/availability.ts";
import type { CoinPage } from "@blast/core/modules/launchpad-coin/contracts.ts";
import type { LaunchLifecycle, LaunchMigration } from "@blast/core/modules/launchpad-contract/discovery.ts";
import type { Section } from "@blast/core/modules/launchpad-contract/section.ts";

import { formatPricePerToken } from "./coin-format.ts";

import { mapSectionState, type SectionState } from "../primitives/data-state";

export const LIFECYCLE_LABEL: Readonly<Record<LaunchLifecycle, string>> = {
  opening_round: "Opening round",
  live: "Live",
  migration_ready: "Migration ready",
  migrated: "Migrated",
};

/** Why blast-infra could not answer, as the end of a sentence. */
const REASONS: Readonly<Record<string, string>> = {
  unreachable: "blast-infra did not respond",
  not_ready: "blast-infra is starting or catching up",
  lagging: "blast-infra is behind the chain",
  "contract-violation": "blast-infra's answer did not match the contract",
  "provenance-invalid": "blast-infra's answer had no valid provenance",
  "network-mismatch": "blast-infra indexes another Sui network",
  "deployment-mismatch": "blast-infra indexes another Blast deployment",
  no_checkpoint: "blast-infra has not applied a checkpoint yet",
  "status-unavailable": "blast-infra's status could not be read",
  not_found: "blast-infra has not indexed this launch yet",
  unconfigured: "this app has no blast-infra origin configured",
  "coin type unknown": "the coin type is not known yet",
  "no venue pool recorded": "no venue pool is recorded for the migration",
  "route-mismatch": "blast-infra's answer named another migration than this launch's",
};

/** A reason code in words; a reason that is already a sentence stays, without its final period. */
export function describeReason(reason: string): string {
  if (REASONS[reason]) return REASONS[reason];
  return /\s/.test(reason) ? reason.replace(/\.$/, "") : `blast-infra could not answer (${reason})`;
}

export function sectionState<T>(section: Section<T>): SectionState<T> {
  return mapSectionState(section, describeReason, capitalized);
}

function capitalized(text: string): string {
  return text.startsWith("blast-infra") ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

/** The data a section holds now, current or stale. */
export function sectionData<T>(section: Section<T> | null): T | null {
  return section && (section.state === "available" || section.state === "stale") ? section.data : null;
}

/** The launch's venue side, as the chart and Activity both read it. */
export type VenueRoute = Readonly<{
  /** The venue's module name (`bluefin`), from the pool key, else the page's source. */
  venue: string;
  /** The venue pool the committed migration recorded, else the page's venue source; null when none is recorded. */
  poolKey: string | null;
  /** The committed `Migrated` as the curve's summary records it; null when that record is unavailable. */
  migration: LaunchMigration | null;
}>;

/**
 * The one rule for a launch's venue side, so the chart and Activity on one
 * page never disagree: the curve summary's committed migration decides the
 * pool when it is known (even while the coin summary still names the curve),
 * else the page's venue source. Null before migration.
 */
export function venueRoute(page: Pick<CoinPage, "curve" | "source">): VenueRoute | null {
  const migration = sectionData(page.curve)?.launch.migration ?? null;
  const source = page.source.kind === "venue" ? page.source : null;
  if (migration === null && source === null) return null;
  const poolKey = migration ? migration.poolKey : (source?.poolKey ?? null);
  return { venue: poolKey?.split(":")[0] ?? source?.venue ?? "venue", poolKey, migration };
}

/** A Move type's struct name: `0x2::sui::SUI` is `SUI`. */
export function typeSymbol(type: string): string {
  const symbol = type.split("::").at(-1) ?? type;
  return coinDisplay(type, symbol, symbol).symbol;
}

export function feeRouteLabel(destination: Destination): string {
  if (destination.kind === "Address") return shortId(destination.address);
  return { Owner: "Creator", AutoLp: "Added to liquidity", HolderRewards: "Holder rewards", Burn: "Buyback & burn" }[destination.kind];
}

/** The coin's names and units, from the indexed curve or else the launch object. */
export function coinIdentity(page: CoinPage) {
  const curve = sectionData(page.curve);
  const fresh = page.fresh.status === "read" ? page.fresh.launch : null;
  const coinType = launchCoinType(page);
  const quoteType = curve?.launch.quoteType ?? fresh?.quoteType ?? null;
  const coin = sectionData(page.coin);
  return {
    coinType,
    quoteType,
    name: curve?.launch.metadata?.name || null,
    symbol: curve?.launch.metadata?.symbol || (coinType ? typeSymbol(coinType) : "Coin"),
    iconUrl: curve?.launch.metadata?.iconUrl ?? null,
    quoteSymbol: quoteType ? typeSymbol(quoteType) : "Quote",
    memeDecimals: coin?.decimals ?? (curve ? Number(curve.launch.economics.inputs.memeDecimals) : null),
    quoteDecimals:
      coin?.quoteDecimals ??
      (curve?.launch.economics.inputs.quoteDecimals != null ? Number(curve.launch.economics.inputs.quoteDecimals) : null) ??
      (quoteType ? createQuoteOf(quoteType)?.decimals ?? null : null),
  };
}

/** The lifecycle that decides actions (the launch object's), else blast-infra's. */
export function pageLifecycle(page: CoinPage) {
  if (page.fresh.status === "read") return LIFECYCLE_FROM_SDK[page.fresh.launch.lifecycle];
  return sectionData(page.curve)?.launch.lifecycle ?? null;
}

/** The selected source's price, as Quote per whole token to `digits` significant digits; null when it has none yet. */
export function selectedPrice(page: CoinPage, digits?: number): Readonly<{ price: string | null; known: boolean }> {
  const identity = coinIdentity(page);
  const economics =
    page.source.kind === "venue" ? sectionData(page.venue)?.economics : sectionData(page.curve)?.launch.economics;
  if (!economics) return { price: null, known: false };
  const memeDecimals = Number(economics.inputs.memeDecimals);
  const quoteDecimals = economics.inputs.quoteDecimals ?? (identity.quoteDecimals === null ? null : BigInt(identity.quoteDecimals));
  if (economics.price === null || quoteDecimals === null) return { price: null, known: true };
  return {
    price: `${formatPricePerToken(economics.price, memeDecimals, Number(quoteDecimals), digits)} ${identity.quoteSymbol}`,
    known: true,
  };
}


/** Recipient slots are fixed by the sealed plan and can share an address. */
export function allocationRows(plan: AllocationPlan) {
  return plan.recipients.map((recipient, slot) => ({ ...recipient, key: `${recipient.recipient.destination}:${slot}` }));
}

function temporaryMarketFailure(reason: string): boolean {
  return ["unreachable", "not_ready", "lagging", "no_checkpoint", "http_502", "http_503", "http_504"].includes(reason);
}

function temporarySectionFailure(section: CoinPage["coin"] | CoinPage["curve"]): boolean {
  return (section.state === "unavailable" || section.state === "stale") && temporaryMarketFailure(section.reason);
}

/** Both discovery reads are temporarily unavailable, even if last-good data remains. */
export function coinMarketOffline({ coin, curve }: CoinPage): boolean {
  return temporarySectionFailure(coin) && temporarySectionFailure(curve);
}

export function venueMarketCatchingUp(page: CoinPage): boolean {
  const { availability } = page;
  if (availability.kind !== "venue-unavailable" || !availability.route.supported) return false;
  return temporaryMarketFailure(availability.reason) || (
    availability.reason === "no venue pool recorded" && coinMarketOffline(page)
  );
}
