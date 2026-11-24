/**
 * Test-only (never imported by runtime code): R3-30's quotes as the real
 * quote service answers them over the Cetus aggregator's **recorded mainnet
 * answers** and mainnet's recorded dry runs (`modules/social/trades/
 * fixtures.ts`) — the network responses the swap renders, byte for byte.
 * Nothing here reaches a network: the router replays recordings, the
 * fullnode is in memory (a swap with a recorded mainnet dry run answers with
 * it, any other passes with no balance change to read, as R3-30's
 * integration test does), `chain_read_v1` is a two-statement stub.
 *
 * R3-33's tests render these through the swap's own model and assert every
 * figure on screen is the response's after formatting (AC-1, AC-5, AC-7); the
 * browser check answers the page's quote request with the same JSON.
 */
import type { QueryResult, QueryResultRow } from "pg";

import type { ReadableDatabase } from "../../../../../../packages/core/src/modules/database/transaction.ts";
import type { SocialTradeQuote } from "@blast/core/modules/social/contracts/trades.ts";
import { TRADE_PRICES_SQL, TRADE_SALE_COINS_SQL } from "@blast/server/modules/social/trades/coins.ts";
import {
  balanceKey,
  offlineTradeChain,
  replayDryRuns,
  replayRouter,
  SALE_A,
  SALE_B,
  SENDER,
  simulationSuccess,
  SUI,
  USDC,
} from "../../../../../../packages/server/test/fixtures/modules/social/trades/fixtures.ts";
import { quoteTrade, type TradeQuoteCaller, type TradeQuoteInput } from "@blast/server/modules/social/trades/quote.ts";
import { tradeQuoteKey } from "@blast/server/modules/social/trades/quote-token.ts";

import type { WalletCoinView } from "#web/components/social/coins/coin-model.ts";
import { tradableCoinView } from "#web/components/social/coins/swap-model.ts";

export const RECORDED_SALE_B_PRESALE = `0x${"b0b".padStart(64, "0")}`;
export const RECORDED_SALE_A_PRESALE = `0x${"a0a".padStart(64, "0")}`;
const SUI_PRICE = "1.19";
const SALE_B_PRICE = "0.00000000006";
const ACCOUNT = "00000000-0000-4000-8000-000000000001";

/** The recorded sale coins as the picker lists them (`GET /api/social/trades/coins`). */
export const RECORDED_BEE: WalletCoinView = tradableCoinView({
  coin_type: SALE_B, symbol: "BEE", name: "BEE", decimals: 9, icon_url: null, usd_price: SALE_B_PRICE, presale_id: RECORDED_SALE_B_PRESALE,
});
export const RECORDED_AYE: WalletCoinView = tradableCoinView({
  coin_type: SALE_A, symbol: "AYE", name: "AYE", decimals: 9, icon_url: null, usd_price: null, presale_id: RECORDED_SALE_A_PRESALE,
});

function chainReads(): ReadableDatabase {
  const sales = [
    { presale_id: RECORDED_SALE_B_PRESALE, sale_token: SALE_B, sale_symbol: "BEE", sale_decimals: 9 },
    { presale_id: RECORDED_SALE_A_PRESALE, sale_token: SALE_A, sale_symbol: "AYE", sale_decimals: 9 },
  ];
  return {
    async read<Row extends QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
      const wanted = new Set(values[0] as string[]);
      const asOf = String(Date.now() - 5_000);
      const rows = text === TRADE_SALE_COINS_SQL
        ? sales.filter((row) => wanted.has(row.sale_token))
        : text === TRADE_PRICES_SQL
          ? [{ coin_type: SUI, usd_price: SUI_PRICE, as_of_ms: asOf }, { coin_type: SALE_B, usd_price: SALE_B_PRICE, as_of_ms: asOf }].filter((row) => wanted.has(row.coin_type))
          : null;
      if (!rows) throw new Error(`unexpected statement ${text}`);
      return { rows: rows as unknown as Row[], rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    },
  };
}

const KEY = tradeQuoteKey("swap-recorded-fixture-pepper-0123456789abcdef");

async function quote(input: TradeQuoteInput, caller: TradeQuoteCaller, funded: bigint, nowMs: number): Promise<SocialTradeQuote> {
  const chain = offlineTradeChain({ balances: { [balanceKey(SENDER, SUI)]: funded, [balanceKey(SENDER, USDC)]: 10n ** 9n }, simulation: replayDryRuns(() => simulationSuccess()) });
  return quoteTrade(
    { database: chainReads, router: () => replayRouter().router, chain: () => chain, quoteKey: () => KEY, now: () => nowMs },
    input,
    caller,
  );
}

const buy = (inCoin: string, outCoin: string, amountIn: bigint): TradeQuoteInput => ({ inCoin, outCoin, side: "buy", amountIn, amountOut: null, slippageBps: 50 });

/**
 * The recorded answers: 0.1 SUI → BEE over SALE_B's Cetus pool for an
 * embedded wallet (offered, `Paid by Blast`, OA-29's 82.33% impact), for a
 * wallet session (also `Paid by Blast`) and a visitor (priced, not offered);
 * 1 USDC → BEE over three legs; and SUI → AYE, which no pool reaches.
 */
export async function recordedQuotes(nowMs = Date.now()) {
  const embedded: TradeQuoteCaller = { kind: "privy", accountId: ACCOUNT, wallet: SENDER };
  const session: TradeQuoteCaller = { kind: "wallet", accountId: ACCOUNT, wallet: SENDER };
  const visitor: TradeQuoteCaller = { kind: null, accountId: null, wallet: null };
  return {
    embedded: await quote(buy(SUI, SALE_B, 100_000_000n), embedded, 10n ** 12n, nowMs),
    session: await quote(buy(SUI, SALE_B, 100_000_000n), session, 10n ** 12n, nowMs),
    visitor: await quote(buy(SUI, SALE_B, 100_000_000n), visitor, 0n, nowMs),
    threeLegs: await quote(buy(USDC, SALE_B, 1_000_000n), embedded, 10n ** 12n, nowMs),
    noRoute: await quote(buy(SUI, SALE_A, 100_000_000n), visitor, 0n, nowMs),
  };
}
