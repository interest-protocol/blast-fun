import assert from "node:assert/strict";
import test from "node:test";

import { LaunchpadTransactions, previewBuy, previewSell } from "@interest-protocol/blast-sdk/launchpad";

import { defineBlastDeployment, launchpadDeployment } from "@interest-protocol/blast-sdk/deployments";
import { SOCIAL_TRADE_BASE_COINS } from "@blast/core/modules/social/contracts/trades.ts";
import { toBase64 } from "@mysten/sui/utils";
import type { ActionPhase } from "../transaction/action-machine.ts";
import { createActionController, type SignerSource } from "../transaction/controller.ts";
import { fixturePrivySigner, fixtureWalletSigner, NON_PRODUCTION_MANIFEST, type FixtureSignerBehavior } from "../../../../test/fixtures/launchpad/transaction/fixtures.ts";
import type { LaunchpadSigner } from "../transaction/signer.ts";
import { curveTradeAdapter, type CurveTradeInput } from "./curve-adapter.ts";
import { minimumOut } from "@blast/core/lib/bps.ts";
import { createTradeFixtureChain, TRADE_LAUNCH_ID, TRADE_MEME_TYPE, tradeFixtureCurve, type TradeFixtureChain } from "../../../../../../packages/core/test/fixtures/launchpad/trade/trade-fixtures.ts";
import { atomsGrouped } from "@blast/core/web/format.ts";
import { tradePresetAmount } from "./trade-display.ts";

const IN_FLIGHT: ReadonlySet<ActionPhase> = new Set(["connecting", "preflighting", "signing", "reconciling"]);

function harness(
  input: Partial<CurveTradeInput> = {},
  options: Readonly<{ fixture?: TradeFixtureChain; kind?: "wallet" | "privy"; behavior?: FixtureSignerBehavior; routePayment?: Parameters<typeof curveTradeAdapter>[1] }> = {},
) {
  const fixture = options.fixture ?? createTradeFixtureChain();
  const counts = { signatures: 0, invalidated: [] as (readonly string[])[] };
  const behavior: FixtureSignerBehavior = {
    ...options.behavior,
    onRequest: () => {
      counts.signatures += 1;
      options.behavior?.onRequest?.();
    },
  };
  let connected: LaunchpadSigner | null = null;
  const signers: SignerSource = {
    kinds: ["wallet", "privy"],
    current: () => connected,
    async connect(kind) {
      connected = kind === "privy" ? fixturePrivySigner(behavior) : fixtureWalletSigner(behavior);
      return connected;
    },
  };
  const full: CurveTradeInput = { launchId: TRADE_LAUNCH_ID, direction: "buy", amount: "10", slippageBps: 100n, ...input };
  let reviews = 0;
  const controller = createActionController({
    adapter: curveTradeAdapter(full.direction, options.routePayment),
    chain: { client: fixture.client, manifest: NON_PRODUCTION_MANIFEST, mode: "non-production" },
    signers,
    input: full,
    newReviewId: () => `review-${(reviews += 1)}`,
  });
  controller.onInvalidate((keys) => counts.invalidated.push(keys));
  return { fixture, counts, controller, kind: options.kind ?? "wallet" };
}

type Harness = ReturnType<typeof harness>;

async function settle({ controller }: Harness) {
  for (let turn = 0; turn < 300; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (!IN_FLIGHT.has(controller.getState().phase)) return controller.getState();
  }
  throw new Error(`still ${controller.getState().phase}`);
}

async function review(h: Harness) {
  h.controller.submit();
  if (h.controller.getState().phase === "choosing-signer") h.controller.chooseSigner(h.kind);
  return settle(h);
}

function facts(state: Awaited<ReturnType<typeof review>>) {
  return state.phase === "review" ? Object.fromEntries(state.review.facts.map((fact) => [fact.key, fact.value])) : {};
}

test("a buy review shows the SDK's exact fresh consequences, signs once, and completes on the Bought event", async () => {
  const h = harness({ amount: "10", slippageBps: 100n });
  const state = await review(h);
  assert.equal(state.phase, "review", state.phase === "blocked" ? state.block.message : "");
  const expected = previewBuy(tradeFixtureCurve(), 10_000_000_000n);
  const shown = facts(state);
  assert.equal(shown["quote-in"], `${atomsGrouped(expected.quoteInGross, 9)} SUI`);
  assert.equal(shown["meme-out"], `${atomsGrouped(expected.memeOutNet, 9)} TOAD`);
  assert.equal(shown["minimum-out"], "1,686,498.416419362 TOAD");
  assert.equal(shown.refund, undefined);
  assert.equal(shown.fees, `${atomsGrouped(expected.quoteFee, 9)} SUI`);
  assert.equal(shown.slippage, "1%");
  assert.equal(shown.lifecycle, "Live: the bonding curve is open");
  assert.match(shown.route, /Blast bonding curve, launch 0x1b1b…1b1b at version 40/);
  assert.equal(shown["balance-quote"], "100 SUI");
  assert.equal(shown["balance-meme"], "0 TOAD");
  if (state.phase === "review") h.controller.approve(state.review.id);
  const done = await settle(h);
  assert.equal(done.phase, "succeeded");
  assert.equal(h.counts.signatures, 1);
  assert.equal(h.fixture.calls.execute, 1);
  assert.equal(h.fixture.state.version, 41);
  assert.deepEqual(h.counts.invalidated, [[`launch:${TRADE_LAUNCH_ID}`, `curve:${TRADE_LAUNCH_ID}`, `chart:${TRADE_LAUNCH_ID}`, `activity:${TRADE_LAUNCH_ID}`, "wallet:balances"]]);
});

test("a curve preset keeps all payment atoms through review and execution", async () => {
  const fixture = createTradeFixtureChain();
  const owner = fixtureWalletSigner().address;
  fixture.state.sui[owner] = 412_380_000_007n;
  const h = harness({ amount: tradePresetAmount("25", fixture.state.sui[owner], 9) }, { fixture });
  const state = await review(h);
  assert.equal(state.phase, "review");
  assert.equal(facts(state)["quote-in"], "103.095000001 SUI", "one quarter floors only the fractional atom");
  if (state.phase !== "review") return assert.fail("the exact preset must be eligible for review");
  h.controller.approve(state.review.id);
  assert.equal((await settle(h)).phase, "succeeded");
  assert.equal(fixture.state.sui[owner], 309_285_000_006n, "the transaction spends exactly 103095000001 atoms");
});

test("a sell review shows the received SUI, the burn, and the fees from the SDK, and completes on the Sold event", async () => {
  const fixture = createTradeFixtureChain();
  const owner = fixtureWalletSigner().address;
  fixture.state.meme[owner] = 5_000_000_000_000_000n;
  const h = harness({ direction: "sell", amount: "1000000", slippageBps: 50n }, { fixture, kind: "wallet" });
  const state = await review(h);
  assert.equal(state.phase, "review", state.phase === "blocked" ? state.block.message : "");
  const expected = previewSell(tradeFixtureCurve(), 1_000_000_000_000_000n, 200n);
  const shown = facts(state);
  assert.equal(shown["meme-in"], "1,000,000 TOAD");
  assert.equal(shown["quote-out"], `${atomsGrouped(expected.quoteOutNet, 9)} SUI`);
  assert.equal(shown["minimum-out"], "5.588289097 SUI");
  assert.equal(shown.burn, `${atomsGrouped(expected.pendingBurnDelta, 9)} TOAD (2% of the sale after the fee)`);
  if (state.phase === "review") h.controller.approve(state.review.id);
  assert.equal((await settle(h)).phase, "succeeded");
  assert.equal(fixture.state.meme[owner], 4_000_000_000_000_000n);
});

test("a competing trade between review and approval replaces the review and needs confirmation; nothing is signed", async () => {
  const h = harness();
  const first = await review(h);
  h.fixture.competingBuy(500_000_000_000n);
  if (first.phase === "review") h.controller.approve(first.review.id);
  const replaced = await settle(h);
  assert.equal(replaced.phase, "review");
  const changed = replaced.phase === "review" ? replaced.changes.map((change) => change.key) : [];
  assert.ok(changed.includes("meme-out"));
  assert.ok(changed.includes("route"));
  assert.equal(h.counts.signatures, 0);
  if (replaced.phase === "review") h.controller.approve(replaced.review.id);
  assert.equal((await settle(h)).phase, "succeeded");
  assert.equal(h.counts.signatures, 1);
});

test("unsafe amounts, a short balance, or a closed curve are refused before any simulation or signature", async () => {
  for (const [input, code] of [
    [{ amount: "0" }, "ineligible"],
    [{ amount: "-1" }, "ineligible"],
    [{ amount: "0.0000000001" }, "ineligible"],
    [{ amount: "18446744074" }, "ineligible"],
    [{ amount: "100.000000001" }, "insufficient-balance"],
    [{ direction: "sell" as const, amount: "1" }, "insufficient-balance"],
  ] as const) {
    const h = harness(input);
    const state = await review(h);
    assert.equal(state.phase, "blocked", JSON.stringify(input));
    assert.equal(state.phase === "blocked" && state.block.code, code, JSON.stringify(input));
    assert.equal(h.fixture.calls.simulate, 0);
    assert.equal(h.counts.signatures, 0);
  }
  for (const lifecycle of ["OpeningRound", "MigrationReady", "Migrated"] as const) {
    const h = harness({}, { fixture: createTradeFixtureChain({ lifecycle }) });
    const state = await review(h);
    assert.equal(state.phase === "blocked" && state.block.code, lifecycle === "Migrated" ? "stale-route" : "stale-lifecycle", lifecycle);
    assert.equal(h.counts.signatures, 0);
  }
});

test("a price move after signing fails on chain for slippage, keeps the input, and is never re-signed", async () => {
  const fixture = createTradeFixtureChain();
  const h = harness({ amount: "10", slippageBps: 50n }, { fixture, behavior: { onRequest: () => fixture.competingBuy(2_000_000_000_000n) } });
  const state = await review(h);
  if (state.phase === "review") h.controller.approve(state.review.id);
  const failed = await settle(h);
  assert.equal(failed.phase, "failed");
  assert.equal(failed.phase === "failed" ? failed.message : "", "The transaction failed on Sui: the network rejected it. Its changes were reverted; only network fees were spent. Code: execution_failed.");
  assert.doesNotMatch(failed.phase === "failed" ? failed.message : "", /abort code: 16/);
  assert.equal(failed.input.amount, "10");
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.counts.signatures, 1);
  assert.equal(fixture.calls.execute, 1);
});

test("a declined signature submits nothing and keeps the input", async () => {
  const h = harness({ amount: "7.5" }, { behavior: { decide: () => "reject" } });
  const state = await review(h);
  if (state.phase === "review") h.controller.approve(state.review.id);
  const rejected = await settle(h);
  assert.equal(rejected.phase, "rejected");
  assert.equal(rejected.input.amount, "7.5");
  assert.equal(h.fixture.calls.execute, 0);
});

test("a lost submission answer is reconciled by digest only: checking again never signs again", async () => {
  const fixture = createTradeFixtureChain({ execution: "unknown" });
  const h = harness({}, { fixture });
  const state = await review(h);
  if (state.phase === "review") h.controller.approve(state.review.id);
  const ambiguous = await settle(h);
  assert.equal(ambiguous.phase, "ambiguous");
  h.controller.recheck();
  const done = await settle(h);
  assert.equal(done.phase, "succeeded");
  assert.equal(h.counts.signatures, 1);
  assert.equal(fixture.calls.execute, 1);
});

const { CREATE_TEST_SUI_QUOTE_TYPE, CREATE_QUOTE_TYPE } = await import("@blast/core/modules/social/contracts/create.ts");
  for (const [quoteType, decimals, symbol] of [[CREATE_TEST_SUI_QUOTE_TYPE, 9, "TSUI"], [CREATE_QUOTE_TYPE, 6, "USDC"]] as const) {
    for (const direction of ["buy", "sell"] as const) {
      test(`${symbol} curve ${direction} uses its actual quote balance and decimals`, async () => {
      const fixture = createTradeFixtureChain({ quoteType });
      fixture.state.meme[fixtureWalletSigner().address] = 5_000_000_000_000_000n;
      const readTypes: string[] = [];
      const getBalance = fixture.client.core.getBalance.bind(fixture.client.core);
      Object.assign(fixture.client.core, { getBalance: async (input: { owner: string; coinType: string }) => {
        readTypes.push(input.coinType);
        const answer = await getBalance(input);
        if (input.coinType === quoteType) return { balance: { ...answer.balance, coinType: quoteType, balance: String(100n * 10n ** BigInt(decimals)), coinBalance: "0", addressBalance: String(100n * 10n ** BigInt(decimals)) } };
        return answer;
      } });
      const h = harness({ direction, amount: direction === "buy" ? "10" : "1000000" }, { fixture });
      const state = await review(h);
      assert.equal(state.phase, "review", state.phase === "blocked" ? state.block.message : "");
      assert.ok(readTypes.includes(quoteType));
      assert.ok(!readTypes.includes("0x" + "0".repeat(63) + "2::sui::SUI"));
      const shown = facts(state);
      assert.equal(shown["balance-quote"], `100 ${symbol}`);
      if (direction === "buy") assert.equal(shown["quote-in"], `10 ${symbol}`);
      else assert.match(shown["quote-out"]!, new RegExp(` ${symbol}$`));
      if (state.phase === "review") h.controller.approve(state.review.id);
      assert.equal((await settle(h)).phase, "succeeded");
      assert.equal(h.counts.signatures, 1);
      assert.equal(fixture.calls.execute, 1);
      });
    }
  }


test("routed X payment uses guaranteed curve funding despite a zero quote balance and refuses mismatched builds", async () => {
  const payment = { coinType: SOCIAL_TRADE_BASE_COINS.usdc, symbol: "USDC", decimals: 6, quoteId: "sealed-fixture", quoteAmount: "5000000000", expiresAtMs: Date.now() + 60_000 };
  const fixture = createTradeFixtureChain();
  const original = fixture.client.core.getBalance.bind(fixture.client.core);
  Object.assign(fixture.client.core, { getBalance: async (input: { owner: string; coinType: string }) => {
    const answer = await original(input);
    const balance = input.coinType === payment.coinType ? "2000000" : "0";
    return { balance: { ...answer.balance, balance } };
  } });
  const clickedMinimum = minimumOut(previewBuy(tradeFixtureCurve(), BigInt(payment.quoteAmount)).memeOutNet, 100n) - 1n;
  let routeRequests = 0;
  let wrongWallet = false;
  const routePayment: NonNullable<Parameters<typeof curveTradeAdapter>[1]> = async (signer, launchId, quoteId, minimum) => {
    routeRequests++;
    assert.equal(quoteId, payment.quoteId);
    assert.equal(minimum, clickedMinimum, "the curve leg keeps the clicked minimum");
    const sdk = new LaunchpadTransactions(launchpadDeployment(defineBlastDeployment(NON_PRODUCTION_MANIFEST)));
    // This fixture models already-swapped funding; backend tests verify the actual swap composition.
    const tx = sdk.buy({ memeType: TRADE_MEME_TYPE, quoteType: SOCIAL_TRADE_BASE_COINS.sui, launch: { objectId: launchId, initialSharedVersion: "30" }, quoteAmount: BigInt(payment.quoteAmount), minMemeOut: minimum, recipient: signer.address });
    tx.setSender(signer.address);
    return { launch_id: launchId, sender: wrongWallet ? `0x${"11".repeat(32)}` : signer.address, quote_type: SOCIAL_TRADE_BASE_COINS.sui, quote_amount: payment.quoteAmount, payment_type: payment.coinType, payment_amount: "1000000", min_meme_out: minimum.toString(), expires_at_ms: payment.expiresAtMs, transaction_kind_bytes: toBase64(await tx.build({ client: fixture.client, onlyTransactionKind: true })) };
  };
  const h = harness({ amount: "1", payment, minimumOut: clickedMinimum }, { fixture, routePayment });
  const first = await review(h);
  assert.equal(first.phase, "review", first.phase === "blocked" ? first.block.message : "");
  assert.equal(facts(first)["payment-in"], "1 USDC");
  assert.equal(facts(first)["quote-in"], "5 SUI");
  assert.equal(facts(first)["balance-quote"], "0 SUI");
  assert.equal(h.counts.signatures, 0);
  wrongWallet = true;
  if (first.phase === "review") h.controller.approve(first.review.id);
  const refused = await settle(h);
  assert.equal(refused.phase, "blocked");
  assert.equal(h.counts.signatures, 0);
  assert.equal(fixture.calls.execute, 0);
  assert.equal(routeRequests, 2);
});


for (const direction of ["buy", "sell"] as const) {
  for (const deteriorated of [false, true]) {
    test(`fast ${direction} ${deteriorated ? "refuses a worse fresh price" : "keeps the clicked minimum"}`, async () => {
      const amount = direction === "buy" ? 10_000_000_000n : 1_000_000_000_000_000n;
      const expected = direction === "buy" ? previewBuy(tradeFixtureCurve(), amount).memeOutNet : previewSell(tradeFixtureCurve(), amount, 200n).quoteOutNet;
      const bound = minimumOut(expected, 100n);
      const fixture = createTradeFixtureChain();
      fixture.state.meme[fixtureWalletSigner().address] = 5_000_000_000_000_000n;
      if (deteriorated) fixture.state.curve = { ...fixture.state.curve, realQuoteReserve: direction === "buy" ? 3_000_000_000_000n : 0n };
      const h = harness({ direction, amount: atomsGrouped(amount, 9), minimumOut: bound }, { fixture });
      h.controller.submit({ confirmInWallet: true });
      h.controller.chooseSigner("wallet");
      const done = await settle(h);
      assert.equal(done.phase, deteriorated ? "blocked" : "succeeded", done.phase === "blocked" ? done.block.message : done.phase);
      assert.equal(h.counts.signatures, deteriorated ? 0 : 1);
      if (done.phase === "succeeded") assert.equal(done.review.facts.find(f => f.key === "minimum-out")?.value, `${atomsGrouped(bound, 9)} ${direction === "buy" ? "TOAD" : "SUI"}`);
    });
  }
}
