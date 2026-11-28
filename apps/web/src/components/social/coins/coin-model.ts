import { parseAtoms } from "../trade/trade-ticket.ts";
import { isWholeSuiAddressInput } from "@blast/core/lib/sui/ids.ts";
import { coinDisplay } from "./coin-display";
import { coinPriority, coreCoin, curatedIdentity, PREFERRED_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { isSmallBalance } from "@blast/core/modules/social/portfolio/small-balance.ts";
import { atomsValue, multiple, px, qty, signPct, usd, usd0 } from "@blast/core/web/format.ts";
import type { SocialTransferFee, SocialWallet, SocialWalletCoin } from "@blast/core/web/contracts/coins.ts";
import { SUI_COIN_TYPE, USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import type { WalletActionDraft } from "./wallet-action-draft";

/**
 * The coins sheet's view model (canonical UI §14 and the live design's
 * "coins: pick one, then deposit, withdraw or trade it"): pure functions from
 * the wallet read to the strings the sheet renders, and the withdraw checks,
 * so every format and rule is tested once. Copy is the design's unless noted
 * (OA-13).
 */

/**
 * One screen of the sheet's stack: the wallet's `fund`, `dep`, `pick:withdraw`,
 * `coin:<key>`, `wd:<key>`, `trade:<key>`, R3-10's `all`
 * (every coin, favourites first), and R3-33's `pickt:in|out` (the token
 * picker for one side of a trade). A trade names the coin you sell (`key`)
 * and, when it is not the default, the one you get (`out`); opened from one
 * coin's Buy or Sell, it keeps that coin in focus (`focus`, OA-48), which
 * names the screen `Buy KSTL` or `Sell KSTL`.
 */
export type CoinScreen =
  | Readonly<{ kind: "pick"; mode: "withdraw" }>
  | Readonly<{ kind: "fund" }>
  | Readonly<{ kind: "dep" }>
  | Readonly<{ kind: "bridge" }>
  | Readonly<{ kind: "all" }>
  | Readonly<{ kind: "pickt"; side: "in" | "out" }>
  | Readonly<{ kind: "trade"; key: string; out?: string; focus?: string }>
  | Readonly<{ kind: "coin" | "wd"; key: string }>;

/** A navigation snapshot restored after OAuth, never a transaction input. */
export function parseCoinScreen(value: unknown): CoinScreen | null {
  if (!value || typeof value !== "object" || !("kind" in value)) return null;
  switch (value.kind) {
    case "all": return { kind: "all" };
    case "fund": return { kind: "fund" };
    case "dep": return { kind: "dep" };
    case "bridge": return { kind: "bridge" };
    case "pick":
      if (!("mode" in value)) return null;
      if (value.mode === "deposit") return { kind: "dep" };
      return value.mode === "withdraw" ? { kind: "pick", mode: "withdraw" } : null;
    case "pickt":
      return "side" in value && (value.side === "in" || value.side === "out") ? { kind: "pickt", side: value.side } : null;
    case "coin": case "wd": case "trade": return parseKeyedScreen(value, value.kind);
    default: return null;
  }
}

function parseKeyedScreen(value: object, kind: "coin" | "wd" | "trade"): CoinScreen | null {
  if (!("key" in value) || typeof value.key !== "string" || !value.key) return null;
  if (kind !== "trade") return { kind, key: value.key };
  if (("out" in value && typeof value.out !== "string") || ("focus" in value && typeof value.focus !== "string")) return null;
  return { kind: "trade", key: value.key, ...("out" in value ? { out: value.out as string } : {}), ...("focus" in value ? { focus: value.focus as string } : {}) };
}

/**
 * The coin key that opens the All-coins screen instead of one coin
 * (`openCoin("all")`). A real key is `usdc`, `sui` or a presale id (`0x…`),
 * so this one can never collide. The shell's action list
 * (`blast-ui/shell-actions.tsx`) has no `openAllCoins` and that file belongs
 * to another section, so the reserved key is how R3-10's "All coins N ›" row
 * and the collapsed column reach the sheet.
 */
export const ALL_COINS_KEY = "all";

export function coinDraftKey(kind: "open" | "trade", owner?: string): string {
  return owner ? `coins:page-${kind}:${owner}` : `coins:${kind}`;
}

export function parseSavedCoinScreen(screen: string | undefined): CoinScreen | null {
  if (!screen) return null;
  try { return parseCoinScreen(JSON.parse(screen)); }
  catch { return null; }
}

/** What the shell opens: `openDeposit()`, `openWithdraw()`, `openBridge()`, `openCoin(key)`, `openCoin("all")`. */
export function firstScreen(action: "deposit" | "withdraw" | "bridge" | "coin", key: string | null): CoinScreen {
  if (action === "deposit") return { kind: "dep" };
  if (action === "bridge") return { kind: "bridge" };
  if (action === "withdraw") return { kind: "pick", mode: "withdraw" };
  return key && key !== ALL_COINS_KEY ? { kind: "coin", key } : { kind: "all" };
}

/** The dialog's accessible name per screen (the design's `SCREEN_LABEL`). */
export const SCREEN_LABEL: Readonly<Record<CoinScreen["kind"], string>> = {
  pick: "Choose a coin",
  pickt: "Select a coin",
  all: "Your coins",
  coin: "Coin",
  fund: "Fund",
  dep: "Deposit",
  bridge: "Bridge to Sui",
  wd: "Withdraw",
  trade: "Trade",
};

/** A coin of the Blast wallet as the sheet shows it. */
export type WalletCoinView = Readonly<{
  /** `usdc`, `sui`, or the presale id of a sale coin. */
  key: string;
  coinType: string;
  symbol: string;
  name: string;
  decimals: number;
  /** False when amounts can only be shown in base units. */
  metadataAvailable?: boolean;
  atoms: bigint;
  /** Whole coins, for display. */
  amount: number;
  /** USD per coin, or null without a fresh price. */
  price: number | null;
  /** The balance in USD, or null without a price. */
  value: number | null;
  iconUrl: string | null;
  round: boolean;
  /** A sale coin's presale: where it trades and its multiple since the presale. */
  presale: Readonly<{ presaleId: string; venue: string; trading: boolean; inPresale?: boolean; quoteSymbol?: string; quoteType?: string; multiple: number | null }> | null;
}>;

export type CoinOpening = Readonly<{ screen: CoinScreen; coins?: readonly WalletCoinView[]; walletDraft?: WalletActionDraft }>;
export type WalletCoinCatalogPage = Readonly<{ coins: readonly WalletCoinView[]; nextCursor: string | null }>;

/** Public metadata, without a wallet balance, so a swap can be composed before sign-in. */
export const PUBLIC_BASE_COINS: readonly WalletCoinView[] = [
  { key: "usdc", coinType: USDC_COIN_TYPE, symbol: "USDC", name: "USD Coin", decimals: 6, atoms: 0n, amount: 0, price: 1, value: null, iconUrl: null, round: true, presale: null },
  { key: "sui", coinType: SUI_COIN_TYPE, symbol: "SUI", name: "Sui", decimals: 9, atoms: 0n, amount: 0, price: null, value: null, iconUrl: null, round: true, presale: null },
];

/** Preferred choices exist before holdings load; callers still distinguish unknown balances. */
export const PUBLIC_PREFERRED_COINS: readonly WalletCoinView[] = PREFERRED_COINS.map(coin => ({
  key: coin.symbol === "SUI" ? "sui" : coin.symbol === "USDC" ? "usdc" : coin.coinType,
  coinType: coin.coinType, symbol: coin.symbol, name: coin.name, decimals: coin.decimals,
  atoms: 0n, amount: 0, price: coin.symbol === "USDC" ? 1 : null, value: null,
  iconUrl: coin.logoUrl, round: true, presale: null,
}));

/** A coin type's own name when nothing else names it: `0x2::sui::SUI` → `SUI`, `0x…::lp::LP<A, B>` → `LP`. */
export function coinTypeName(coinType: string): string {
  return coinType.replace(/<.*$/s, "").split("::").at(-1) || "Coin";
}

export function withPreferredCoins(coins: readonly WalletCoinView[]): WalletCoinView[] {
  return [...new Map([...PUBLIC_PREFERRED_COINS.map(coin => ({ ...coin, value: 0 })), ...coins].map(coin => [coin.coinType, coin])).values()];
}

export function coinView(coin: SocialWalletCoin): WalletCoinView {
  const core = coreCoin(coin.coin_type);
  const fallback = coin.presale === null ? core : undefined;
  const decimals = coin.decimals ?? fallback?.decimals ?? null;
  const curated = curatedIdentity(coin.coin_type, coin.symbol, coin.decimals === null ? fallback?.name ?? coin.name : coin.name);
  const display = coinDisplay(coin.coin_type, curated.symbol, curated.name);
  const atoms = BigInt(coin.atoms);
  const key = coin.coin_type === USDC_COIN_TYPE ? "usdc" : coin.coin_type === SUI_COIN_TYPE ? "sui" : coin.presale ? coin.presale.presale_id : coin.coin_type;
  return {
    key,
    coinType: coin.coin_type,
    symbol: display.symbol,
    name: decimals === null ? `${display.name} (base units)` : display.name,
    decimals: decimals ?? 0,
    metadataAvailable: decimals !== null,
    atoms,
    amount: atomsValue(atoms, decimals ?? 0) ?? 0,
    price: coin.usd_price === null ? null : Number(coin.usd_price),
    value: coin.value_usd === null ? null : Number(coin.value_usd),
    iconUrl: coin.icon_url,
    round: key === "usdc" || key === "sui",
    presale: coin.presale
      ? {
        presaleId: coin.presale.presale_id,
        venue: coin.presale.venue,
        trading: coin.presale.trading,
        multiple: coin.presale.multiple === null ? null : Number(coin.presale.multiple),
      }
      : null,
  };
}

/** The wallet's coins, in the read's order (USDC, SUI, sale coins by value); empty without a read. */
export function walletCoinViews(wallet: SocialWallet | null): WalletCoinView[] {
  if (!wallet?.coins) return [];
  return [...new Map([...wallet.coins, ...(wallet.listing?.extra_coins ?? [])].map(coin => [coin.coin_type, coinView(coin)])).values()];
}

/**
 * An amount and its unit or ticker, joined by a no-break space so they never
 * wrap apart (`9.5M PIP`); a long ticker still breaks inside itself.
 */
export const amountWith = (amount: string, symbol: string) => `${amount}\u00a0${symbol}`;

/** `412.38 SUI`, `100 USDC` (the design's `coinAmt`). */
export function coinAmt(coin: Pick<WalletCoinView, "symbol">, amount: number): string {
  return amountWith(coinQuantity(amount), coin.symbol);
}

/**
 * The line under a coin's name in a list (the design's `coinSub`): the
 * amount, and the ticker only when the name is not already the ticker — so
 * USDC reads `860`, not `USDC · 860 USDC`, and Lumen reads `100,000 LUMN`.
 */
export function coinSub(coin: Pick<WalletCoinView, "symbol" | "name">, amount: number): string {
  return coin.name === coin.symbol ? coinQuantity(amount) : coinAmt(coin, amount);
}

/** A coin list's total in USD, or null while one of its coins has no fresh price. */
export function coinsValue(coins: readonly Pick<WalletCoinView, "value">[]): number | null {
  return coins.every((coin) => coin.value !== null) ? coins.reduce((total, coin) => total + (coin.value ?? 0), 0) : null;
}

/** "12 coins", "1 coin". */
export function coinCount(count: number): string {
  return `${count} ${count === 1 ? "coin" : "coins"}`;
}

/** A row's or a hero's dollar value: `$1,410`, or "—" without a price. */
export function coinValue(coin: WalletCoinView): string {
  return coin.value === null ? "—" : usd0(coin.value);
}

/** A coin's price line under its hero (the design's `price`); `today` is SUI's 24 h change when known (R3-20's price read). */
export type PriceLine =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "change"; before: string; strong: string; tone: "up" | "down"; after: string }>;

/**
 * A coin's dollar price as the gate's `px` writes it (`$3.42`, `$0.2109`,
 * `$0.000556`), a tiny price in the site's subscript form (`$0.0₆123`).
 */
export function priceText(value: number): string {
  return px(value);
}

/**
 * R3-33 (FEATURE-MAP-R3 §14.2): the line under the coin header's name has no
 * venue any more — `$0.42 · 4.2× since the presale`, `$3.42`,
 * `Always worth $1.00` — and says plainly when there is no price.
 */
export function coinPriceLine(coin: WalletCoinView, todayPct: number | null = null): PriceLine {
  if (coin.key === "usdc") return { kind: "text", text: "Always worth $1.00" };
  if (coin.presale !== null && !coin.presale.trading) return { kind: "text", text: "Not trading yet" };
  if (coin.price === null) return { kind: "text", text: "No price right now" };
  if (coin.presale === null) {
    return todayPct === null
      ? { kind: "text", text: priceText(coin.price) }
      : { kind: "change", before: `${priceText(coin.price)} · `, strong: signPct(todayPct), tone: todayPct >= 0 ? "up" : "down", after: " today" };
  }
  if (coin.presale.multiple === null) return { kind: "text", text: priceText(coin.price) };
  return {
    kind: "change",
    before: `${priceText(coin.price)} · `,
    strong: multiple(coin.presale.multiple),
    tone: coin.presale.multiple >= 1 ? "up" : "down",
    after: " since the presale",
  };
}

// ---------- amounts typed in the sheet ----------

/** A typed amount as a number, 0 when empty (the design's `numIn`). */
export function numIn(text: string): number {
  return Number.parseFloat(String(text).replace(/[^0-9.]/g, "")) || 0;
}

// ---------- withdraw ----------

/** What a wallet that pays its own fee keeps back when it sends all its SUI (0.02 SUI; a transfer costs about a tenth of it). */
export const SUI_FEE_RESERVE_ATOMS = 20_000_000n;

/** Sui's minimum gasless transfer is 0.01 native USDC (six decimals). */
export const USDC_MIN_WITHDRAW_ATOMS = 10_000n;

/** The most the sheet withdraws of `coin`: everything, unless the wallet pays its fee from the SUI it sends. */
export function maxWithdrawAtoms(coin: WalletCoinView, fee: SocialTransferFee): bigint {
  if (fee === "wallet" && coin.key === "sui") return coin.atoms > SUI_FEE_RESERVE_ATOMS ? coin.atoms - SUI_FEE_RESERVE_ATOMS : 0n;
  return coin.atoms;
}

/** A recipient as the transfer records it: trimmed and lowercase. */
export function canonicalRecipient(value: string): string {
  return String(value).trim().toLowerCase();
}

export const WITHDRAW_HINT = "Double-check it. Transfers can’t be reversed.";
/** The hint before the first keystroke (the same words; curly apostrophe, SH-7). */
export const WITHDRAW_HINT_INITIAL = "Double-check it. Transfers can’t be reversed.";
export const WITHDRAW_BAD_ADDRESS = "Enter a full Sui address or a SuiNS name.";
/** OA-13: the Blast wallet itself as the recipient. */
export const WITHDRAW_OWN_ADDRESS = "That’s your Blast wallet. Send to another address.";

export type WithdrawCheck = Readonly<{
  ready: boolean;
  /** The button's text. */
  label: string;
  /** The line under the address, and whether it is an error. */
  message: string;
  bad: boolean;
  recipientValid: boolean;
  /** The amount box's left foot: `USDC`, or `≈ $12.34`. */
  value: string;
  atoms: bigint | null;
}>;

/**
 * The withdraw screen's state (the design's `wdCheck`): the button reads
 * "Enter an amount", "More than you have", "Enter an address", "Check the
 * address" or "Withdraw 100 USDC". OA-13: sending to the Blast wallet itself
 * is refused; native USDC is gasless with a 0.01 minimum, other coins need gas.
 */
export function withdrawCheck(input: Readonly<{
  coin: WalletCoinView;
  amountText: string;
  to: string;
  touched: boolean;
  fee: SocialTransferFee;
  /** The Blast wallet's address (never a recipient). */
  own: string | null;
  /** The wallet's SUI, for a wallet that pays its own fee. */
  suiAtoms: bigint;
}>): WithdrawCheck {
  const { coin, fee } = input;
  const atoms = parseAtoms(input.amountText, coin.decimals);
  const v = numIn(input.amountText);
  const address = input.to.trim();
  const ok = isWholeSuiAddressInput(address);
  const own = ok && input.own !== null && canonicalRecipient(address) === input.own;
  const bad = (address !== "" && !ok) || own;
  const message = own ? WITHDRAW_OWN_ADDRESS : bad ? WITHDRAW_BAD_ADDRESS : input.touched ? WITHDRAW_HINT : WITHDRAW_HINT_INITIAL;
  const value = coin.key === "usdc" ? "USDC" : coin.price === null ? "≈ —" : `≈ ${usd(v * coin.price, 2)}`;
  const tooMuch = atoms !== null && atoms > maxWithdrawAtoms(coin, fee);
  const needsFee = coin.coinType !== USDC_COIN_TYPE && fee === "wallet" && input.suiAtoms < SUI_FEE_RESERVE_ATOMS / 4n;
  const minimum = coin.coinType === USDC_COIN_TYPE ? USDC_MIN_WITHDRAW_ATOMS : 1n;
  const prompt = withdrawPrompt(atoms, tooMuch, address, ok && !own, needsFee, minimum);
  return { ready: prompt === null, label: prompt ?? `Withdraw ${coinAmt(coin, v)}`, message, bad, recipientValid: ok, value, atoms };
}

function withdrawPrompt(atoms: bigint | null, tooMuch: boolean, address: string, valid: boolean, needsFee: boolean, minimum: bigint): string | null {
  if (!atoms) return "Enter an amount";
  if (tooMuch) return "More than you have";
  if (atoms < minimum) return "Minimum withdrawal is 0.01 USDC";
  if (!address) return "Enter an address";
  if (!valid) return "Check the address";
  if (needsFee) return "Add SUI for the network fee";
  return null;
}

export const EMPTY_COIN_BROWSER: Readonly<{ search: string; page: number }> = { search: "", page: 1 };

export function visibleHoldings(coins: readonly WalletCoinView[], search: string, hideSmall: boolean) {
  const term = search.trim().toLowerCase();
  return coins.filter(coin => (!hideSmall || !isSmallBalance(coin.atoms, coin.metadataAvailable === false ? null : coin.decimals, coin.coinType)) && [coin.name, coin.symbol, coin.coinType, coreCoin(coin.coinType)?.symbol ?? ""].some(text => text.toLowerCase().includes(term)))
    .sort(compareHoldings);
}

/** USD value descending, unpriced last; preferred/core identity then coin type break ties. */
export function compareHoldings(a: WalletCoinView, b: WalletCoinView): number {
  return (b.value ?? -1) - (a.value ?? -1) || coinPriority(a.coinType) - coinPriority(b.coinType) || a.coinType.localeCompare(b.coinType);
}

export function coinQuantity(amount: number): string {
  return amount > 0 && amount < 0.01 ? amount < 0.0001 ? "<0.0001" : amount.toLocaleString("en-US", { maximumFractionDigits: 4 }) : qty(amount);
}
