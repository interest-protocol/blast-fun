import assert from "node:assert/strict";
import test from "node:test";

import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SOCIAL_TRADE_BASE_COINS } from "@blast/core/modules/social/contracts/trades.ts";
import type { TradeRouteAnswer, TradeRouter } from "@blast/server/modules/social/trades/aggregator.ts";
import { quoteTrade, type TradeQuoteInput } from "@blast/server/modules/social/trades/quote.ts";

const input: TradeQuoteInput = { inCoin: SOCIAL_TRADE_BASE_COINS.sui, outCoin: SOCIAL_TRADE_BASE_COINS.usdc, side: "sell", amountIn: 100n, amountOut: null, slippageBps: 50 };
const caller = { kind: null, accountId: null, wallet: null };
const database: ReadableDatabase = { read: async () => ({ rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] }) };

function service(answers: TradeRouteAnswer[], request = input) {
  const calls: boolean[] = [];
  const router: TradeRouter = {
    fee: null,
    findRoute: async (request) => {
      calls.push(request.byAmountIn);
      const answer = answers.shift();
      assert.ok(answer, "only expected route calls");
      return answer;
    },
    appendSwap: async () => { throw new Error("no quote may construct a swap after overload"); },
  };
  const quote = quoteTrade({ database: () => database, router: () => router, chain: () => { throw new Error("no fullnode work after overload"); }, quoteKey: () => { throw new Error("no executable quote after overload"); }, now: () => 1_791_000_000_000 }, request, caller);
  return { quote, calls };
}

for (const [answer, reason] of [[{ status: "no_route" }, "no_pool"], [{ status: "unavailable", reason: "error" }, "pool_unavailable"], [{ status: "unavailable", reason: "timeout" }, "pool_unavailable"]] as const) {
  test(`genuine ${answer.status === "unavailable" ? answer.reason : "no route"} remains a quote answer with ${reason}`, async () => {
    assert.equal((await service([answer]).quote).unavailable_reason, reason);
  });
}
