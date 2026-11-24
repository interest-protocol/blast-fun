"use client";

import type { ReactNode } from "react";
import { Button, ButtonLink } from "#web/components/blast-ui/Button.tsx";
import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { ChevronIcon } from "#web/components/blast-ui/Icons.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { Segmented } from "#web/components/blast-ui/Segmented.tsx";
import { IntentLink as Link } from "#web/components/blast-ui/NavigationLink.tsx";
import type { SocialPresaleSummary } from "@blast/core/web/contracts/presales.ts";
import { utcTime } from "@blast/core/web/format.ts";
import { ArtworkMark } from "#web/components/blast-ui/ArtworkMark.tsx";
import { cx } from "./cx";
import { PresaleCalendarSkeleton } from "./PresalesSkeleton";
import { CALENDAR_RANGES, DAY_MS, calendarDate, calendarEvents, calendarHeading, calendarTarget, eventsInRange, utcDayStartMs, type CalendarEvent, type CalendarRange } from "./calendar-model";

function CalendarRow({ event, now }: Readonly<{ event: CalendarEvent; now: number }>) {
  const { sale, kind, at } = event;
  const iso = new Date(at).toISOString();
  return (
    <Link className={cx("cal-item")} data-kind={kind} data-past={at < now || undefined} href={`/presale/${sale.presale_id}`}>
      <time className={cx("cal-time num")} dateTime={iso} title={iso.replace("T", " ").replace(/(?:\.000)?Z$/, " UTC")}>{utcTime(at)}</time>
      <span className={cx("cal-identity")}>
        <ArtworkMark coinType={sale.coin_type} src={sale.icon_url} fallbackId={sale.presale_id} size={40} />
        <span className={cx("cal-t")}><b>{sale.name}</b><span>{sale.symbol}</span></span>
      </span>
      <span className={cx("cal-event")}><b>{at < now ? `Scheduled ${kind}` : kind === "opening" ? "Opening" : "Closing"}</b></span>
      <span className={cx("cal-target")}><span>Raise target</span><b className={cx("num")}>{calendarTarget(sale)}</b></span>
      <ChevronIcon className={cx("cal-action")} />
    </Link>
  );
}

export function PresaleCalendar({ sales, now, range = "upcoming", onRange, browseAction }: Readonly<{
  sales: readonly SocialPresaleSummary[] | null;
  now: number;
  range?: CalendarRange;
  onRange?: (range: CalendarRange) => void;
  browseAction?: ReactNode;
}>) {
  if (sales === null) return <PresaleCalendarSkeleton />;
  const events = calendarEvents(sales);
  const shown = eventsInRange(events, range, now);
  const undated = new Set(sales.filter((sale) => sale.start_ms <= 0).map((sale) => sale.presale_id)).size;
  return (
    <div className={cx("calendar")}>
      <div className={cx("cal-controls")}>
        <div>{shown.length > 0 ? <h2>{calendarHeading(shown)}</h2> : null}<span>All times UTC</span></div>
        <Segmented
          className={cx("cal-ranges")}
          disabled={!onRange}
          label="Calendar event range"
          onChange={(key) => onRange?.(key)}
          options={CALENDAR_RANGES.map(([key, label]) => [key, <>{label}<span className={cx("presale-view-count num")}>{eventsInRange(events, key, now).length}</span></>] as const)}
          value={range}
        />
      </div>
      {shown.length > 0
        ? <CalendarDays events={shown} now={now} />
        : <EmptyCalendar hasEvents={events.length > 0} range={range} onRange={onRange} browseAction={browseAction} />}
      {undated ? <p className={cx("cal-note")}>{undated} {undated === 1 ? "presale has" : "presales have"} no opening time yet. Unscheduled openings aren’t counted.</p> : null}
    </div>
  );
}

function CalendarDays({ events, now }: Readonly<{ events: readonly CalendarEvent[]; now: number }>) {
  const today = utcDayStartMs(now);
  const days = new Map<number, CalendarEvent[]>();
  for (const event of events) {
    const day = utcDayStartMs(event.at);
    const rows = days.get(day) ?? [];
    rows.push(event);
    days.set(day, rows);
  }
  return [...days].sort(([a], [b]) => a - b).map(([day, rows]) => (
    <section aria-label={day === today ? "Today" : calendarDate(day, now)} className={cx("cal-day")} key={day}>
      <h3>
        <DateStamp at={new Date(day).toISOString().slice(0, 10)} className={cx("cal-date-number num")} plain />
        {day === today ? <strong>Today</strong> : day === today + DAY_MS ? <span>Tomorrow</span> : null}
      </h3>
      <div className={cx("cal-events")}>{rows.map((event) => <CalendarRow event={event} key={`${event.sale.presale_id}:${event.kind}`} now={now} />)}</div>
    </section>
  ));
}

function EmptyCalendar({ hasEvents, range, onRange, browseAction }: Readonly<{
  hasEvents: boolean; range: CalendarRange; onRange?: (range: CalendarRange) => void; browseAction?: ReactNode;
}>) {
  return <EmptyState
    action={hasEvents && onRange ? <Button onClick={() => onRange("all")} size="sm" variant="ghost">View all events</Button> : browseAction ?? <ButtonLink href="/presale" size="sm" variant="ghost">Browse presales</ButtonLink>}
    framed
    role="status"
    title={range === "upcoming" ? "No upcoming events" : hasEvents ? "No events in this range" : "No scheduled events"}
  />;
}
