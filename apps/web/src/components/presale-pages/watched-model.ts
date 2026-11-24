

import type { PresaleListStatus, SocialPresaleSummary } from "@blast/core/web/contracts/presales.ts";

/**
 * The presale pages with the watchlist (UI-12, OA-11) wired in: the sale
 * page's star (§10.2) and the list's "Watchlist" chip (§9). The server
 * renders them like the plain pages (the star off, the same for every
 * reader); the viewer's stars arrive after hydration.
 */

/** Whether a starred sale belongs to a status tab. */
export function inStatus(sale: Pick<SocialPresaleSummary, "phase">, status: PresaleListStatus): boolean {
  if (status === "live") return sale.phase === "open";
  if (status === "upcoming") return sale.phase === "pending";
  return sale.phase !== "open" && sale.phase !== "pending";
}

/** Personal results use the same summary fields and tie direction as the public ranking. */
export function orderWatched(rows: readonly SocialPresaleSummary[], sort: string): readonly SocialPresaleSummary[] {
  const key = (sale: SocialPresaleSummary) => {
    switch (sort) {
      case "backed": return sale.participants;
      case "opening": return sale.start_ms;
      case "interest": return sale.interested;
      case "recent": return sale.ended_ms ?? sale.launched_ms ?? sale.end_ms;
      case "best": return Number(sale.multiple ?? -1);
      default: return sale.end_ms;
    }
  };
  const direction = sort === "ending" || sort === "opening" ? 1 : -1;
  return [...rows].sort((a, b) => direction * (key(a) - key(b) || (a.presale_id < b.presale_id ? -1 : a.presale_id > b.presale_id ? 1 : 0)));
}
