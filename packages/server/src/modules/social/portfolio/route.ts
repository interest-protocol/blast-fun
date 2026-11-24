import { z } from "zod";
import type { PublicVesting } from "@blast/core/modules/vesting/model.ts";

import { socialInput } from "@blast/server/modules/social/route-kit/validation.ts";
import { readPortfolioCoinPage } from "@blast/server/modules/social/portfolio/coin-page.ts";
import { summarizePortfolio } from "@blast/server/modules/social/portfolio/summary.ts";
import { recordMetric } from "@blast/core/lib/metrics.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import {
  NO_COST_BASIS,
  PORTFOLIO_PARTS,
  SOCIAL_PORTFOLIO_ROUTE,
  type PortfolioPart,
  type SocialPortfolio,
} from "@blast/core/modules/social/contracts/portfolio.ts";
import type { SocialAccountWalletLister } from "@blast/server/modules/social/accounts/me-route.ts";
import type { SocialCaller, SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { costBasisFiguresOf, readCostBasisLedgerOrNull } from "@blast/server/modules/social/portfolio/cost-basis.ts";
import { readPortfolioVesting } from "@blast/server/modules/social/portfolio/holdings.ts";
import { readWalletHoldings, walletCash, walletHoldingExactValue, walletHoldingValue } from "@blast/server/modules/social/portfolio/wallet-holdings.ts";
import { PORTFOLIO_COIN_TYPES } from "@blast/core/modules/social/portfolio/read.ts";
import { valueCommitments } from "@blast/server/modules/social/portfolio/position-value.ts";
import { pricedBalances, readPortfolioPositions, readPortfolioPrices, readPortfolioTotals } from "@blast/core/modules/social/portfolio/read.ts";
import { portfolioHistoryRange, readPortfolioHistory, readPortfolioTrend } from "@blast/server/modules/social/portfolio/trend.ts";
import { SOCIAL_PORTFOLIO_HISTORY_ROUTE } from "@blast/core/modules/social/contracts/portfolio.ts";

export type SocialPortfolioRouteDependencies = Readonly<{
  kit: SocialRouteKit;
  /** The caller's wallets (`social_wallet_owners`), on the primary. */
  wallets: SocialAccountWalletLister;
  /** The primary in production (`socialPortfolioDatabase`). Resolved per request. */
  database: () => ReadableDatabase;
  now?: () => number;
  /** The same active-wallet read as /me/vesting; omitted for legacy fixture adapters. */
  walletVestings?: (caller: SocialCaller) => Promise<readonly PublicVesting[]>;
}>;

/**
 * A part that may be missing on its own (T-020: the wallet coins and the
 * vesting link read views blast-infra may not publish yet): its value, or
 * null when the read fails, which the answer lists in `unavailable`.
 */
async function optionalPart<T>(part: PortfolioPart, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    recordMetric("social.portfolio", { part, outcome: "unavailable" });
    return null;
  }
}

/** The owner and opt-in public routes share indexed holdings, valuation and cost basis. */
export async function assemblePortfolio(
  input: Readonly<{
    db: ReadableDatabase;
    accountId: string;
    addresses: readonly string[];
    now: () => number;
    /**
     * A public portfolio's `portfolio_public_since` (OA-10): its trend shows only the days since it became
     * public. Omitted for the owner's own view, which shows the whole history.
     */
    trendPublicSinceMs?: number | null;
    view?: "full" | "summary";
    /** Owner-only utility schedule visibility; the public read has no active caller. */
    utilityVestings?: () => Promise<readonly PublicVesting[]>;
  }>,
): Promise<SocialPortfolio> {
  const { db, accountId, addresses, now } = input;
  const nowMs = now();
  const positionsRead = readPortfolioPositions(db, addresses, nowMs);
  const ledgerRead = input.view === "summary"
    ? positionsRead.then((positions) => readCostBasisLedgerOrNull(db, addresses, positions.map((position) => position.presale_id)))
    : readCostBasisLedgerOrNull(db, addresses);
  const [wallet, prices, positions, totals, vesting, ledger, trend] = await Promise.all([
    optionalPart("coins", () => readWalletHoldings(db, addresses)),
    readPortfolioPrices(db),
    positionsRead,
    readPortfolioTotals(db, accountId),
    optionalPart("vesting", () => readPortfolioVesting(db, addresses, input.utilityVestings)),
    ledgerRead,
    optionalPart("trend", () => readPortfolioTrend(db, accountId, nowMs, input.trendPublicSinceMs ?? null)),
  ]);
  const atoms = wallet ? walletCash(wallet) : null;
  const holdings = wallet?.holdings.filter((coin) => coin.coin_type !== PORTFOLIO_COIN_TYPES.sui && coin.coin_type !== PORTFOLIO_COIN_TYPES.usdc) ?? null;
  const valuedAt = now();
  const priced = atoms ? pricedBalances(atoms, prices, valuedAt) : null;
  const coinTimes = (holdings ?? []).flatMap((coin) => coin.price && walletHoldingValue(coin, valuedAt) !== null ? [coin.price.as_of_ms] : []);
  const coinsAsOf = coinTimes.length ? Math.min(...coinTimes) : null;
  // R3-40: every quote's commitments in dollars (SUI at its price), the snapshot's exact rule.
  const valued = valueCommitments(positions, prices, valuedAt);
  const asOf = [priced?.pricesAsOfMs ?? null, coinsAsOf, valued.pricesAsOfMs].filter((value): value is number => value !== null);
  const saleHoldings = holdings?.flatMap((coin) => coin.presale_id && coin.decimals !== null ? [{ ...coin, presale_id: coin.presale_id, decimals: coin.decimals }] : []) ?? null;
  const basisOf = costBasisFiguresOf(ledger, saleHoldings, valuedAt);
  const coins = holdings?.map((coin) => ({
    coin_type: coin.coin_type, symbol: coin.symbol, name: coin.name, decimals: coin.decimals,
    icon_url: coin.icon_url, presale_id: coin.presale_id, ...(coin.verified_team ? { verified_team: true } : {}), balance: coin.balance,
    value_usd: walletHoldingValue(coin, valuedAt),
    value_usd_exact: walletHoldingExactValue(coin, valuedAt),
    ...(input.view === "summary" ? NO_COST_BASIS : coin.presale_id ? basisOf(coin.presale_id) : { basis_usd: null, basis_complete: false, pnl_usd: null, pnl_multiple: null }),
  })) ?? null;
  if (input.view !== "summary") coins?.sort((a, b) => Number(b.value_usd ?? -1) - Number(a.value_usd ?? -1) || a.coin_type.localeCompare(b.coin_type));
  const parts = {
    balances: priced?.balances ?? null,
    positions: positions.map((position) => ({
      presale_id: position.presale_id,
      symbol: position.symbol,
      commitment: position.commitment,
      status: position.status,
      claimed_tokens: position.claimed_tokens,
      claimed_quote_refund: position.claimed_quote_refund,
      quote_symbol: position.quote_symbol,
      quote_decimals: position.quote_decimals,
      sale_decimals: position.sale_decimals,
      ...basisOf(position.presale_id),
    })),
    coins,
    vesting,
    totals,
    trend,
  } satisfies Record<PortfolioPart, unknown>;
  const portfolio: SocialPortfolio = {
    ...parts,
    wallet_sync: wallet?.sync ?? { status: "stale", checkpoint: null, as_of_ms: null },
    commitments: valued.commitments,
    prices_as_of_ms: asOf.length ? Math.min(...asOf) : null,
    unavailable: PORTFOLIO_PARTS.filter((part) => parts[part] === null),
  };
  return input.view === "summary" ? summarizePortfolio(db, portfolio, now()) : portfolio;
}

/** Verified account wallets only; the primary supplies all portfolio data. */
export function createSocialPortfolioRoute(dependencies: SocialPortfolioRouteDependencies) {
  const { kit, wallets, database, walletVestings } = dependencies;
  const now = dependencies.now ?? Date.now;

  return Object.freeze({
    COINS: kit.route(
      { name: "GET /api/social/me/portfolio/coins", auth: "account", account: "required", bucket: "social_read", cache: "private" },
      async (context) => {
        if (!context.account) throw new TypeError("The kit loads the account of a required-account route.");
        const params = new URL(context.request.url).searchParams;
        const { page, search, hideSmall } = socialInput(z.object({
          page: z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.number().int().safe().max(2_147_483_647)),
          search: z.string().trim().max(200),
          hideSmall: z.enum(["true", "false"]).transform((value) => value === "true"),
        }), {
          page: params.get("page") ?? "1", search: params.get("q") ?? "", hideSmall: params.get("hide_small") ?? "false",
        }, "invalid_parameter");
        const addresses = (await wallets.wallets(context.account.account_id)).map((wallet) => wallet.address);
        return context.json(await readPortfolioCoinPage(database(), addresses, page, search, now(), hideSmall));
      },
    ),
    HISTORY: kit.route(
      { name: SOCIAL_PORTFOLIO_HISTORY_ROUTE, auth: "account", account: "required", bucket: "social_read", cache: "private" },
      async (context) => {
        if (!context.account) throw new TypeError("The kit loads the account of a required-account route.");
        const range = portfolioHistoryRange(new URL(context.request.url).searchParams);
        return context.json(await readPortfolioHistory(database(), context.account.account_id, now(), range));
      },
    ),
    GET: kit.route(
      { name: SOCIAL_PORTFOLIO_ROUTE, auth: "account", account: "required", bucket: "social_read", cache: "private" },
      async (context) => {
        const account = context.account;
        if (!account) throw new TypeError("The kit loads the account of a required-account route.");
        const addresses = (await wallets.wallets(account.account_id)).map((wallet) => wallet.address);
        const db = database();
        const body: SocialPortfolio = await assemblePortfolio({
          db,
          accountId: account.account_id,
          addresses,
          now,
          utilityVestings: walletVestings ? () => walletVestings(context.caller!) : undefined,
          view: new URL(context.request.url).searchParams.get("view") === "summary" ? "summary" : "full",
        });
        return context.json(body);
      },
    ),
  });
}
