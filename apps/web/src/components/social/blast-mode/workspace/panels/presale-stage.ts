import type { SocialPresaleSummary } from "@blast/core/web/contracts/presales.ts";

/** Indexed phase is authoritative; time only distinguishes upcoming and ended open sales. */
export function presaleStage(sale: SocialPresaleSummary, now = Date.now()) {
  switch (sale.phase) {
    case "pending":
      return {
        label: "Upcoming",
        action: "View presale",
        message: "The presale has not opened. Commitments are unavailable.",
      };
    case "open":
      if (sale.start_ms > now)
        return {
          label: "Upcoming",
          action: "View presale",
          message: "Commitments open at the scheduled start.",
        };
      if (sale.end_ms <= now)
        return {
          label: "Ended",
          action: "View outcome",
          message: "Commitments have ended. Awaiting the confirmed outcome.",
        };
      return {
        label: "Live",
        action: "Join presale",
        message:
          "Commitments open.",
      };
    case "closed":
      return {
        label: "Ended",
        action: "View outcome",
        message: "Commitments are closed. Awaiting the confirmed outcome.",
      };
    case "funded":
      return {
        label: "Funded",
        action: "View position",
        message: "Funding completed. Trading and claims await launch.",
      };
    case "trading":
      return {
        label: "Trading",
        action: "View trading",
        message:
          "Trading.",
      };
    case "cancelled":
      return {
        label: "Cancelled",
        action: "View refund",
        message:
          "Cancelled · refunds available.",
      };
  }
}

/** Whole time left at minute precision: `2d 6h`, `4h 12m`, `12m`, `under 1m`. */
export function untilText(ms: number) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days >= 1) return `${days}d ${hours}h`;
  if (hours >= 1) return `${hours}h ${minutes % 60}m`;
  return minutes >= 1 ? `${minutes}m` : "under 1m";
}

/**
 * The panel header's stage line: the phase, then what happens next, e.g.
 * `Presale` · `closes in 4h 12m`. Trading is drawn by the venue line instead.
 */
export function presaleStageLine(sale: SocialPresaleSummary, now = Date.now()) {
  const stage = presaleStage(sale, now);
  switch (stage.label) {
    case "Live":
      return { lead: "Presale", next: `closes in ${untilText(sale.end_ms - now)}` };
    case "Upcoming":
      return { lead: "Upcoming", next: sale.start_ms > now ? `opens in ${untilText(sale.start_ms - now)}` : "not open yet" };
    case "Ended":
      return { lead: "Ended", next: "awaiting the outcome" };
    case "Funded":
      return { lead: "Funded", next: "claims open at launch" };
    case "Cancelled":
      return { lead: "Cancelled", next: "refunds open" };
  }
  // Trading: the venue line says where.
  return { lead: stage.label, next: null };
}

/** Funded share of the target as the ring states it: floored below 100, `<1%` rather than a nonzero `0%`. */
export function fundedText(fillBps: number) {
  if (!Number.isFinite(fillBps) || fillBps <= 0) return "0%";
  if (fillBps < 100) return "<1%";
  return `${fillBps < 10_000 ? Math.floor(fillBps / 100) : Math.round(fillBps / 100)}%`;
}
