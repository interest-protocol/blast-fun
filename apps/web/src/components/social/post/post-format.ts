import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * The canonical UI's formats for posts (FEATURE-MAP §0.2), built to the same
 * strings as the prototype's helpers. Pure: every string is rendered as React
 * text, nothing here builds markup.
 */

const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

// Money, prices, quantities and times are the shell's (blast-ui/format.ts, one set for every section).
export { ago, multiple, px, qty, short, usd, usd0, utc, venueName } from "@blast/core/web/format.ts";

/** One place, trailing zeros dropped: `32.6`, `6.2`, `3` (the prototype's `trim(n.toFixed(1))`). */
export function pct1Digits(value: number): string {
  return value.toFixed(1).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

/** A signed move to one place with a true minus (the prototype's `pct1`): `+10.5%`, `−3.1%`, `+3%`. */
export function pct1(value: number): string {
  return `${value >= 0 ? "+" : "−"}${pct1Digits(Math.abs(value))}%`;
}

/** A count with en-US grouping: `1,012`. */
export function count(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * A post's full time for its `title`: `Oct 3, 5:42 PM` in the reader's zone.
 * `timeZone` pins it (the server renders UTC so the first render matches;
 * the browser switches to its own zone after hydration).
 */
export function fullDate(occurredAtMs: number, timeZone?: string): string {
  return new Date(occurredAtMs).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone });
}

/** A duration in words for post copy: "6 hours", "2 days", "1 minute". */
export function durationWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const [value, unit] = minutes >= 2 * 1_440 ? [Math.round(minutes / 1_440), "day"] : minutes >= 120 ? [Math.round(minutes / 60), "hour"] : [minutes, "minute"];
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}


/** A decimal string as a number, or null. Display only. */
export function decimal(value: string | null | undefined): number | null {
  return value !== null && value !== undefined && DECIMAL.test(value) ? Number(value) : null;
}

/** The explorer (FEATURE-MAP §20: Suiscan by default; an explorer setting comes later). */
export const EXPLORER_NAME = "Suiscan";
/** A transaction digest (base58 on Sui); any alphanumeric id of digest length is safe in the URL path. */
const DIGEST = /^[0-9A-Za-z]{32,64}$/;

/** A transaction on the explorer (mainnet), or null for anything but a digest. */
export function explorerTxUrl(digest: string | null | undefined): string | null {
  return digest && DIGEST.test(digest) ? `https://suiscan.xyz/mainnet/tx/${digest}` : null;
}

/** A wallet on the explorer (mainnet), or null for anything but an address. */
export function explorerAccountUrl(address: string): string | null {
  return SUI_OBJECT_ID_PATTERN.test(address) ? `https://suiscan.xyz/mainnet/account/${address}` : null;
}

/**
 * The hue of an anonymous wallet's gradient avatar (`.wav`): the sum of the
 * short address's character codes mod 360, as the prototype derives it.
 */
export function walletHue(short: string): number {
  let hue = 0;
  for (const character of short) hue += character.charCodeAt(0);
  return hue % 360;
}
