import { socialInput } from "@blast/server/modules/social/route-kit/validation.ts";

import { recordMetric } from "@blast/core/lib/metrics.ts";
import {
  socialTradeQuoteInputSchema,
  SOCIAL_TRADE_COINS_ROUTE,
  SOCIAL_TRADE_DEFAULT_SLIPPAGE_BPS,
  SOCIAL_TRADE_QUOTE_ROUTE,
} from "@blast/core/modules/social/contracts/trades.ts";
import { chainViewsOnly } from "@blast/core/modules/social/presales/sql.ts";
import { readSocialJson, type SocialCaller, type SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { parseTradeCoinListQuery, readTradeCoinPage } from "@blast/server/modules/social/trades/coin-list.ts";
import { observeQuoteStage } from "@blast/server/modules/social/trades/quote-metrics.ts";
import { quoteTrade, type TradeQuoteDependencies, type TradeQuoteInput } from "@blast/server/modules/social/trades/quote.ts";

export type SocialTradeRoutesDependencies = TradeQuoteDependencies & Readonly<{
  kit: SocialRouteKit;
  /**
   * The caller's Blast wallet: a Privy session's embedded Sui wallet (null
   * while it does not exist), a wallet session's own address.
   */
  blastWallet: (caller: SocialCaller) => Promise<string | null>;
}>;

/**
 * The closed quote body (contract in `contracts/trades.ts`): canonical coin
 * types that differ, a side that agrees with them (spending USDC or SUI on a
 * sale coin is a buy, the reverse a sell; between USDC and SUI, or two sale
 * coins, either), exactly one positive u64 amount, and a slippage of 1 to
 * 500 basis points (50 by default).
 */
export function parseTradeQuoteBody(body: Readonly<Record<string, unknown>>): TradeQuoteInput {
  const parsed = socialInput(socialTradeQuoteInputSchema, body);
  return {
    inCoin: parsed.in_coin,
    outCoin: parsed.out_coin,
    side: parsed.side,
    amountIn: parsed.amount_in === undefined ? null : BigInt(parsed.amount_in),
    amountOut: parsed.amount_out === undefined ? null : BigInt(parsed.amount_out),
    slippageBps: parsed.slippage_bps ?? SOCIAL_TRADE_DEFAULT_SLIPPAGE_BPS,
  };
}

/**
 * The trade routes (contract in `contracts/trades.ts`).
 *
 * `quote.POST` (R3-30): no account required — a signed-out visitor sees a
 * price — bucket `social_read_quote` per IP and, signed in,
 * `social_trade_quote` per account, signed out `social_trade_quote_anon`
 * (a tight per-IP budget, WP3); `private, no-store` (a signed-in quote names the caller's own
 * wallet and is bound to it). The closed body, then `quoteTrade`. Each bucket
 * counts a quote once, whatever it runs: a sale coin's dry-run quote also
 * simulates its reference size (OA-29), and that second simulation is part of
 * the one quote the caller asked for, not a second one.
 */
export function createSocialTradeRoutes(dependencies: SocialTradeRoutesDependencies) {
  const { kit, blastWallet } = dependencies;
  const now = dependencies.now ?? Date.now;
  return Object.freeze({
    /**
     * `coins.GET` (R3-33): the sale coins a trade can name, by ticker, one
     * keyset page, a search's first page led by the ecosystem coins it names; public and CDN-cached (it reads nothing of the caller),
     * bucket `social_read_trade_coins` per IP, on the replica.
     */
    coins: Object.freeze({
      GET: kit.route({ name: SOCIAL_TRADE_COINS_ROUTE, auth: "none", bucket: "social_read_trade_coins", cache: "public" }, async (context) => {
        const started = performance.now();
        const query = parseTradeCoinListQuery(new URL(context.request.url));
        const page = await readTradeCoinPage(chainViewsOnly(dependencies.database()), query, now());
        recordMetric("social.trade_coins", {
          search: query.q === null ? "none" : "q",
          paged: query.cursor === null ? "first" : "next",
          coins: page.coins.length,
          ms: Math.round(performance.now() - started),
        });
        return context.json(page);
      }),
    }),
    quote: Object.freeze({
      POST: kit.route(
        { name: SOCIAL_TRADE_QUOTE_ROUTE, auth: "optional", account: "resolve", bucket: "social_read_quote", cache: "private" },
        async (context) => {
          // The route kit’s IP bucket and caller/account resolution already ran before this handler.
          await observeQuoteStage("durable_quota", () => context.consume(context.caller ? "social_trade_quote" : "social_trade_quote_anon"));
          const { input, caller, wallet } = await observeQuoteStage("body_wallet_preparation", async () => {
            const input = parseTradeQuoteBody(
              await readSocialJson(context.request, ["in_coin", "out_coin", "side"], ["amount_in", "amount_out", "slippage_bps"]),
            );
            const caller = context.caller;
            const wallet = caller && context.account ? await blastWallet(caller) : null;
            return { input, caller, wallet };
          });
          const quote = await quoteTrade(
            dependencies,
            input,
            { kind: caller?.kind ?? null, accountId: context.account?.account_id ?? null, wallet },
            context.request.signal,
          );
          return context.json(quote);
        },
      ),
    }),
  });
}

export type SocialTradeRoutes = ReturnType<typeof createSocialTradeRoutes>;
