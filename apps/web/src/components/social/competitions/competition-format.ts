import { timeLeft } from "@blast/core/web/format.ts";
import type { Competition } from "@blast/core/modules/social/competitions/contracts.ts";

const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export type CompetitionStatus = "Scheduled" | "Live" | "Ended";

export function competitionStatus(competition: Pick<Competition, "starts_at_ms" | "ends_at_ms">, nowMs: number): CompetitionStatus {
  return nowMs < competition.starts_at_ms ? "Scheduled" : nowMs < competition.ends_at_ms ? "Live" : "Ended";
}

/** The board's second chip: `Ends in 3d 6h` while live, `Starts in 2d 4h` before, `Ended 19 Oct` after (UTC). */
export function competitionWhen(competition: Pick<Competition, "starts_at_ms" | "ends_at_ms">, nowMs: number): string {
  const status = competitionStatus(competition, nowMs);
  if (status === "Scheduled") return `Starts in ${timeLeft(competition.starts_at_ms - nowMs)}`;
  if (status === "Live") return `Ends in ${timeLeft(competition.ends_at_ms - nowMs)}`;
  return `Ended ${day.format(competition.ends_at_ms)}`;
}
