import type { TradeQuoteSnapshot } from "./trade-quotes.ts";
import { isOffered } from "../trades/trade-quote-view.ts";
import { match } from "ts-pattern";
import { exactText, groupDigits, unitsAt } from "@blast/core/web/exact-amount.ts";
import { SUI_COIN_TYPE, USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import type { SocialTradeSide } from "@blast/core/web/contracts/trades.ts";

export type TradeAmount = Readonly<{ typed: string; mode: "typed" | "all" | "half" | "quarter"; unit?: "usd" | "token"; fixedAtoms?: bigint }>;
export type TradeDraft = TradeAmount & Readonly<{ side: "buy" | "sell" }>;
export type SellPreset = "25" | "50" | "75" | "max";
export const SELL_PRESETS: readonly (readonly [SellPreset, string])[] = [["25", "25%"], ["50", "50%"], ["75", "75%"], ["max", "Max"]];
export const EMPTY_TRADE_AMOUNT: TradeAmount = { typed: "", mode: "typed", unit: "token" };

type SpendCoin = Readonly<{ atoms: bigint; decimals: number }>;

export function typedPlaces(decimals: number): number { return Math.min(decimals, 6); }

export function fmtLive(text: string, places = 6): string {
  const [whole = "", fraction] = String(text).replace(/[^0-9.]/g, "").split(".");
  const digits = whole.replace(/^0+(?=\d)/, "");
  const head = digits !== "" ? groupDigits(digits) : fraction !== undefined ? "0" : "";
  return head + (fraction !== undefined && places > 0 ? `.${fraction.slice(0, places)}` : "");
}

export function parseAtoms(text: string, decimals: number): bigint | null {
  const parsed = /^(\d*)(?:\.(\d*))?$/.exec(String(text).replace(/,/g, "").trim());
  if (!parsed || (parsed[1] === "" && (parsed[2] ?? "") === "")) return null;
  const fraction = (parsed[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(parsed[1] || "0") * 10n ** BigInt(decimals) + BigInt(fraction || "0");
}

export function atomsToField(atoms: bigint, decimals: number): string {
  const places = typedPlaces(decimals);
  return fmtLive(exactText({ n: unitsAt({ n: atoms, scale: decimals }, places, "floor"), scale: places }), places);
}

export function typedAmount(raw: string, decimals: number): TradeAmount {
  return { typed: fmtLive(raw, typedPlaces(decimals)), mode: "typed", unit: "token" };
}

/** Percentages floor only fractional atoms; a preset never loses coin precision in its text field. */
export function sellPresetAtoms(value: string, coin: SpendCoin): bigint {
  if (value === "max") return coin.atoms;
  const [whole = "0", fraction = ""] = value.split(".");
  const bps = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return coin.atoms * bps / 10_000n;
}

export function sellPresetAmount(value: string, coin: SpendCoin): TradeAmount {
  const atoms = sellPresetAtoms(value, coin);
  return { typed: value === "max" ? atomsToField(atoms, coin.decimals) : groupDigits(exactText({ n: atoms, scale: coin.decimals })), mode: value === "max" ? "all" : "typed", unit: "token" };
}

export function balanceModeAtoms(mode: Exclude<TradeAmount["mode"], "typed">, balance: bigint | null): bigint | null {
  if (balance === null) return null;
  return balance / match(mode).with("quarter", () => 4n).with("half", () => 2n).with("all", () => 1n).exhaustive();
}

export function tokenAmountAtoms(amount: TradeAmount, coin: SpendCoin): bigint | null {
  if (amount.mode === "typed") return parseAtoms(amount.typed, coin.decimals);
  return amount.fixedAtoms ?? balanceModeAtoms(amount.mode, coin.atoms);
}

export function selectedSellPreset(amount: TradeAmount, coin: SpendCoin): SellPreset | null {
  if (amount.mode === "all") return amount.fixedAtoms === undefined || amount.fixedAtoms === coin.atoms ? "max" : null;
  const atoms = tokenAmountAtoms(amount, coin);
  return SELL_PRESETS.find(([value]) => value !== "max" && atoms !== null && atoms > 0n && atoms === tokenAmountAtoms(sellPresetAmount(value, coin), coin))?.[0] ?? null;
}

const isBase = (coinType: string) => coinType === USDC_COIN_TYPE || coinType === SUI_COIN_TYPE;
export function tradeSide(inType: string, outType: string): SocialTradeSide {
  if (isBase(inType) !== isBase(outType)) return isBase(inType) ? "buy" : "sell";
  if (isBase(inType)) return inType === USDC_COIN_TYPE ? "buy" : "sell";
  return "buy";
}

export type TradeTicketCta = Readonly<{
  label: string;
  enabled: boolean;
  action: "trade" | "sign-in" | null;
  busy: boolean;
  reason?: string;
  quoting?: true;
}>;

type CtaCopy = Readonly<{
  label: string;
  quotedLabel: string;
  busyLabel: string;
  signIn: Readonly<{ label: string; reason?: string }>;
  emptyReason?: string;
  walletReason: string;
  insufficient: (gas: boolean) => Readonly<{ label?: string; reason?: string }>;
  unavailable: (reason: NonNullable<NonNullable<TradeQuoteSnapshot["quote"]>["unavailable_reason"]>) => string | undefined;
}>;

/** Every trade surface uses this order before enabling a money action. Copy stays with its presentation. */
export function tradeTicketCta(input: Readonly<{
  signedIn: boolean;
  sessionPending?: boolean;
  balanceKnown?: boolean;
  busy?: boolean;
  failed?: boolean;
  amount: bigint | null;
  overBalance: boolean;
  snapshot: TradeQuoteSnapshot;
  nowMs: number;
  /** The quote is the browser's estimate: a priced one with no `quote_id` trades (the press seals it). */
  estimate?: boolean;
}>, copy: CtaCopy): TradeTicketCta {
  const off = (label = copy.label, reason?: string): TradeTicketCta => ({ label, enabled: false, action: null, busy: false, ...(reason ? { reason } : {}) });
  const signIn = (): TradeTicketCta => ({ ...copy.signIn, enabled: true, action: "sign-in", busy: false });
  if (input.sessionPending) return off("Restoring session…");
  if (!input.signedIn) return signIn();
  if (input.balanceKnown === false) return off(copy.label, "Your wallet could not load.");
  if (input.busy) return { ...off(copy.busyLabel), busy: true };
  if (input.failed) return off();
  if (input.amount === null || input.amount <= 0n) return off(copy.label, copy.emptyReason);
  if (input.overBalance) return { ...off(), ...copy.insufficient(false) };
  return quotedCta(input, copy, off, signIn);
}

/** The ticket's state from its quote, once the amount and balance allow a trade. */
function quotedCta(
  input: Readonly<{ snapshot: TradeQuoteSnapshot; nowMs: number; estimate?: boolean }>,
  copy: CtaCopy,
  off: (label?: string, reason?: string) => TradeTicketCta,
  signIn: () => TradeTicketCta,
): TradeTicketCta {
  const { quote, error, loading } = input.snapshot;
  if (quote === null) return error !== null && !loading ? off() : { ...off(), quoting: true };
  if (quote.unavailable_reason !== null) return off(copy.label, copy.unavailable(quote.unavailable_reason));
  const refused = match(quote.offer_refused)
    .with("insufficient_balance", () => ({ ...off(), ...copy.insufficient(quote.balance_failure?.reason === "gas") }))
    .with("sign_in", signIn)
    .with("account_required", "blast_wallet_missing", () => off(copy.label, copy.walletReason))
    .otherwise(() => null);
  if (refused !== null) return refused;
  // The browser's estimate stays live while the same amount is asked again: the press seals a fresh quote anyway.
  if (loading && input.estimate !== true) return off(copy.quotedLabel);
  // The browser's estimate has no `quote_id`: the press seals it.
  const tradable = (input.estimate === true && quote.quote_id === null) || isOffered(quote, input.nowMs);
  return tradable ? { label: copy.quotedLabel, enabled: true, action: "trade", busy: false } : off(copy.quotedLabel);
}
