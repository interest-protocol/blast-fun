import { settledAll } from "@blast/server/lib/settled-all.ts";
import { PresaleTransactions } from "@interest-protocol/blast-sdk/presale";
import { Transaction } from "@mysten/sui/transactions";

import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { TradeRouter } from "@blast/server/modules/social/trades/aggregator.ts";
import { dryRunVerdict, simulationBytes, type TradeChain } from "@blast/server/modules/social/trades/chain.ts";
import { readTradeCoins } from "@blast/server/modules/social/trades/coins.ts";
import { openTradeQuote } from "@blast/server/modules/social/trades/quote-token.ts";
import type { CommitTransactionInput } from "@blast/server/modules/social/commit/chain.ts";

export type CommitSwapDependencies = Readonly<{
  database: () => ReadableDatabase;
  router: () => TradeRouter;
  chain: () => TradeChain;
  quoteKey: () => Buffer;
  now?: () => number;
}>;

/** The sealed route funds one exact commitment; any better fill returns to the sender. */
export async function swapCommitTransaction(
  dependencies: CommitSwapDependencies,
  input: CommitTransactionInput & Readonly<{ quoteId: string; accountId: string; sender: string }>,
  signal?: AbortSignal,
): Promise<Transaction> {
  const quote = openTradeQuote(dependencies.quoteKey(), input.quoteId);
  const now = (dependencies.now ?? Date.now)();
  const router = dependencies.router();
  if (!quote || quote.accountId !== input.accountId || quote.sender !== input.sender ||
    quote.expiresAtMs <= now || quote.issuedAtMs > now ||
    quote.outCoin !== input.quoteType ||
    quote.minOut !== input.atoms || quote.minOut <= 0n || quote.blastFeeBps !== (router.fee?.bps ?? 0)) {
    throw new SocialRouteError("commit_unavailable", { extra: { reasons: ["swap_unavailable"] } });
  }
  const coins = await readTradeCoins(dependencies.database(), [quote.inCoin], now);
  if (!coins.has(quote.inCoin)) throw new SocialRouteError("commit_unavailable", { extra: { reasons: ["swap_unavailable"] } });
  const chain = dependencies.chain();
  if (await chain.balance(input.sender, quote.inCoin, signal) < quote.amountIn) {
    throw new SocialRouteError("insufficient_balance");
  }
  const tx = new Transaction();
  tx.setSender(input.sender);
  const payment = tx.coin({ type: quote.inCoin, balance: quote.amountIn, useGasCoin: false });
  const output = await router.appendSwap(tx, quote.route, payment, quote.slippageBps);
  const [commitment] = tx.splitCoins(output, [tx.pure.u64(input.atoms)]);
  const sdk = new PresaleTransactions(input.identity.presale);
  const common = {
    saleTokenType: input.saleToken, quoteType: input.quoteType,
    presale: { ...input.presale, mutable: true as const }, quoteIn: commitment,
  };
  const change = tx.add(input.uncapped ? sdk.call.commitUncapped(common) : input.allowlist
    ? sdk.call.commitAllowlisted({ ...common, allowlist: input.allowlist })
    : sdk.call.commitOpen(common));
  tx.transferObjects([output, change], input.recipient);
  const [kind, price] = await settledAll([
    tx.build({ client: chain.client, onlyTransactionKind: true }),
    chain.referenceGasPrice(signal),
  ]);
  const verdict = dryRunVerdict(await chain.simulate(simulationBytes({ kind, sender: input.sender, gasOwner: input.sender, price }), signal),
    { sender: input.sender, outCoin: input.quoteType, aggregatorPackage: quote.route.aggregatorPackage });
  if (verdict.status !== "passed") throw new SocialRouteError("commit_unavailable", { extra: { reasons: ["swap_unavailable"] } });
  return tx;
}
