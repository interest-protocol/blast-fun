import type { SocialPresaleSummary } from "@blast/core/web/contracts/presales.ts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { PresaleListView } from "./discovery-state";

/** The featured card is page-level: every list tab and scope shows it, so the tabs never move. */
export function featuredVisible(view: PresaleListView): boolean {
  return view === "list";
}

/** Mix upcoming and open sales. A cached open sale stops appearing at its closing time. */
export function eligibleFeatured(sales: readonly SocialPresaleSummary[], nowMs: number): readonly SocialPresaleSummary[] {
  const seen = new Set<string>();
  return sales.filter((sale) => {
    const shown = sale.phase === "pending" || (sale.phase === "open" && sale.end_ms > nowMs);
    if (!shown || seen.has(sale.presale_id)) return false;
    seen.add(sale.presale_id);
    return true;
  });
}

export function shuffleFeatured(sales: readonly SocialPresaleSummary[], seed: string): readonly SocialPresaleSummary[] {
  return shuffleFeaturedBy(sales, seed, (sale) => sale.presale_id);
}

/** Rank each slide independently so refetches and membership changes leave the remaining order steady. */
export function shuffleFeaturedBy<T>(slides: readonly T[], seed: string, idOf: (slide: T) => string): readonly T[] {
  if (slides.length < 2) return slides;
  return slides
    .map((slide) => ({ slide, rank: bytesToHex(sha256(utf8ToBytes(`${seed}:${idOf(slide)}`))) }))
    .sort((a, b) => a.rank.localeCompare(b.rank, "en-US"))
    .map(({ slide }) => slide);
}
