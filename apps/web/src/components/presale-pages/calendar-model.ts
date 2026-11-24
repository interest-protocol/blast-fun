import { exactAtoms, groupedExact } from "@blast/core/web/exact-amount.ts";
import type { SocialPresaleSummary } from "@blast/core/web/contracts/presales.ts";

export type CalendarRange = "upcoming" | "past" | "all";
export type CalendarEvent = Readonly<{ sale: SocialPresaleSummary; kind: "opening" | "closing"; at: number }>;
export const CALENDAR_RANGES = [["upcoming", "Upcoming"], ["past", "Past"], ["all", "All"]] as const;
export const DAY_MS = 86_400_000;
export const utcDayStartMs = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;

export function calendarEvents(sales: readonly SocialPresaleSummary[]): CalendarEvent[] {
  const unique = new Map(sales.map((sale) => [sale.presale_id, sale]));
  return [...unique.values()].flatMap((sale) => [
    { sale, kind: "opening" as const, at: sale.start_ms },
    { sale, kind: "closing" as const, at: sale.end_ms },
  ]).filter(({ at }) => Number.isFinite(at) && at > 0)
    .sort((a, b) => a.at - b.at || a.sale.presale_id.localeCompare(b.sale.presale_id) || a.kind.localeCompare(b.kind));
}

export function eventsInRange(events: readonly CalendarEvent[], range: CalendarRange, now: number) {
  return events.filter(({ at }) => range === "all" || (range === "past" ? at < now : at >= now));
}

const monthLabel = new Intl.DateTimeFormat("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });

export function calendarHeading(events: readonly CalendarEvent[]): string {
  if (!events.length) return "Schedule";
  const month = (at: number) => monthLabel.format(at).replace(/ (\d{2})$/, " ’$1");
  const first = month(events[0].at);
  const last = month(events[events.length - 1].at);
  return first === last ? first : `${first} – ${last}`;
}

export function calendarDate(day: number, now: number): string {
  const date = new Date(day).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  return day === utcDayStartMs(now) + DAY_MS ? `Tomorrow · ${date}` : date;
}

export function calendarTarget(sale: SocialPresaleSummary): string {
  const amount = exactAtoms(sale.target_atoms, sale.quote_decimals);
  if (!amount) return "Unavailable";
  const value = groupedExact(amount, amount.scale);
  return `${value} ${sale.quote_symbol}`;
}
