import { exactAtoms, groupedExact } from "@blast/core/web/exact-amount.ts";
import type { CommitSale } from "@blast/core/modules/social/commit/quote.ts";
import { COMMIT_COIN_DECIMALS } from "./commit-view";

export type ContributionReceipt = Readonly<{
  presaleId: string;
  symbol: string;
  amount: string;
  currency: string;
  digest: string;
  href: string | null;
}>;

export function contributionReceipt(sale: CommitSale, atoms: string, digest: string, href: string | null): ContributionReceipt {
  const decimals = sale.quoteDecimals ?? COMMIT_COIN_DECIMALS[sale.quoteCoin];
  const amount = exactAtoms(atoms, decimals);
  if (!amount) throw new Error("Confirmed contribution amount is invalid");
  return { presaleId: sale.presaleId, symbol: sale.symbol, amount: groupedExact(amount, decimals), currency: sale.quoteCoin, digest, href };
}
