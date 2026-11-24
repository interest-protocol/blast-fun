import type { SocialWallet } from "@blast/core/web/contracts/coins.ts";
import type { SocialTradeQuote, SocialTradeQuoteRequest, TradeFeeRequired } from "@blast/core/web/contracts/trades.ts";

import type { TradePhase } from "../trades/trade-flow";
import type { TradeRouteFinder } from "./trade-estimate";
import type { TradeQuoteAnswer } from "./trade-quotes";

/**
 * The shell's one trade module (R3-31's execution, R3-30's quote), offered to
 * every surface that trades — Blast mode's composer (R3-55), the coins
 * sheet's swap (R3-33), the sale page's bar (R3-34), the dock's `Sell` (R3-58)
 * — as the commit dialog's host offers its kit to the commit surfaces
 * (`commit/commit-kit.ts`). Provided by `useTradeHost` (`TradeHost.tsx`)
 * through `FeedOverlays.tradeKit`, read with `useTradeKit()`.
 *
 * There is one trade path: `send` is `runTrade` (`trades/trade-flow.ts`) with
 * the Blast wallet's signer — Privy's embedded key or a wallet session's
 * Slush, both sponsored by Blast within the day's cap (owner ruling
 * 2026-11-20, reversing OA-17) — and it toasts, sounds and moves the balances itself, so a
 * surface only renders. Nothing here quotes a number: the quote is the
 * route's, and `send` submits the quote's own `amount_in` and `min_out`, so the
 * fill is checked against the quote the person saw.
 */

/** A coin as a trade's words name it: its symbol, and the places its atoms carry. */
export type TradeCoin = Readonly<{ symbol: string; decimals: number; iconUrl?: string | null }>;

export type TradeCoins = Readonly<{ in: TradeCoin; out: TradeCoin }>;

export type TradeSendInput = Readonly<{
  /** An offered quote (`quote_id` set and not expired): what is executed, exactly. */
  quote: SocialTradeQuote;
  coins: TradeCoins;
  /** The signer whose exact input balance the form checked. */
  walletAddress?: string;
  /** Pay the network fee from the wallet's SUI, after `fee_required` was shown and accepted. */
  acceptFee?: boolean;
  /** The surface's own key for this trade (the coins sheet keeps one per quote, so a second press is the same trade); a fresh one by default. */
  idempotencyKey?: string;
  onPhase?: (phase: TradePhase) => void;
}>;

export type TradeSendResult =
  /** Filled: the toast is up; `title` is its words, for the surface's live region. */
  | Readonly<{ status: "traded"; title: string }>
  /** Sent, and the chain does not show it yet: the transaction log settles it. */
  | Readonly<{ status: "pending"; title: string }>
  /** Blast will not pay this fee today: show it, and send again with `acceptFee`. Nothing was recorded. */
  | TradeFeeRequired
  /** Nothing filled. `code` is the published one (`insufficient_balance`, `price_moved`, …) or null. */
  | Readonly<{ status: "refused"; code: string | null; message: string }>;

export type TradeKit = Readonly<{
  signedIn: boolean;
  /** The shell's sign-in sheet. */
  signIn: () => void;
  /** One quote (`POST /api/social/trades/quote`). A visitor's is shown, never offered. `signal` stops one nobody wants any more. */
  quote: (request: SocialTradeQuoteRequest, signal?: AbortSignal) => Promise<TradeQuoteAnswer>;
  /** Cetus's aggregator asked from the browser, for the estimate shown while typing (`trade-estimate.ts`); absent in tests, where the estimate is `quote`'s, shown only. */
  route?: TradeRouteFinder;
  /** The Blast wallet (`GET /api/social/me/wallet`), shared for a few seconds; null for a visitor or a failed read. */
  wallet: () => Promise<SocialWallet | null>;
  /** One trade, through the one trade path. */
  send: (input: TradeSendInput) => Promise<TradeSendResult>;
}>;
