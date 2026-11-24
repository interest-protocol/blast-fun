import type { AllocationPlan, LaunchEconomics } from "@interest-protocol/blast-sdk/launchpad";
import type { FeeSplit } from "@interest-protocol/blast-sdk";
import type { CoinSummary, PoolStats, VenuePool } from "@blast/core/modules/launchpad-contract/coin.ts";
import type { LaunchLifecycle, LaunchSummary } from "@blast/core/modules/launchpad-contract/discovery.ts";
import type { Section } from "@blast/core/modules/launchpad-contract/section.ts";
import type { FreshLaunch } from "./fresh-types.ts";
import type { ExecutionAvailability } from "./availability.ts";


/**
 * The launch-backed coin page read is keyed internally by launch ID. The
 * curve pool `/v1/pools/blast_curve/{launch_id}` names the coin, whose
 * `/v1/coins/{coin_type}` summary (and, after migration, the venue pool's
 * summary) complete the indexed facts. Every indexed section is blast-infra's
 * answer with its provenance, Stale when blast-infra lags, and, when
 * blast-infra cannot answer, Stale from the last answer this process saw or
 * else Unavailable. Nothing is recomputed from SQL.
 *
 * The launch object, read fresh from the node through the SDK, decides
 * transaction eligibility and whether an ID blast-infra does not know is a
 * launch at all. The page is not found only when blast-infra denies the ID
 * and the node does not show it as a launch of this deployment, or when the
 * node shows the ID is not one.
 */

/**
 * The launch's curve pool: identity, lifecycle, settings and launch facts,
 * its own activity, the snapshotted allocation plan and LP-fee split, and
 * what the SDK derives from them: the starting economics (null when the
 * settings cannot have any) and progress toward graduation.
 */
export type CurveRead = Readonly<{
  launch: LaunchSummary;
  stats: PoolStats;
  plan: AllocationPlan;
  split: FeeSplit;
  economics: LaunchEconomics | null;
  progressBps: bigint | null;
}>;


/**
 * Which pool the page's market, chart and trading read: the curve until the
 * launch migrated, then the recorded route's venue pool (`poolKey` null when
 * no venue pool is known).
 */
export type SelectedSource =
  | Readonly<{ kind: "curve"; poolKey: string }>
  | Readonly<{ kind: "venue"; venue: string; poolKey: string | null }>;


/** blast-infra's lifecycle and the launch object's, when they disagree. */
export type LifecycleConflict = Readonly<{ indexed: LaunchLifecycle; fresh: LaunchLifecycle }>;


export type CoinPage = Readonly<{
  launchId: string;
  /** The curve's indexed record, kept after migration as the launch's history. */
  curve: Section<CurveRead>;
  coin: Section<CoinSummary>;
  /** The venue pool; null before migration. */
  venue: Section<VenuePool> | null;
  fresh: FreshLaunch;
  /** The creator wallet’s default SuiNS name, when resolved for the page. */
  creatorName?: string;
  /**
   * blast-infra (now or in its remembered answer) or the node confirms the ID
   * is a launch. When neither can, the page is `noindex` and names no source
   * or lifecycle: it cannot tell a launch from an unknown ID.
   */
  confirmed: boolean;
  source: SelectedSource;
  conflict: LifecycleConflict | null;
  availability: ExecutionAvailability;
  /** The page shows the coin as tradable: the first tradable view counts. */
  tradable: boolean;
}>;


export function launchCoinType(page: CoinPage): string | null {
  const curve = page.curve;
  if (curve.state === "available" || curve.state === "stale") return curve.data.launch.coinType;
  return page.fresh.status === "read" ? page.fresh.launch.memeType : null;
}

export function coinCreatorAddress(page: CoinPage): string | null {
  const indexed = page.coin.state === "available" || page.coin.state === "stale" ? page.coin.data : null;
  const recipient = page.fresh.status === "read" ? page.fresh.launch.creatorRecipient : null;
  return indexed?.creator ?? (recipient?.kind === "address" ? recipient.address : indexed?.launcher ?? null);
}

export type CoinPageRead = Readonly<{ kind: "not-found" }> | Readonly<{ kind: "coin"; page: CoinPage }>;


/** The adapter module of a recorded `…::<venue>::Venue`, or null. */
export function witnessVenue(witness: string): string | null {
  return /::([A-Za-z_][A-Za-z0-9_]*)::Venue$/.exec(witness)?.[1] ?? null;
}


/**
 * How often the browser re-reads the page: every 5 s while blast-infra and
 * the launch object disagree, every 10 s while an indexed section is Stale or
 * Unavailable, and every 30 s otherwise.
 */
export function refreshIntervalMs(page: CoinPage): number {
  if (page.conflict) return 5_000;
  const sections = [page.curve, page.coin, ...(page.venue ? [page.venue] : [])];
  return sections.some((section) => section.state === "stale" || section.state === "unavailable") ? 10_000 : 30_000;
}
