// What a completed curve trade actually did, read from its checkpointed
// transaction: the configured launchpad's `Bought` or `Sold` event, decoded by
// the SDK. Nothing here trusts a digest alone.

import type { BlastDeployment } from "@interest-protocol/blast-sdk/deployments";
import { decodeLaunchpadEvent } from "@interest-protocol/blast-sdk/launchpad";
import type { ClientWithCoreApi } from "@mysten/sui/client";

import type { QuoteAsset } from "./quote-asset.ts";

import { describeError } from "../transaction/errors.ts";
import { atomsGrouped } from "@blast/core/web/format.ts";

export type CompletedTrade =
  /** `quoteIn` is `Bought.quote_in`: the SUI the curve kept, already net of `quoteRefund`. */
  | Readonly<{ kind: "Bought"; quoteIn: bigint; quoteRefund: bigint; memeOutNet: bigint }>
  | Readonly<{ kind: "Sold"; memeIn: bigint; quoteOutNet: bigint }>;

export type CompletedTradeRead = Readonly<{ status: "ok"; trade: CompletedTrade }> | Readonly<{ status: "unavailable"; message: string }>;

export async function readCompletedTrade(client: ClientWithCoreApi, deployment: BlastDeployment, digest: string): Promise<CompletedTradeRead> {
  try {
    const result = await client.core.getTransaction({ digest, include: { events: true, effects: true } });
    const transaction = result.Transaction;
    if (result.$kind !== "Transaction" || !transaction?.status.success) {
      return { status: "unavailable", message: "The transaction did not complete." };
    }
    for (const [eventIndex, event] of (transaction.events ?? []).entries()) {
      try {
        const decoded = decodeLaunchpadEvent(
          { ...event, checkpoint: transaction.checkpoint, transactionDigest: transaction.digest, eventIndex } as Parameters<typeof decodeLaunchpadEvent>[0],
          deployment.packages.launchpad,
        );
        if (decoded.kind === "Bought") {
          const { payload } = decoded;
          return {
            status: "ok",
            trade: { kind: "Bought", quoteIn: payload.quote_in, quoteRefund: payload.quote_refund, memeOutNet: payload.meme_out_net },
          };
        }
        if (decoded.kind === "Sold") {
          const { payload } = decoded;
          const fees = payload.protocol_quote_fee + payload.creator_quote_fee;
          return { status: "ok", trade: { kind: "Sold", memeIn: payload.meme_in_gross, quoteOutNet: payload.quote_out_gross - fees } };
        }
      } catch {
        // Another package's event, or another event: not a trade outcome.
      }
    }
    return { status: "unavailable", message: "The transaction has no completed trade event from this deployment." };
  } catch (error) {
    return { status: "unavailable", message: describeError(error) };
  }
}

export function completedTradeAmounts(trade: CompletedTrade, decimals: number, quoteDecimals: number) {
  return {
    meme: atomsGrouped(trade.kind === "Bought" ? trade.memeOutNet : trade.memeIn, decimals),
    quote: atomsGrouped(trade.kind === "Bought" ? trade.quoteIn : trade.quoteOutNet, quoteDecimals),
  };
}

/** What a completed trade did, in words, from its event. */
export function describeCompletedTrade(trade: CompletedTrade, symbol: string, decimals: number, quote: Pick<QuoteAsset, "decimals" | "symbol"> = { decimals: 9, symbol: "SUI" }): string {
  const amounts = completedTradeAmounts(trade, decimals, quote.decimals);
  return `${trade.kind} ${amounts.meme} ${symbol} for ${amounts.quote} ${quote.symbol}.`;
}

/** The toast for one completed curve trade: what its event said, or a plain confirmation when it could not be read. */
export function curveTradeToast(
  trade: CompletedTrade | "unavailable",
  curve: Readonly<{ symbol: string; decimals: number; quote: Pick<QuoteAsset, "decimals" | "symbol"> }>,
  explorerUrl: string | null,
): Readonly<{ title: string; options: Readonly<{ href?: string; link?: string }> }> {
  const title = trade === "unavailable"
    ? "Trade confirmed"
    : describeCompletedTrade(trade, curve.symbol, curve.decimals, curve.quote).replace(/\.$/, "");
  return { title, options: explorerUrl ? { href: explorerUrl, link: "View transaction" } : {} };
}
