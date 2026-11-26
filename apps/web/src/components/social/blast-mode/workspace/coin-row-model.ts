import { isValidStructTag, normalizeStructTag } from "@mysten/sui/utils";
import type { HomeCoin, HomeQuery, HomeSort } from "@blast/core/web/contracts/home.ts";
import { discoverQueryOf, type HomeViewState } from "../../coin-home/home-state";
import type { useWorkspace } from "./workspace-context";
import type { DataControls } from "@blast/core/modules/social/blast-workspace/setup.ts";

type Snapshot = ReturnType<typeof useWorkspace>["snapshot"];

/** The canonical coin type a panel is keyed by, or null for a type the workspace cannot open. */
export function canonicalCoinType(coinType: string): string | null {
  return isValidStructTag(coinType) ? normalizeStructTag(coinType) : null;
}

/** Whether a visible panel already shows this asset. */
export function assetOnScreen(
  snapshot: Snapshot,
  coinType: string | null,
  network: string = "mainnet",
): boolean {
  return (
    coinType !== null &&
    snapshot.visible_order.some((id) => {
      const panel = snapshot.panels[id];
      return panel?.chain === "sui" && panel.network === network && panel.coin_type === coinType;
    })
  );
}

/**
 * Where the curated ecosystem coins (`CORE_COINS`) join a Trending or New
 * page, as an index into its `count` coins, or null when they belong on
 * another page. They have no window activity, so on Trending they follow
 * the `ranked` Blast coins that have some (the server's count, which leads
 * its order) and precede the rest; a page without `ranked` places none. On
 * New they follow every Blast coin, with or without a launch time. When the
 * coins before them fill every page exactly, they end the last page.
 */
export function ecosystemSlot(
  sort: HomeSort,
  read: Readonly<{ page: number; total: number; ranked?: number }>,
  limit: number,
  count: number,
): number | null {
  const before = sort === "trending" ? read.ranked : sort === "newest" ? read.total : undefined;
  if (before === undefined) return null;
  const last = Math.max(1, Math.ceil(read.total / limit));
  const page = Math.min(Math.floor(before / limit) + 1, last);
  return read.page === page ? Math.min(before - (page - 1) * limit, count) : null;
}

/** Blast mode's saved Coins controls as Home's view state: every stage, the saved filters. */
export function workspaceViewState(controls: DataControls["Coins"]): HomeViewState {
  return { ...controls, stage: "all", minParticipants: controls.min_participants, knownDeployer: controls.known_deployer === true };
}

/**
 * Blast mode Discover's read. Trending also asks for `ranked` (`ecosystemSlot`); the collapsed rail reads the same query, so both share one cache entry.
 * Presales not trading yet stay out: Blast mode lists them in its own Presales panel.
 */
export function workspaceDiscoverQuery(state: HomeViewState, rows: number): HomeQuery {
  const query: HomeQuery = { ...discoverQueryOf(state, rows), presales: false };
  return query.sort === "trending" ? { ...query, ranked: true } : query;
}

/** Raised over target as a whole percentage, floored; a nonzero raise under 1% reads `<1%`, never `0%`. */
export function fundedShare(
  sale: Readonly<{ raised: string; raise_target: string }>,
): Readonly<{ text: string; ratio: number }> | null {
  try {
    const raised = BigInt(sale.raised);
    const target = BigInt(sale.raise_target);
    if (target <= 0n || raised < 0n) return null;
    const pct = (raised * 100n) / target;
    return {
      text: raised > 0n && pct === 0n ? "<1%" : `${pct}%`,
      ratio: Number((raised * 10_000n) / target) / 10_000,
    };
  } catch {
    return null;
  }
}

/** Reuse the list's existing placement and lifecycle handling for compact shortcuts. */
export function addDiscoveryAsset(
  dispatch: ReturnType<typeof useWorkspace>["dispatch"],
  coin: Pick<HomeCoin, "coin_type" | "presale_id" | "lifecycle">,
) {
  const id = dispatch.add({
    panel_id: crypto.randomUUID(),
    chain: "sui",
    network: "mainnet",
    coin_type: coin.coin_type,
    presale_id: coin.presale_id,
  });
  if (coin.lifecycle === "migrated")
    dispatch.patchPanel(id, { active_namespace: "coin" });
}
