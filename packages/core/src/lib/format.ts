/**
 * The canonical UI's money formats (FEATURE-MAP §0.2), built to the same
 * strings as the prototype's helpers.
 */

import {
  bxPxExact,
  bxUsdExact,
  compareExact,
  exactAtoms,
  exactDecimal,
  exactNumber,
  exactText,
  fixedExact,
  groupDigits,
  groupedExact,
  multiplyExact,
  numShortExact,
  pxNumExact,
  qtyExact,
  shortFloorExact,
  shortQtyExact,
  type Exact,
} from "./exact-amount.ts";

/** `$` + en-US grouping with `digits` fraction digits: `$2,000`, `$1,200.00`. */
export function usd(value: number, digits = 0): string {
  return `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** Dollars to the cent; a nonzero amount under a cent is `<$0.01`, never `$0.00`. */
export function cents(value: number): string {
  return value > 0 && value < 0.005 ? "<$0.01" : usd(value, 2);
}

/** Whole dollars: `$850`. */
export function usd0(value: number): string {
  return usd(Math.round(value));
}

/** Drops trailing fraction zeros: `5.0` → `5`, `1.20` → `1.2`. */
function trimZeros(text: string): string {
  return text.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

/** Compact dollars (`numShortExact`): `$1.25B`, `$1.2M`, `$399K`, `$5K`, `$3.1K`, else `usd()`: `$860`. */
export function short(value: number): string {
  const exact = value >= 1e3 ? exactNumber(value) : null;
  return exact === null ? usd(value) : `$${numShortExact(exact)}`;
}

/**
 * Compact coin amount for a narrow tile (the collapsed right column's coin strip):
 * `1.3M`, `18K`, `5K`, `5.4K`, `412`, `41.3`; `999,999` reads `1M`.
 */
export function shortQty(value: number): string {
  return signed(value, shortQtyExact);
}

/** A coin amount in full (`qtyExact` of the printed number): `412.38`, `18,400`, `2.1M`, `1.25B`. */
export function qty(value: number): string {
  return signed(value, qtyExact);
}

/** `format` of a number's printed decimal, with its minus unless it reads as zero; a non-finite number prints as itself. */
function signed(value: number, format: (exact: Exact) => string): string {
  const exact = exactNumber(Math.abs(value));
  if (exact === null) return String(value);
  const text = format(exact);
  return value < 0 && /[1-9]/.test(text) ? `-${text}` : text;
}

/** What a hidden amount reads (the privacy eye). */
export const HIDDEN_AMOUNT = "••••";

/** The one glyph for a value that is not known (yet): the em dash, muted where it stands in for a value. */
export const NO_VALUE = "—";

/**
 * A price (§0.2 `px`): two places from $1, four from $0.01, else three
 * significant digits, exactly, with four or more leading zeros as a subscript
 * (`pxNumExact`'s rule), never in exponent form: `$3.42`, `$0.2109`,
 * `$0.0005`, `$0.0₆163`.
 */
export function px(value: number): string {
  const exact = exactNumber(value);
  if (exact === null) return `$${String(Number(value.toPrecision(3)))}`;
  if (value >= 1) return `$${fixedExact(exact, 2)}`;
  if (value >= 0.01) return `$${fixedExact(exact, 4)}`;
  return `$${pxNumExact(exact)}`;
}

/** A signed percentage with a true minus: `+2.41%`, `−1.86%`, `+412%`. */
export function signPct(value: number): string {
  const abs = Math.abs(value);
  return `${value >= 0 ? "+" : "−"}${trimZeros(abs.toFixed(abs >= 100 ? 0 : 2))}%`;
}

/** A fee in millionths of each trade as a percent, to two places without trailing zeros: 2,500 → `0.25%`, 10,000 → `1%`. */
export function ppmPct(ppm: number): string {
  return `${trimZeros((ppm / 1e4).toFixed(2))}%`;
}

/** A multiple to one place with a times sign: `4.2×`. */
export function multiple(value: number): string {
  return `${value.toFixed(1)}×`;
}

/** Signed whole dollars: `+$3,240`, `−$120` (U+2212), `$0`. */
export function signedUsd0(value: number): string {
  const whole = Math.round(value);
  if (whole === 0) return "$0";
  return `${whole > 0 ? "+" : "−"}${usd0(Math.abs(whole))}`;
}

/** Time left (§0.2 `timeLeft`): `11d 0h` from a day, `6h 12m` from an hour, else `1m 16s`; `0m 0s` once passed. */
export function timeLeft(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1_000));
  const d = Math.floor(s / 86_400), h = Math.floor((s % 86_400) / 3_600), m = Math.floor((s % 3_600) / 60);
  if (d >= 1) return `${d}d ${h}h`;
  if (h >= 1) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

const VENUE_NAMES: Readonly<Record<string, string>> = {
  blast_curve: "Bonding curve",
  cetus: "Cetus",
  bluefin: "Bluefin",
  aftermath: "Aftermath",
};

/** A known venue's display name (`Bonding curve`, `Cetus`, `Bluefin`, `Aftermath`), or null. */
export function knownVenueName(venue: string): string | null {
  const key = venue.toLowerCase();
  return Object.hasOwn(VENUE_NAMES, key) ? VENUE_NAMES[key]! : null;
}

/** A venue's display name: a known venue's name, any other value capitalized; `""` for none. */
export function venueName(venue: string): string {
  return knownVenueName(venue) ?? venue.charAt(0).toUpperCase() + venue.slice(1);
}

/** Basis points as a share: `4500` → `45%`, `250` → `2.5%`. */
export function bpsShare(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 ? 1 : 0)}%`;
}

/**
 * How full a raise is, as a whole percentage, from its fill in basis points
 * (raised / target × 10,000): `fillPercent`'s rule.
 */
export function fillPct(fillBps: number): number {
  return fillPercent(fillBps, 10_000);
}

/** Time until `targetMs` from `nowMs`, as `timeLeft`: `11d 0h`, `6h 12m`, `1m 16s`; never negative. */
export function timeUntil(targetMs: number, nowMs: number): string {
  return timeLeft(targetMs - nowMs);
}

/** A UTC moment: `Oct 14, 18:00 UTC`. */
export function utc(ms: number): string {
  return `${new Date(ms).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC",
  })} UTC`;
}

/** A UTC day: `Oct 14`. */
export function utcDay(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** A UTC time of day: `18:00`. */
export function utcTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });
}

/** A post's age: `now` under 45 s, then `6m`, `2h`, `4d`, and whole years from 365 days, `2y` (the boards' coin ages). */
export function ago(ms: number, nowMs: number): string {
  const seconds = Math.max(0, (nowMs - ms) / 1000);
  if (seconds < 45) return "now";
  if (seconds < 3_600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)}h`;
  const days = Math.round(seconds / 86_400);
  return days < 365 ? `${days}d` : `${Math.floor(days / 365)}y`;
}

/** An address shortened for a row: `0x1a2b…9f0e`, or with more of each end where there is room. */
export function shortAddress(address: string, head = 6, tail = 4): string {
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

/** `one` for exactly one, else `many`: `plural(n, "coin", "coins")`. */
function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** A count with its noun, grouped: `1 coin`, `1,204 coins`. */
export function countWords(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en-US")} ${plural(count, one, many)}`;
}

/** An editable figure as the prototype shows it in a field: en-US grouping, at most two decimals (`fmtNum`). */
export function fieldNumber(value: number, decimals = 2): string {
  return Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: decimals }) : "";
}

/**
 * How full a raise is (§0.2 `fillPct`, the one rule every surface uses):
 * raised ÷ target in percent, floored below 100 ("99.7% never reads as
 * full"), rounded from 100; 0 without a positive target or raise. Scaled
 * before dividing, so an exact share stays exact (29 of 100 is 29, not
 * 28.999…).
 */
export function fillPercent(raised: number, target: number): number {
  if (!(target > 0) || !(raised > 0)) return 0;
  const pct = (raised * 100) / target;
  return pct < 100 ? Math.floor(pct) : Math.round(pct);
}

/**
 * Atoms with `decimals` as the nearest number (display and charts only; never
 * an amount that moves), or null for a malformed figure.
 */
export function atomsValue(atoms: bigint | string | null | undefined, decimals: number | null | undefined): number | null {
  const value = exactAtoms(atoms, decimals);
  return value === null ? null : Number(exactText(value));
}

/** Atoms of a coin with `decimals` as their exact decimal, never grouped: `412.38`, `0.000001`, `-7`. */
export function atomsText(atoms: bigint | string, decimals: number): string {
  const value = BigInt(atoms);
  const text = exactText({ n: value < 0n ? -value : value, scale: decimals });
  return value < 0n ? `-${text}` : text;
}

/** `atomsText` with its whole part grouped: `1,234,567.5`. */
export function atomsGrouped(atoms: bigint | string, decimals: number): string {
  return groupDigits(atomsText(atoms, decimals));
}

/**
 * A pending presale's opening time, or null when it has none: blast-infra
 * gives `start_ms` 0 until the sale opens, and a presale opens when its
 * creator shares it (the contract sets the start then), so no date is known
 * before.
 */
export function opensAt(startMs: number): number | null {
  return startMs > 0 ? startMs : null;
}

/** What a pending presale without an opening time shows (OA-13). */
export const NOT_OPEN_YET = "Not open yet";

/** Whole 30-day months between two moments, at least 1. */
export function monthsBetween(startMs: number, endMs: number): number {
  return Math.max(1, Math.round((endMs - startMs) / (30 * 86_400_000)));
}

/** The live tape's age (§0.2 `tapeAgo`): `now` under 5 s, `12s` under a minute, else `1m` (rounded). */
export function tapeAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1_000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s`;
  return `${Math.round(s / 60)}m`;
}


/*
 * ---------------------------------------------------------------------------
 * R3 (`FEATURE-MAP-R3.md` §0.2, ticket R3-06).
 *
 * The base helpers above are unchanged: the R3 reference's `usd`, `usd0`,
 * `px`, `short`, `qty`, `signPct`, `multiple`, `fillPct`, `timeLeft`, `utc`,
 * `ago` and `tapeAgo` are the same rules it had before, verified line by line
 * against the gate build, so no caller's expectation moves. (`ago` has since
 * gained the 2026-10-27 boards' years from 365 days.) What follows are
 * rules the reference **added**, which Blast mode, the presales list, the sale
 * page and the recap all need. The reference's own name for each is quoted so
 * it can be found in the feature map.
 * ---------------------------------------------------------------------------
 */

/**
 * `shortFloor`: a compact figure that **rounds down**, so a raise never reads
 * as complete before it is — `$399K of $400K`, never `$400K of $400K`.
 * Returns the figure without its `$`, as the reference's helper does.
 */
export function shortFloor(value: number): string {
  if (value >= 1e6) return `${trimZeros((Math.floor(value / 1e4) / 100).toFixed(2))}M`;
  if (value >= 1e5) return `${Math.floor(value / 1e3)}K`;
  if (value >= 1e3) return `${trimZeros((Math.floor(value / 100) / 10).toFixed(1))}K`;
  return Math.floor(value).toLocaleString("en-US");
}

/**
 * A raised figure as every surface shows it (the USDC path of the reference's
 * `qsRaised`): rounded down while the sale is still filling, and `short()`
 * from its target, where rounding down would hide an oversubscription.
 */
export function raisedShort(raised: number, target: number): string {
  return raised >= target ? short(raised) : `$${shortFloor(raised)}`;
}

/**
 * `bxUsd`: whole dollars from $100 up, cents below, and never `.00` on a
 * round amount — `$250`, `$12.50`, `$99`, `$1,240`.
 */
export function bxUsd(value: number): string {
  return signed(value, bxUsdExact);
}

/** `bxSigned`: a signed `bxUsd` with a true minus — `+$84`, `−$12.40`. */
export function bxSigned(value: number): string {
  return `${value >= 0 ? "+" : "−"}${bxUsd(Math.abs(value))}`;
}

/**
 * `bxPx`: a ticking price — two places from $1, else **four significant
 * digits with the trailing zeros kept**, so the figure never changes width as
 * it moves (`$1.25`, `$0.002100`). Not `px()`, which drops those zeros and
 * makes a live price jitter.
 */
export function bxPx(value: number): string {
  return signed(value, bxPxExact);
}

/** A multiple to two places, as the Funded metric and the comfortable card draw it: `1.25×`, `4.20×`. */
export function times2(value: number): string {
  return `${value.toFixed(2)}×`;
}

/** What a P&L cell reads without a figure (the gate's Positions table): an en dash. */
export const NO_PNL = "–";

/**
 * R3-32's P&L as the gate writes it (FEATURE-MAP-R3 §15.7.3, §15.9) from a
 * position's or coin's `pnl_usd` and `pnl_multiple`: `+$958 · 4.19×`,
 * `−$12.40 · 0.81×`. Without them — no basis, a zero or incomplete one (a
 * full sell, a transfer in), no fresh price — `–`, never `∞`, `0×` or a
 * bare value. `hidden` (the privacy eye) masks the dollars, as the gate's
 * mask does; the multiple is not an amount.
 */
export function pnlText(pnlUsd: string | null, pnlMultiple: string | null, hidden = false): string {
  if (pnlUsd === null || pnlMultiple === null) return NO_PNL;
  return `${hidden ? HIDDEN_AMOUNT : bxSigned(Number(pnlUsd))} · ${times2(Number(pnlMultiple))}`;
}

/** The dock chip's subline after the value (§15.9): `(multiple − 1) × 100` as `signPct`, `+319%`; null without a multiple. */
export function pnlPercent(pnlMultiple: string | null): string | null {
  return pnlMultiple === null ? null : signPct((Number(pnlMultiple) - 1) * 100);
}

/**
 * `fundWord`: the caption after that multiple — `subscribed` only when a
 * raise landed exactly on its target, else `oversubscribed`. The old
 * reference captioned the figure `raised`, which read as the amount rather
 * than the overshoot (`FEATURE-MAP-R3.md` §9, §16).
 */
export function fundWord(raised: number, target: number): string {
  return times2(target > 0 ? raised / target : 0) === "1.00×" ? "subscribed" : "oversubscribed";
}

/*
 * Local-first times (`FEATURE-MAP-R3.md` §0.2, "Time rule (changed from the
 * old reference)"): everything the reader sees is **local** — tick labels,
 * the words in a row, a card's "opens at" line, the panel — and **UTC
 * appears only in tooltips**, always as the second half. Locale `en-US`, as
 * the reference hard-codes it.
 *
 * A local time depends on the reader's zone, so none of these may run on the
 * server: they are for client components only. `utc`, `utcDay` and `utcTime`
 * above stay the server-safe pair, and the base pages still use them.
 */

/** `localDay` (the reference's `tlDate`): `Oct 14`, in the reader's zone. */
export function localDay(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** `localTime` (`tlHm`): `19:14`, in the reader's zone, or in `timeZone` when one is given. */
export function localTime(ms: number, timeZone?: string): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
}

/** `localAt` (`tlAt`): `Oct 14, 19:14`. */
export function localAt(ms: number): string {
  return `${localDay(ms)}, ${localTime(ms)}`;
}

/** `localFull` (`tlFull`): what a tooltip says — local first, UTC appended, `Oct 14, 19:14 · 18:14 UTC`. */
export function localFull(ms: number): string {
  return `${localAt(ms)} · ${localTime(ms, "UTC")} UTC`;
}

/**
 * `localWhen` (`tlWhen`): how far off a moment is, signed — the date from 48
 * hours away, whole minutes (never under `1m`) inside an hour, else rounded
 * hours. `in 6h`, `7m ago`, `Oct 14`.
 */
export function localWhen(ms: number, nowMs: number): string {
  const delta = ms - nowMs;
  const abs = Math.abs(delta);
  if (abs >= 48 * 3_600_000) return localDay(ms);
  const text = abs < 3_600_000 ? `${Math.max(1, Math.round(abs / 60_000))}m` : `${Math.round(abs / 3_600_000)}h`;
  return delta >= 0 ? `in ${text}` : `${text} ago`;
}

/** `bxAgo`: the tape's seconds inside an hour, then the feed's hours, days and years — `now`, `42s`, `18m`, `6h`, `3d`, `2y`. */
export function bxAgo(ms: number, nowMs: number): string {
  return nowMs - ms < 3_600_000 ? tapeAgo(nowMs - ms) : ago(ms, nowMs);
}

/*
 * ---------------------------------------------------------------------------
 * R3-40: the quote currency (`FEATURE-MAP-R3.md` §21.2).
 *
 * A presale raises one coin, its quote: USDC (the default) or SUI. A USDC
 * sale's figures read in dollars exactly as they did before (the `*_usd`
 * fields through `usd`, `short`, `raisedShort` and `px`); any other quote
 * reads in its own coin, computed from the figure's **atoms and the quote's
 * decimals from the view**, exactly (`exact-amount.ts`), never from a
 * constant and never through a float. The gate's helpers, by name:
 *
 * - `qm` (full amount): `$184,221` / `184,221.5 SUI` (two places at most);
 * - `qs` (compact, the gate's `numShort`): `$400K` / `400K SUI`;
 * - `qsRaised` (`shortFloor` while filling): `$399K` / `399K SUI`;
 * - `qp` (a price, the gate's `pxNum`): `$0.000556` / `0.000556 SUI`.
 *
 * No figure here mixes two units: each returns one coin's figure, or null
 * when that coin's form of it is unknown.
 * ---------------------------------------------------------------------------
 */

/** A sale's quote coin as `chain_read_v1.presales` names it. */
export type SaleQuote = Readonly<{ symbol: string; decimals: number }>;

/** A presale's quote columns: its coin, decimals and USD price (null when unpriced). */
type QuotePricing = Readonly<{ quote_symbol: string; quote_decimals: number | null; quote_usd: string | null }>;

/**
 * Quote atoms in USD: whole quote coins × the quote's price. An unpriced USDC
 * quote reads at $1 (owner, 2026-11-14); any other unpriced quote is null.
 */
export function quoteUsd(presale: QuotePricing, atoms: string | null | undefined): number | null {
  const amount = exactAtoms(atoms, presale.quote_decimals);
  const fallback = presale.quote_symbol.toUpperCase() === "USDC" ? exactNumber(1) : null;
  const price = presale.quote_usd === null ? fallback : exactDecimal(presale.quote_usd);
  return amount === null || price === null ? null : Number(exactText(multiplyExact(amount, price)));
}

/** A payload's quote columns as a `SaleQuote`. */
export function quoteOf(source: Readonly<{ quote_symbol: string; quote_decimals: number }>): SaleQuote {
  return { symbol: source.quote_symbol, decimals: source.quote_decimals };
}

/** Whether a sale reads in its own coin rather than in dollars: every quote but USDC (the default). */
export function readsInCoin(quote: SaleQuote | null | undefined): quote is SaleQuote {
  return quote !== null && quote !== undefined && quote.symbol.toUpperCase() !== "USDC";
}

/** One sale figure in both of its forms: dollars (two places; the USDC path) and quote atoms (the coin path). */
export type SaleAmount = Readonly<{ usd: string | null; atoms: string | null }>;

function coinOf(quote: SaleQuote, atoms: string | null): Exact | null {
  return exactAtoms(atoms, quote.decimals);
}

/**
 * The gate's `qm`: a full amount in the sale's coin — `usd(n, digits)` for a
 * USDC sale, else the coin to `digits` places (two when 0) with its symbol:
 * `25 SUI`, `1,234.5 SUI`. Null when that form of the figure is unknown.
 */
export function qm(quote: SaleQuote | null | undefined, amount: SaleAmount, digits = 0): string | null {
  if (readsInCoin(quote)) {
    const value = coinOf(quote, amount.atoms);
    return value === null ? null : `${groupedExact(value, digits || 2)} ${quote.symbol}`;
  }
  return amount.usd === null ? null : inUsdc(usd(Number(amount.usd), digits));
}

/**
 * A USDC sale's money figure names its coin like every other sale (owner,
 * 2026-10-27: "show the coin they are raising, not always USD"): `$184,221`
 * becomes `184,221 USDC`. Prices (`qp`) stay in dollars.
 */
function inUsdc(dollars: string): string {
  return dollars.startsWith("-$") ? `-${dollars.slice(2)} USDC` : `${dollars.replace(/^\$/, "")} USDC`;
}

/** A USDC sale's money figure as the tweened counters draw it: `184,221 USDC`. */
export function usdc(value: number, digits = 0): string {
  return inUsdc(usd(value, digits));
}

/** The gate's `qs`: compact — `short()` for a USDC sale, else `numShort` with the symbol: `400K SUI`, `1.25M SUI`. */
export function qs(quote: SaleQuote | null | undefined, amount: SaleAmount): string | null {
  if (readsInCoin(quote)) {
    const value = coinOf(quote, amount.atoms);
    return value === null ? null : `${numShortExact(value)} ${quote.symbol}`;
  }
  return amount.usd === null ? null : inUsdc(short(Number(amount.usd)));
}

/**
 * The gate's `qsRaised`: a raised figure that floors while the sale fills, in
 * the sale's own coin, so a SUI raise at 99.97% reads `399K SUI`, never its
 * target; `qs` from the target on. The USDC path is `raisedShort` unchanged.
 */
export function qsRaised(quote: SaleQuote | null | undefined, raised: SaleAmount, target: SaleAmount): string | null {
  if (readsInCoin(quote)) {
    const value = coinOf(quote, raised.atoms);
    const goal = coinOf(quote, target.atoms);
    if (value === null || goal === null) return null;
    return compareExact(value, goal) >= 0 ? `${numShortExact(value)} ${quote.symbol}` : `${shortFloorExact(value)} ${quote.symbol}`;
  }
  return raised.usd === null || target.usd === null ? null : inUsdc(raisedShort(Number(raised.usd), Number(target.usd)));
}

/** A price per whole token in both forms: dollars and the quote coin (plain decimal strings). */
export type SalePrice = Readonly<{ usd: string | null; quote: string | null }>;

/** The gate's `qp`: a price — `px()` for a USDC sale, else `pxNum` with the symbol: `0.000556 SUI`, `1.50 SUI`. */
export function qp(quote: SaleQuote | null | undefined, price: SalePrice): string | null {
  if (readsInCoin(quote)) {
    const value = exactDecimal(price.quote);
    return value === null ? null : `${pxNumExact(value)} ${quote.symbol}`;
  }
  return price.usd === null ? null : px(Number(price.usd));
}
