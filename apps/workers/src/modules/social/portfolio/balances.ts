import { z } from "zod";
import type { PortfolioBalanceCoin } from "@blast/core/modules/social/contracts/portfolio.ts";
import { PORTFOLIO_COIN_TYPES } from "@blast/core/modules/social/portfolio/read.ts";

/**
 * The fullnode read the portfolio needs: one coin's balance of one owner.
 * `SuiGrpcClient.core` has this shape; tests pass a stub.
 */
export interface PortfolioFullnode {
  getBalance(input: Readonly<{ owner: string; coinType: string; signal?: AbortSignal }>): Promise<
    Readonly<{ balance: Readonly<{ balance: string }> }>
  >;
}

/** How long all of one request's balance reads may take together. */
export const PORTFOLIO_FULLNODE_TIMEOUT_MS = 4_000;

const ATOMS = /^(0|[1-9][0-9]*)$/;

class FullnodeTimeout extends Error {
  constructor() {
    super("The fullnode did not answer in time.");
  }
}

/**
 * SUI and USDC of `wallets`, summed: one fullnode call per wallet per coin,
 * all under one deadline. Any failed, late or malformed answer rejects the
 * whole read, so a partial sum is never shown as the total.
 */
export async function readWalletBalances(
  fullnode: PortfolioFullnode,
  wallets: readonly string[],
  timeoutMs = PORTFOLIO_FULLNODE_TIMEOUT_MS,
): Promise<Readonly<Record<PortfolioBalanceCoin, string>>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new FullnodeTimeout());
    }, timeoutMs);
  });
  const sum = async (coin: PortfolioBalanceCoin): Promise<string> => {
    const answers = await Promise.all(
      wallets.map((owner) => fullnode.getBalance({ owner, coinType: PORTFOLIO_COIN_TYPES[coin], signal: controller.signal })),
    );
    let total = 0n;
    for (const answer of answers) {
      const atoms = answer?.balance?.balance;
      if (!z.string().regex(ATOMS).safeParse(atoms).success) throw new Error("The fullnode answered a malformed balance.");
      total += BigInt(atoms);
    }
    return total.toString();
  };
  try {
    const [sui, usdc] = await Promise.race([Promise.all([sum("sui"), sum("usdc")]), deadline]);
    return { sui, usdc };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** A current bounded source observation, never a historical checkpoint balance. */
export type PortfolioBalanceObservation = Readonly<{
  source: "bounded_fullnode";
  observedAtMs: number;
  balances: Readonly<Record<PortfolioBalanceCoin, string>>;
}>;

export async function observeWalletBalances(
  fullnode: PortfolioFullnode,
  wallets: readonly string[],
  timeoutMs = PORTFOLIO_FULLNODE_TIMEOUT_MS,
  now: () => number = Date.now,
): Promise<PortfolioBalanceObservation> {
  const balances = await readWalletBalances(fullnode, wallets, timeoutMs);
  const observedAtMs = now();
  if (!z.number().int().nonnegative().safeParse(observedAtMs).success) throw new Error("The balance observation time is invalid.");
  return { source: "bounded_fullnode", observedAtMs, balances };
}
