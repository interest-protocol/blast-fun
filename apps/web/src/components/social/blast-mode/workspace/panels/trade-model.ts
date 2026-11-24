import { tradeSide, tradeTicketCta, balanceModeAtoms, tokenAmountAtoms, type TradeDraft } from "#web/components/social/trade/trade-ticket.ts";
import {
  amtExact,
  bxPxExact,
  bxUsdExact,
  compareExact,
  divideExact,
  exactAtoms,
  exactDecimal,
  exactText,
  groupDigits,
  groupedExact,
  multiplyExact,
  qtyExact,
  unitsAt,
  ZERO_EXACT,
  type Exact,
} from "@blast/core/web/exact-amount.ts";
import { HIDDEN_AMOUNT } from "@blast/core/web/format.ts";
import { SOCIAL_TRADE_BASE_COINS, type SocialTradeQuote, type SocialTradeQuoteRequest } from "@blast/core/web/contracts/trades.ts";

import { tradeBalanceLabel } from "#web/components/social/trade/trade-balance.ts";
import { impactText, impactTone, unavailableText } from "#web/components/social/trades/trade-quote-view.ts";

/**
 * The workspace coin panel's trade form (FEATURE-MAP-R3 §15.7.5, R3-55; the
 * gate is OA-32's `design/blast-feel-preview-oa32.html`, sha256 `707efdd9…`,
 * whose `bxTradeHTML` / `bxTradeQuote` / `bxTradeConfirm` this file says in
 * the product's words), pure, so every state is a test.
 *
 * *"Both ways the amount is in dollars, with the commit composer's presets
 * ($50, $100, $500, Max): selling '$100 of KSTL' sells min(held, 100 /
 * price) tokens, and Max sells everything held."*
 *
 * The gate rules every pixel and behaviour (the owner's standing rule,
 * 2026-10-06). What the product must do that the gate cannot:
 *
 * - **Every number on the quote line is the quote route's** (R3-30): what the
 *   trade gets (`amount_out`), its impact (`price_impact_bps`, OA-29's second
 *   dry run; no impact at all when it is null — never a guess), and for a
 *   sell, the tokens it sends (`amount_in`). The only local arithmetic is
 *   turning the dollars typed into the **atoms asked for** — USDC at face
 *   value, a coin at the price the panel shows — and the over-balance check,
 *   both exact (`@blast/core` `Exact`, no floats).
 * - `Max`, `Sell all` and `Sell 50%` are the gate's `max` / `frac`: exactly
 *   the whole balance or half of what is held, sent as exact atoms; typing
 *   leaves them, as in the gate (the field shows what was typed and means
 *   `min(held, dollars / price)` again).
 * - Without a counterasset the pair is USDC and the coin. Callers may provide
 *   an explicit counterasset: typed input stays USD, converted only with a
 *   known payment price; exact presets use its atoms. Pair direction is the
 *   quote contract's classification, independent of the workspace Buy/Sell tab.
 */

/* ------------------------------------------------------------------------- */
/* The draft                                                                 */
/* ------------------------------------------------------------------------- */

type TradeSide = TradeDraft["side"];

/** The coin being traded and the viewer's balances, as the routes answer them. */
export type TradeFacts = Readonly<{
  signedIn: boolean;
  symbol: string;
  /** The sale coin's canonical type (`sale_token`); null until the sale read lands. */
  coinType: string | null;
  decimals: number | null;
  /** USD per whole coin: the wallet's price, else the sale read's (R3-20's, at most 120 s old). */
  price: Exact | null;
  /** The Blast wallet's USDC and coin, in atoms; null before the wallet answers (or for a visitor). */
  usdc: bigint | null;
  usdcDecimals: number;
  held: bigint | null;
  /** Before the wallet answers: whether the viewer's positions say they hold the coin (the toggle must not flicker). */
  heldHint: boolean;
  /** Optional payment/destination asset; USDC without one. */
  counter?: Readonly<{ coinType: string; symbol: string; decimals: number; balance: bigint | null; price: Exact | null }>;
}>;

/** Both directions can be quoted before a wallet is connected. */
function sideOf(draft: TradeDraft): TradeSide {
  return draft.side;
}

/**
 * The gate's live amount format (`fmtLive`): digits and one point, the whole
 * part grouped as it is typed (`100,000`), at most six places (USDC's atoms).
 */
function liveAmount(raw: string): string {
  const [whole = "", fraction] = raw.replace(/[^0-9.]/g, "").split(".");
  const digits = whole.replace(/^0+(?=\d)/, "");
  const head = digits !== "" ? groupDigits(digits) : fraction !== undefined ? "0" : "";
  return head + (fraction !== undefined ? `.${fraction.slice(0, 6)}` : "");
}

/** The dollars in the field, exactly; zero for an empty or unreadable field. */
export function typedUsd(typed: string): Exact {
  const plain = typed.replace(/,/g, "").replace(/\.$/, "").trim().replace(/^0+(?=\d)/, "");
  return exactDecimal(plain) ?? ZERO_EXACT;
}

/** A dollar amount as the field shows it once a preset or a mode fills it: cents, rounded down, grouped (`1,282.53`, `860`). */
function fieldUsd(usd: Exact): string {
  return groupedExact(usd, 2, "floor");
}

const coinAmount = (atoms: bigint, decimals: number): Exact => ({ n: atoms, scale: decimals });

/** Atoms of a coin with `decimals` worth `usd` at `price`, rounded down (what can actually be sent). */
const atomsForUsd = (usd: Exact, price: Exact, decimals: number): bigint => divideExact(usd, price, decimals)?.n ?? 0n;

/** What there is to spend, in dollars: the USDC balance (buy) or what the coin held is worth (sell). Null while unknown. */
function haveUsd(side: TradeSide, facts: TradeFacts): Exact | null {
  if (!facts.signedIn) return null;
  if (side === "buy") {
    if (!facts.counter) return facts.usdc === null ? null : coinAmount(facts.usdc, facts.usdcDecimals);
    const {balance,decimals,price}=facts.counter;
    return balance === null || price === null ? null : multiplyExact(coinAmount(balance,decimals),price);
  }
  if (facts.held === null || facts.decimals === null || facts.price === null) return null;
  return multiplyExact(coinAmount(facts.held, facts.decimals), facts.price);
}

/**
 * The atoms the trade spends: USDC for a buy, the coin for a sell. `all` and
 * `half` are of the balance exactly; typed dollars are USDC at face value, or
 * `min(held, dollars / price)` of the coin. Null when it cannot be known yet
 * (no balance read, no price, no decimals).
 */
export function amountInAtoms(draft: TradeDraft, facts: TradeFacts): bigint | null {
  const side = sideOf(draft);
  if (side === "buy") return buyAmountInAtoms(draft, facts);
  if (facts.decimals === null) return null;
  if (draft.mode !== "typed") return balanceModeAtoms(draft.mode, facts.held);
  if (draft.unit === "token") return tokenAmountAtoms(draft, { atoms: facts.held ?? 0n, decimals: facts.decimals });
  if (facts.price === null || facts.price.n === 0n) return null;
  const wanted = atomsForUsd(typedUsd(draft.typed), facts.price, facts.decimals);
  return facts.held === null || wanted < facts.held ? wanted : facts.held;
}

function buyAmountInAtoms(draft: TradeDraft, facts: TradeFacts): bigint | null {
  if (draft.mode !== "typed") return balanceModeAtoms(draft.mode, facts.counter ? facts.counter.balance : facts.usdc);
  if (!facts.counter) return unitsAt(typedUsd(draft.typed), facts.usdcDecimals, "floor");
  if (facts.counter.price === null || facts.counter.price.n === 0n) return null;
  return atomsForUsd(typedUsd(draft.typed), facts.counter.price, facts.counter.decimals);
}

/** Whether the field asks for nothing (empty, or zero dollars, in typed mode). */
export function isEmptyDraft(draft: TradeDraft): boolean {
  return draft.mode === "typed" && typedUsd(draft.typed).n === 0n;
}

/** Over balance: typed dollars beyond what there is (a mode never is). Unknown balances are not over. */
export function overBalance(draft: TradeDraft, facts: TradeFacts): boolean {
  if (draft.mode !== "typed" || !facts.signedIn) return false;
  if (draft.side === "sell" && draft.unit === "token") {
    return facts.held !== null && facts.decimals !== null && compareExact(typedUsd(draft.typed), coinAmount(facts.held, facts.decimals)) > 0;
  }
  const have = haveUsd(sideOf(draft), facts);
  return have !== null && compareExact(typedUsd(draft.typed), have) > 0;
}

/** The quote request for the draft, or null when there is nothing to ask (no amount, no coin, an amount of zero atoms). */
export function tradeRequest(draft: TradeDraft, facts: TradeFacts): SocialTradeQuoteRequest | null {
  if (facts.coinType === null || isEmptyDraft(draft)) return null;
  const amount = amountInAtoms(draft, facts);
  if (amount === null || amount <= 0n) return null;
  const side = sideOf(draft);
  const counter = facts.counter?.coinType ?? SOCIAL_TRADE_BASE_COINS.usdc;
  if (counter === facts.coinType) return null;
  const in_coin = side === "buy" ? counter : facts.coinType;
  const out_coin = side === "buy" ? facts.coinType : counter;
  return {in_coin,out_coin,side:tradeSide(in_coin,out_coin),amount_in:amount.toString()};
}

/** The quote's scope: a sign-in or a sign-out changes what the route answers (offered or only shown). */
export const quoteScope = (facts: TradeFacts) => (facts.signedIn ? "in" : "out");

/* ------------------------------------------------------------------------- */
/* Presets and modes                                                         */
/* ------------------------------------------------------------------------- */

/** Match the same preset requests while both amounts move less than 1%. */
export function closeRequests(kept: readonly SocialTradeQuoteRequest[], next: readonly SocialTradeQuoteRequest[]) {
  return kept.length === next.length && kept.every((was, index) => {
    const now = next[index]!;
    const pair = (request: SocialTradeQuoteRequest) => JSON.stringify({ ...request, amount_in: undefined, amount_out: undefined });
    return pair(was) === pair(now) && within1Percent(was.amount_in, now.amount_in) && within1Percent(was.amount_out, now.amount_out);
  });
}

/** Within 1% of the kept amount. */
function within1Percent(was: string | undefined, now: string | undefined) {
  if (was === undefined || now === undefined) return was === now;
  const a = BigInt(was);
  const b = BigInt(now);
  return (a > b ? a - b : b - a) * 100n < a;
}

/**
 * A preset's draft: `$50` and the rest are typed dollars; `Max` is the whole
 * USDC balance (buy) or everything held (sell), shown as its dollar value.
 */
export function presetDraft(value: string, side: TradeSide, facts: TradeFacts): TradeDraft {
  if (value !== "max") return { side, typed: liveAmount(value), mode: "typed" };
  const have = haveUsd(side, facts);
  return { side, typed: have === null ? "" : liveAmount(fieldUsd(have)), mode: "all" };
}

/**
 * What the field shows: literal typed dollars, or the current spend asset
 * balance and price for an exact whole/half preset. A saved preset text is
 * never conversion authority after a pair, balance or price change.
 */
export function fieldValue(draft: TradeDraft, facts: TradeFacts): string {
  if (draft.mode === "typed") return draft.typed;
  if (draft.side === "sell" && draft.unit === "token") {
    const atoms = amountInAtoms(draft, facts);
    return atoms === null || facts.decimals === null ? "" : groupDigits(exactText(coinAmount(atoms, facts.decimals)));
  }
  const all = haveUsd(sideOf(draft), facts);
  if (all === null) return "";
  const divisor = draft.mode === "quarter" ? 4n : draft.mode === "half" ? 2n : 1n;
  return liveAmount(fieldUsd(divideExact(all, { n: divisor, scale: 0 }) ?? all));
}

/* ------------------------------------------------------------------------- */
/* The quote line                                                            */
/* ------------------------------------------------------------------------- */

export type TradeQuoteLine = Readonly<{
  /** The line up to the impact. */
  lead: string;
  /** ` · impact 0.11%`, coloured red above 10% and amber above 3%; null when the quote has no impact (OA-29). */
  impact: Readonly<{ text: string; tone: "down" | "warn" | "plain" }> | null;
  /** The line is a refusal or an outage, not a figure. */
  notice: boolean;
}>;

/**
 * The gate's blanket rewrite under hidden amounts (`bxMaskNow`): every `$…`
 * and every `<number> <SYMBOL>` becomes dots; percentages stay.
 */
function maskAmounts(text: string, symbols: readonly string[]): string {
  const names = [...new Set(["SUI", "USDC", ...symbols])].map((name) => name.replace(/[^A-Za-z0-9]/g, "")).join("|");
  const amounts = new RegExp(`[−+-]?\\$[\\d,]+(?:\\.\\d+)?[kKMB]?|\\b\\d[\\d,]*(?:\\.\\d+)?[kKMB]?\\s(?:${names})\\b`, "g");
  return text.replace(amounts, HIDDEN_AMOUNT);
}

const UNKNOWN = "–";

/**
 * The quote line (`[data-bxq]`, `aria-live="polite"`), the gate's five forms:
 *
 * | state | text |
 * | --- | --- |
 * | empty, signed in, buy | `You have $860` |
 * | empty, signed in, sell | `You have 600,000 KSTL, $1,260` |
 * | empty, signed out | `KSTL is $0.002100` |
 * | buy, with an amount | `≈ 47,566 KSTL · impact 0.11%` |
 * | sell, with an amount | `≈ 47,619 KSTL → $99.85 · impact 0.11%` |
 *
 * plus the product's own: before the answer lands the line keeps its shape
 * with `–` where the route's figure goes; a route-less answer says why
 * (`unavailableText`); a quote with no impact (signed out, too small, OA-29)
 * has no `· impact`; Blast not paying this fee says what it is.
 */
export function tradeQuoteLine(
  input: Readonly<{
    draft: TradeDraft;
    facts: TradeFacts;
    quote: SocialTradeQuote | null;
    /** The last quote ask failed and nothing answers this request. */
    failed: boolean;
    hidden?: boolean;
    /** Blast will not pay this trade's fee today (R3-31's `sponsorship_unavailable`), in MIST. */
    feeMist?: string | null;
  }>,
): TradeQuoteLine {
  const { draft, facts, quote, failed } = input;
  const symbol = facts.symbol;
  const side = sideOf(draft);
  const mask = (text: string) => (input.hidden === true ? maskAmounts(text, [symbol, facts.counter?.symbol ?? "USDC"]) : text);
  const plain = (lead: string, notice = false): TradeQuoteLine => ({ lead: mask(lead), impact: null, notice });
  function emptyQuoteLine(): TradeQuoteLine {
    if (!facts.signedIn) return plain(`${symbol} is ${facts.price === null ? UNKNOWN : bxPxExact(facts.price)}`);
    const have = haveUsd(side, facts);
    if (side === "buy") return plain(`You have ${have === null ? UNKNOWN : bxUsdExact(have)}`);
    const held = facts.held === null || facts.decimals === null ? UNKNOWN : `${qtyExact(coinAmount(facts.held, facts.decimals))} ${symbol}`;
    return plain(`You have ${held}, ${have === null ? UNKNOWN : bxUsdExact(have)}`);
  }
  if (isEmptyDraft(draft)) {
    return emptyQuoteLine();
  }
  if (input.feeMist !== undefined && input.feeMist !== null) {
    const fee = exactAtoms(input.feeMist, 9);
    if (fee !== null) return plain(`Network fee ≈ ${amtExact(fee)} SUI, paid from your SUI`, true);
  }
  if (quote !== null && quote.unavailable_reason !== null) return plain(unavailableText(quote.unavailable_reason), true);
  if (quote === null && failed) return plain(unavailableText("pool_unavailable"), true);
  return quotedAmounts();
  function quotedAmounts(): TradeQuoteLine {
    const impact =
      quote === null || quote.price_impact_bps === null
        ? null
        : { text: impactText(quote.price_impact_bps), tone: impactTone(quote.price_impact_bps) };
    const decimals = facts.decimals;
    if (side === "buy") {
      const got = quote === null ? null : exactAtoms(quote.amount_out, decimals);
      const out = got === null ? UNKNOWN : qtyExact(got);
      return { lead: mask(`≈ ${out} ${symbol}`), impact, notice: false };
    }
    // A sell names the tokens it sends (the request's, which the quote echoes) and the dollars back.
    const quoted = quote === null ? null : exactAtoms(quote.amount_in, 0);
    const sending = quoted === null ? amountInAtoms(draft, facts) : quoted.n;
    const tokens = sending === null || decimals === null ? UNKNOWN : qtyExact(coinAmount(sending, decimals));
    const back = quote === null ? null : exactAtoms(quote.amount_out, facts.counter?.decimals ?? facts.usdcDecimals);
    const backText = back === null ? UNKNOWN : facts.counter ? `${qtyExact(back)} ${facts.counter.symbol}` : bxUsdExact(back);
    return { lead: mask(`≈ ${tokens} ${symbol} → ${backText}`), impact, notice: false };
  }
}

/* ------------------------------------------------------------------------- */
/* The button                                                                */
/* ------------------------------------------------------------------------- */

export type TradeCta = Readonly<{
  label: string;
  disabled: boolean;
  /** `sign-in` opens the sign-in sheet; `trade` sends the quote on screen. */
  action: "trade" | "sign-in" | "none";
  /** A sentence under the button when the trade cannot go for a reason the button does not name. */
  note: string | null;
}>;

/**
 * The CTA, the gate's `Buy KSTL` / `Sell KSTL`; over balance `Not enough USDC`
 * / `Not enough KSTL`, disabled; signed out `Sign in to trade` (enabled: it
 * opens the sign-in sheet). The product also waits for a quote it can execute:
 * the button is off while the answer for this amount is on its way, has no
 * route, or has expired (it is asked again two seconds before it does).
 */
export function tradeCta(
  input: Readonly<{ draft: TradeDraft; facts: TradeFacts; quote: SocialTradeQuote | null; nowMs: number; estimate?: boolean }>,
): TradeCta {
  const { draft, facts, quote, nowMs, estimate } = input;
  const label = `${draft.side === "sell" ? "Sell" : "Buy"} ${facts.symbol}`;
  const symbol = draft.side === "sell" ? facts.symbol : (facts.counter?.symbol ?? "USDC");
  const cta = tradeTicketCta({
    signedIn: facts.signedIn,
    amount: isEmptyDraft(draft) ? null : amountInAtoms(draft, facts),
    overBalance: overBalance(draft, facts),
    snapshot: { key: null, quote, shown: quote, loading: false, error: null },
    nowMs,
    estimate,
  }, {
    label, quotedLabel: label, busyLabel: label,
    signIn: { label: "Sign in to trade" },
    walletReason: "Your Blast wallet is not ready. Reload and try again.",
    insufficient: (gas) => ({ label: tradeBalanceLabel(gas ? quote?.balance_failure : null, symbol) }),
    unavailable: () => undefined,
  });
  return { label: cta.label, disabled: !cta.enabled, action: cta.action ?? "none", note: cta.reason ?? null };
}
