import type { AllowlistProof } from "@interest-protocol/blast-sdk/presale";

import type { CommitBlocker } from "@blast/core/web/contracts/commit.ts";
import type { SocialWallet } from "@blast/core/web/contracts/coins.ts";
import type { CommitSale, CommitViewer } from "@blast/core/modules/social/commit/quote.ts";

import type { TradeQuoteRequester } from "../trades/trades-client.ts";
import type { walletCoinBalanceReader } from "../coins/use-wallet-coin-balance";
import type { WalletCoinView } from "../coins/coin-model";
import type { ContributionReceipt } from "./commit-receipt";
import type { CommitBlastInput } from "./CommitPanel";
import type { CommitPhase } from "./commit-flow";
import type { CommitQuoteSource } from "./commit-quote";
import type { CommitSaleRead } from "./commit-view";

/**
 * The commit dialog's host, offered to surfaces that commit **without** the
 * dialog: Blast mode's panel composer and quick blast (R3-54), and hold to
 * blast on every Blast button (R3-13).
 *
 * There is one commit module. The kit is not a second one: `send` is the
 * dialog's own blast (`CommitHost`'s `blastWith` → `runCommitFor` →
 * `runCommit`), so the blockers, the allowlist route, the intent registered
 * between the digest and the execute (T-024), the transaction-log facts it
 * carries (R3-27), the toast and the sounds are the dialog's, and the
 * refusals are `commit/quote.ts`'s over the facts `quotes` reads.
 *
 * `quotes` is the commit quote's reads (`commit-quote.ts`): one sale read plus
 * the viewer's side, cached for the sale read's own CDN lifetime, debounced,
 * one in flight.
 */

export type CommitFacts = Readonly<{
  /** The sale read (`GET /api/social/presales/{id}`), as the dialog validates it. */
  detail: CommitSaleRead;
  /** The sale in its own quote coin, or null for a quote coin the product holds no balance in. */
  sale: CommitSale | null;
  /** The viewer's balances, position and allowlist leaf. A visitor's is all zero. */
  viewer: CommitViewer;
  /** Why signing is off for this sale whatever the amount (the pay coin's own reason is added by the caller). */
  blockers: readonly CommitBlocker[];
  /** The wallet's leaf, for an allowlisted sale. */
  proof: AllowlistProof | null;
  /** The Blast wallet the commit would come from. Null for a visitor. */
  wallet: SocialWallet | null;
}>;

export type CommitSendResult =
  | Readonly<{ status: "sent"; digest: string }>
  | Readonly<{ status: "pending"; digest: string; message: string }>
  | Readonly<{ status: "refused"; message: string | null }>;

export type CommitKit = Readonly<{
  signedIn: boolean;
  /**
   * The coin a held blast pays with (Settings `commit_too_coin_type`): a coin
   * type, or null for each sale's own quote coin. `peek` is undefined while
   * unread; `read` answers from the settings read and throws when it fails.
   * Absent (a fixture's kit): each sale's own coin.
   */
  holdCoin?: Readonly<{ peek: () => string | null | undefined; read: () => Promise<string | null> }>;
  /** The shell's sign-in sheet. */
  signIn: () => void;
  /** Opens the wallet deposit address. */
  deposit: () => void;
  /** The commit quote's reads. */
  quotes: CommitQuoteSource<CommitFacts>;
  inputBalance?: ReturnType<typeof walletCoinBalanceReader>;
  /** Public metadata for a chosen payment type, separate from its balance. */
  paymentCoin?: Readonly<{
    peek(coinType: string): WalletCoinView | null;
    read(coinType: string): Promise<WalletCoinView | null>;
  }>;
  quotePayment: TradeQuoteRequester;
  /**
   * One commit, through the dialog's own flow. It toasts and plays its own
   * outcome; a refusal carries the flow's sentence (null for the blocked
   * wall, which the caller already shows).
   */
  send: (
    facts: CommitFacts,
    input: CommitBlastInput,
    options?: Readonly<{
      onPhase?: (phase: CommitPhase) => void;
      /** Updates the receipt on the surface that submitted the contribution. */
      onConfirmed?: (receipt: ContributionReceipt) => void;
      /**
       * The post this commit came through (R3-13: a held "Blast"): the
       * intent credits its entry (T-024; stored only if visible) and the
       * toast names its author. None for Blast mode's own commits.
       */
      source?: Readonly<{ entryId: string | null; through: string | null }>;
    }>,
  ) => Promise<CommitSendResult>;
}>;
