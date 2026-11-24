import { quoteDisplaySymbol } from "./quote-coins";
import { exactDecimal, exactNumber, fixedExact, groupedExact, pxNumExact, subscriptZeros } from "@blast/core/web/exact-amount.ts";
import { fieldNumber, px, usd } from "@blast/core/web/format.ts";
import type { CreateDraft } from "@blast/core/web/contracts/create.ts";
import { draftQuote, draftShort as coreDraftShort } from "@blast/core/modules/social/create/model.ts";
import { presaleTargetDecimals } from "@blast/core/modules/social/create/minimum-raise.ts";

/**
 * R3-42: a Create draft's figures in the coin it raises — the gate's `qIn`,
 * `qm`, `qs` and `qp` over the draft (`d.quote`). A USDC draft reads exactly
 * as before (`$`, `usd`, `short`, `px`); a SUI draft takes a `SUI` suffix and
 * SUI figures, exact from their two decimals.
 */

type Quoted = Pick<CreateDraft, "quote_type">;

/** The gate's `qIn`: where a money field's unit goes — a `$` before it, or a `SUI` after it. */
export function quoteAffix(draft: Quoted): Readonly<{ pre: string } | { suf: string }> {
  const { symbol } = draftQuote(draft);
  return symbol === "USDC" ? { pre: "$" } : { suf: quoteDisplaySymbol(symbol) };
}

/** A draft amount in full (the gate's `qm(d, n, digits)`): `$400,000`, `117,000 SUI`. */
export function draftMoney(draft: Quoted, amount: number, digits = 0): string {
  const quote = draftQuote(draft);
  if (quote.symbol === "USDC") return usd(amount, digits);
  const value = exactDecimal(Math.max(0, amount).toFixed(2));
  return `${value === null ? "0" : groupedExact(value, digits || 2)} ${quoteDisplaySymbol(quote.symbol)}`;
}

export function draftTarget(draft: Pick<CreateDraft, "quote_type" | "target">): string {
  const precision = presaleTargetDecimals(draft.quote_type);
  if (precision === 2) return draftMoney(draft, draft.target);
  return `${fieldNumber(draft.target, precision)}\u00a0${draftQuote(draft).symbol}`;
}

/** A draft amount compact (the gate's `qs(d, n)`): `$400K`, `117K SUI`. */
export function draftShort(draft: Quoted, amount: number): string {
  const symbol = draftQuote(draft).symbol;
  return coreDraftShort(draft, amount).replace(new RegExp(` ${symbol}$`), ` ${quoteDisplaySymbol(symbol)}`);
}

/** A price per token in the draft's coin (the gate's `qp(d, n)`): `$0.000556`, `0.000162 SUI`, `$0.0₆5`. */
export function draftPrice(draft: Quoted, price: number): string {
  const quote = draftQuote(draft);
  if (quote.symbol === "USDC") return px(price);
  const value = exactDecimal(Number.isFinite(price) && price > 0 ? price.toFixed(18) : "0");
  return `${value === null ? "0" : pxNumExact(value)} ${quoteDisplaySymbol(quote.symbol)}`;
}

/** A sub-cent price to two significant digits (`0.00056`), or null at a cent and above. */
function twoDigits(price: number): string | null {
  const value = exactNumber(price);
  if (value === null || !(price > 0) || price >= 0.01) return null;
  return subscriptZeros(fixedExact(value, Math.ceil(-Math.log10(price)) + 1).replace(/0+$/, "").replace(/\.$/, ""));
}

/**
 * The presale and launch prices shown together, with the fewest places that
 * still tell them apart: two significant digits when those differ
 * (`$0.00056` and `$0.00063`), else `draftPrice`'s three.
 */
export function draftPrices(draft: Quoted, presale: number, launch: number): Readonly<{ presale: string; launch: string }> {
  const [first, second] = [twoDigits(presale), twoDigits(launch)];
  if (first === null || second === null || first === second) return { presale: draftPrice(draft, presale), launch: draftPrice(draft, launch) };
  const symbol = draftQuote(draft).symbol;
  const read = (text: string) => (symbol === "USDC" ? `$${text}` : `${text} ${quoteDisplaySymbol(symbol)}`);
  return { presale: read(first), launch: read(second) };
}

/** The launch price's premium over the presale price, in whole percent: `+10%`, `−3%`, `+0%`. */
export function premiumText(premium: number): string {
  const whole = Math.round(premium);
  return `${whole >= 0 ? "+" : "−"}${Math.abs(whole)}%`;
}
