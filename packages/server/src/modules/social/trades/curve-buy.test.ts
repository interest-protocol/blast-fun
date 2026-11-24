import assert from "node:assert/strict";
import test from "node:test";
import { bcs } from "@mysten/sui/bcs";
import { fromBase64 } from "@mysten/sui/utils";
import {
  createTradeFixtureChain,
  TRADE_LAUNCH_ID,
} from "../../../../../core/test/fixtures/launchpad/trade/trade-fixtures.ts";
import { NON_PRODUCTION_MANIFEST } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/manifest-fixtures.ts";
import {
  balanceKey,
  offlineTradeChain,
  replayRouter,
  SENDER,
  SUI,
  USDC,
  TEST_BLAST_FEE,
} from "../../../../test/fixtures/modules/social/trades/fixtures.ts";
import { buildRoutedCurveBuy } from "./curve-buy.ts";
import { sealTradeQuote, tradeQuoteKey } from "./quote-token.ts";
import { minOut } from "@blast/core/modules/social/trades/amounts.ts";

const KEY = tradeQuoteKey(
  "curve-payment-offline-test-key-at-least-32-characters",
);
const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const NOW = Date.now();
async function fixture() {
  const { router } = replayRouter(undefined, TEST_BLAST_FEE);
  const found = await router.findRoute({
    from: SUI,
    target: USDC,
    amount: 1_000_000_000n,
    byAmountIn: true,
  });
  assert.equal(found.status, "route");
  if (found.status !== "route") throw new Error("missing recorded route");
  const quote = {
    accountId: ACCOUNT,
    sender: SENDER,
    side: "sell" as const,
    inCoin: SUI,
    outCoin: USDC,
    amountIn: found.route.amountIn,
    amountOut: found.route.amountOut,
    minOut: minOut(found.route.amountOut, 50),
    slippageBps: 50,
    priceImpactBps: 0,
    blastFeeBps: 50,
    issuedAtMs: NOW,
    expiresAtMs: NOW + 20_000,
    route: found.route,
  };
  const offline = offlineTradeChain({
    balances: { [balanceKey(SENDER, SUI)]: quote.amountIn },
  });
  const curve = createTradeFixtureChain({ quoteType: USDC });
  const core = {
    ...offline.client.core,
    ...curve.client.core,
    listCoins: offline.client.core.listCoins,
    getMoveFunction: offline.client.core.getMoveFunction,
    resolveTransactionPlugin: offline.client.core.resolveTransactionPlugin,
    async getObjects(input: { objectIds: string[] }) {
      const result = await curve.client.core.getObjects(input);
      return {
        objects: await Promise.all(
          result.objects.map(async (object, i) =>
            object instanceof Error
              ? (
                  await offline.client.core.getObjects({
                    objectIds: [input.objectIds[i]!],
                  })
                ).objects[0]!
              : object,
          ),
        ),
      };
    },
  };
  const chain = { ...offline, client: { core } as typeof offline.client };
  // Entirely offline object fixtures; runtime always supplies configured production mode.
  const manifest = NON_PRODUCTION_MANIFEST;
  const dependencies = {
    chain,
    router,
    quoteKey: KEY,
    manifest,
    mode: "non-production" as const,
    now: NOW,
  };
  const input = {
    launch_id: TRADE_LAUNCH_ID,
    quote_id: sealTradeQuote(KEY, quote),
    min_meme_out: "1",
  };
  return { dependencies, input, quote, curve };
}

test("routed curve buy contains swap, exact guaranteed quote funding, buy and every refund in one PTB", async () => {
  const { dependencies, input, quote } = await fixture();
  const built = await buildRoutedCurveBuy(dependencies, input, ACCOUNT, SENDER);
  assert.equal(built.payment_amount, quote.amountIn.toString());
  assert.equal(built.quote_amount, quote.minOut.toString());
  const ptb = bcs.TransactionKind.parse(
    fromBase64(built.transaction_kind_bytes),
  ).ProgrammableTransaction!;
  assert.ok(ptb.commands.some(command => command.SplitCoins?.coin.$kind === "GasCoin"), "a single SUI gas coin can fund both swap input and gas");
  const swap = ptb.commands.findIndex(
    (command) => command.MoveCall?.function === "confirm_swap_v3",
  );
  const buy = ptb.commands.findIndex(
    (command) =>
      command.MoveCall?.module === "launch" &&
      command.MoveCall.function === "buy",
  );
  assert.ok(swap >= 0 && buy > swap);
  const call = ptb.commands[buy]!.MoveCall!;
  assert.equal(call.typeArguments[1], USDC);
  const split = ptb.commands[call.arguments[3]!.NestedResult![0]]!.SplitCoins!;
  assert.equal(
    bcs.u64().fromBase64(ptb.inputs[split.amounts[0]!.Input!]!.Pure!.bytes),
    quote.minOut.toString(),
  );
  assert.equal(
    bcs.u64().fromBase64(ptb.inputs[call.arguments[4]!.Input!]!.Pure!.bytes),
    "1",
  );
  assert.equal(
    ptb.commands.at(-1)!.TransferObjects!.objects.length,
    3,
    "surplus route output, meme and curve refund go to the sender",
  );
});

test("foreign account, wallet, expired/tampered quote, changed fee or quote type and closed curve are refused", async () => {
  const { dependencies, input, quote, curve } = await fixture();
  for (const changed of [
    { accountId: "00000000-0000-4000-8000-000000000002" },
    { sender: `0x${"11".repeat(32)}` },
    { expiresAtMs: NOW },
    { issuedAtMs: NOW + 1 },
    { blastFeeBps: 0 },
    { outCoin: SUI },
  ]) {
    await assert.rejects(
      buildRoutedCurveBuy(
        dependencies,
        { ...input, quote_id: sealTradeQuote(KEY, { ...quote, ...changed }) },
        ACCOUNT,
        SENDER,
      ),
    );
  }
  await assert.rejects(
    buildRoutedCurveBuy(
      dependencies,
      { ...input, quote_id: input.quote_id.slice(0, -5) + "xxxxx" },
      ACCOUNT,
      SENDER,
    ),
  );
  await assert.rejects(
    buildRoutedCurveBuy(
      {
        ...dependencies,
        chain: { ...dependencies.chain, balance: async () => 0n },
      },
      input,
      ACCOUNT,
      SENDER,
    ),
    { code: "insufficient_balance" },
  );
  curve.state.lifecycle = "MigrationReady";
  await assert.rejects(
    buildRoutedCurveBuy(dependencies, input, ACCOUNT, SENDER),
  );
  await assert.rejects(
    buildRoutedCurveBuy(
      { ...dependencies, mode: "production" },
      input,
      ACCOUNT,
      SENDER,
    ),
    { code: "service_unavailable" },
  );
});

test("a wallet session's sponsored routed buy spends the user's SUI rather than the sponsor gas and propagates sponsor refusal", async () => {
  const { dependencies, input, quote } = await fixture();
  // Outside wallets are sponsored like Privy embedded wallets (owner ruling 2026-11-20).
  const caller = { kind: "wallet" as const, address: SENDER };
  let calls = 0;
  const { buildSponsoredCurveTrade } = await import("./curve-buy.ts");
  const request = { launch_id: input.launch_id, sponsor: true as const, direction: "buy" as const, amount: quote.amountIn.toString(), min_out: input.min_meme_out, quote_id: input.quote_id };
  const sponsor = async (call: import("@blast/server/modules/sponsor/service.ts").SponsorKindRequest) => {
    calls++;
    assert.equal(call.sender, SENDER);
    assert.deepEqual(call.caller, caller);
    assert.equal(call.intent, "trade");
    const ptb = bcs.TransactionKind.parse(call.kindBytes).ProgrammableTransaction!;
    assert.ok(ptb.commands.every(command => !command.SplitCoins || command.SplitCoins.coin.$kind !== "GasCoin"));
    throw Object.assign(new Error("Sponsor budget exhausted"), { code: "budget_exceeded" });
  };
  await assert.rejects(buildSponsoredCurveTrade({ ...dependencies, sponsor }, request, ACCOUNT, SENDER, caller, "127.0.0.1"), { code: "budget_exceeded" });
  assert.equal(calls, 1);
  await assert.rejects(buildSponsoredCurveTrade({ ...dependencies, sponsor }, { ...request, amount: "1" }, ACCOUNT, SENDER, caller, "127.0.0.1"));
  assert.equal(calls, 1, "changed payment amounts cannot obtain sponsorship");
});
