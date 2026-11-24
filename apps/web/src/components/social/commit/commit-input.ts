import { atomsText, atomsValue } from "@blast/core/web/format.ts";
import { capLabel, minimumLabel, payBalance, USED_ALLOCATION_MESSAGE, type CommitInput, type CommitRefusal } from "@blast/core/modules/social/commit/quote.ts";

import { walletCoinViews, type WalletCoinView } from "../coins/coin-model";
import type { CommitFacts } from "./commit-kit";
import { commitQuoteUsd } from "./commit-view";
import { payWithOf, saleQuoteCoin } from "./commit-payment";

export const HOLD_COIN_NOT_HELD = "Your hold pays with a coin this wallet doesn’t hold. Pick another coin in Settings.";
export const HOLD_COIN_NO_PRICE = "Pick a coin with a price, or use the commit window.";
export const HOLD_VALUE_UNKNOWN = "This sale’s coin has no dollar price, so the hold can’t check what it commits. Use the commit window to see the route.";
export const HOLD_COIN_PRICE_OFF = "This coin’s price looks off, so the hold wouldn’t commit what you asked. Use the commit window to see the route.";

function heldAlternative(coins: readonly WalletCoinView[], coinType: string, exact: bigint | undefined, metadata: WalletCoinView | undefined) {
  if (exact === 0n) return { refusal: HOLD_COIN_NOT_HELD };
  const coin = metadata ?? coins.find((held) => held.coinType === coinType && (exact ?? held.atoms) > 0n);
  if (!coin) return { refusal: exact === undefined ? HOLD_COIN_NOT_HELD : HOLD_COIN_NO_PRICE };
  const amount = exact === undefined ? coin.amount : atomsValue(exact, coin.decimals) ?? 0;
  return { coin: exact === undefined ? coin : { ...coin, atoms: exact, amount }, usd: usdOf(coin.price), amount };
}

/**
 * The coin a held blast pays with: the account's choice (`coinType`, from
 * Settings), or the sale's own quote coin when it chose none. Never another
 * coin: a choice this wallet does not hold is a refusal.
 */
export function quickPayCoin(facts: CommitFacts, coinType: string | null, exact?: bigint, metadata?: WalletCoinView): Readonly<{ coin: WalletCoinView; usd: number | null; amount: number }> | Readonly<{ refusal: string }> | null {
  const sale = facts.sale;
  if (sale === null) return null;
  const coins = walletCoinViews(facts.wallet);
  const quote = saleQuoteCoin(sale, coins);
  if (coinType !== null && coinType !== quote.coinType) {
    if (exact === undefined && facts.wallet?.coins == null) return null;
    return heldAlternative(coins, coinType, exact, metadata);
  }
  // The sale's own coin: the balance and price the commit rules check (`payBalance`).
  const viewer = facts.viewer;
  const price = commitQuoteUsd(sale, viewer);
  const amount = exact === undefined ? payBalance({ viewer, payWith: sale.quoteCoin }).coin : atomsValue(exact, quote.decimals) ?? 0;
  return { coin: exact === undefined ? quote : { ...quote, atoms: exact, amount }, usd: usdOf(price ?? metadata?.price ?? quote.price), amount };
}

const usdOf = (price: number | null | undefined) => (price != null && Number.isFinite(price) && price > 0 ? price : null);

/** The dollars the hold's coin covers, for the ladder; null while it cannot say (the release then gives the reason). */
export function quickAvailableUsd(facts: CommitFacts, coinType: string | null, exact?: bigint, metadata?: WalletCoinView): number | null {
  const pay = quickPayCoin(facts, coinType, exact, metadata);
  if (pay === null || "refusal" in pay || pay.usd === null) return null;
  return pay.amount * pay.usd;
}

/**
 * A held blast's commitment as the shared rules read it: `amountUsd` in the
 * hold's coin at that coin's USD price, with no why. The quote coin pays
 * directly; any other coin is swapped into it in the same transaction.
 */
export function quickInput(facts: CommitFacts, amountUsd: number, nowMs: number, coinType: string | null, exact?: bigint, metadata?: WalletCoinView): Readonly<{ input: CommitInput; coin: WalletCoinView }> | Readonly<{ refusal: string }> | null {
  const pay = quickPayCoin(facts, coinType, exact, metadata);
  if (pay === null || "refusal" in pay) return pay;
  if (pay.usd === null) return { refusal: HOLD_COIN_NO_PRICE };
  const { coin } = pay;
  const atoms = amountUsd > 0 ? BigInt(Math.round((amountUsd / pay.usd) * 10 ** coin.decimals)) : 0n;
  if (exact !== undefined && atoms > exact) return { refusal: "Not enough to cover it" };
  const sale = facts.sale!;
  return {
    coin,
    input: {
      sale,
      viewer: exact !== undefined && coin.coinType === saleQuoteCoin(sale).coinType
        ? { ...facts.viewer, quoteCoin: sale.quoteCoin, quoteBalance: pay.amount, quoteUsd: pay.usd }
        : facts.viewer,
      payWith: payWithOf(sale, coin),
      typed: atoms > 0n ? atomsText(atoms, coin.decimals) : "",
      why: "",
      whyError: null,
      blockers: facts.blockers,
      nowMs,
    },
  };
}

/**
 * The refusal found when the quote is read again at the press, in the gate's
 * words (OA-23 `bxFail`), verbatim. Nothing is sent.
 */
export function commitErrorText(refusal: CommitRefusal | "unreadable", input: CommitInput | null): string {
  if (input === null) return "That didn’t go through";
  switch (refusal) {
    case "closed":
      return `${input.sale.name} isn't taking commitments`;
    case "min":
    case "empty": {
      const minimum = minimumLabel(input);
      return minimum === null ? "That didn’t go through" : `The minimum is ${minimum}`;
    }
    case "allocation_used":
      return USED_ALLOCATION_MESSAGE;
    case "cap": {
      const cap = capLabel(input);
      return cap === null ? "That didn’t go through" : `The most one wallet can put in is ${cap}`;
    }
    case "insufficient":
      return "Not enough to cover it";
    default:
      return "That didn’t go through";
  }
}
