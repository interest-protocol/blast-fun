"use client";

import { NO_VALUE } from "@blast/core/web/format.ts";
import { InspectValue } from "./InspectValue.tsx";
import { shortUtcDate } from "./date-label.ts";

/** A compact date or time label, with the exact UTC timestamp available to inspect. */
export function DateStamp({ at, label = "timestamp", className, href, plain = false, clock = false, displayText, onInspect }: Readonly<{
  at: number | bigint | string | null | undefined;
  label?: string;
  className?: string;
  href?: string;
  /** The parent is already interactive, so the time cannot add an inspection button. */
  plain?: boolean;
  /** Time of day distinguishes records within the same day, as in a candle table. */
  clock?: boolean;
  displayText?: string;
  onInspect?: (open: boolean) => void;
}>) {
  const date = new Date(typeof at === "bigint" ? Number(at) : at ?? Number.NaN);
  if (!Number.isFinite(date.getTime())) return <span className={className}>{NO_VALUE}</span>;

  const iso = date.toISOString();
  const dayOnly = typeof at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(at);
  const full = dayOnly ? at : iso.replace("T", " ").replace(/(?:\.000)?Z$/, " UTC");
  const text = displayText ?? shortUtcDate(date);
  const visible = (
    <time dateTime={dayOnly ? at : iso} className={plain ? className : undefined} title={plain ? full : undefined}>
      {text}{clock ? ` · ${iso.slice(-13, -5)}` : null}
    </time>
  );
  if (plain) return visible;
  if (href) return <a className={className} href={href} aria-label={`${label}: ${text}, ${full}`} title={full}>{visible}</a>;
  return <span className={className}><InspectValue value={full} label={label} onOpenChange={onInspect}>{visible}</InspectValue></span>;
}
