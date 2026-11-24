import assert from "node:assert/strict";
import test from "node:test";

import { defineBlastDeployment } from "@interest-protocol/blast-sdk/deployments";

import { createActionController, type SignerSource } from "../transaction/controller.ts";
import { fixtureWalletSigner, NON_PRODUCTION_MANIFEST } from "../../../../test/fixtures/launchpad/transaction/fixtures.ts";
import { curveTradeToast, describeCompletedTrade, readCompletedTrade } from "./completed-trade.ts";
import { curveTradeAdapter } from "./curve-adapter.ts";
import { createTradeFixtureChain, TRADE_LAUNCH_ID } from "../../../../../../packages/core/test/fixtures/launchpad/trade/trade-fixtures.ts";

const deployment = defineBlastDeployment(NON_PRODUCTION_MANIFEST);

test("a buy that reaches the graduation target reports the SUI actually paid, net of the refund, once", async () => {
  const fixture = createTradeFixtureChain();
  const signer = fixtureWalletSigner();
  fixture.state.sui[signer.address] = 20_000_000_000_000n;
  const signers: SignerSource = { kinds: ["wallet"], current: () => signer, connect: async () => signer };
  const controller = createActionController({
    adapter: curveTradeAdapter("buy"),
    chain: { client: fixture.client, manifest: NON_PRODUCTION_MANIFEST, mode: "non-production" },
    signers,
    input: { launchId: TRADE_LAUNCH_ID, direction: "buy", amount: "15000", slippageBps: 100n },
  });
  controller.submit();
  for (let turn = 0; turn < 300 && controller.getState().phase !== "review"; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  const review = controller.getState();
  assert.equal(review.phase, "review", review.phase === "blocked" ? review.block.message : "");
  const facts = review.phase === "review" ? Object.fromEntries(review.review.facts.map((fact) => [fact.key, fact.value])) : {};
  assert.match(facts.refund ?? "", /^[1-9][\d.,]* SUI$/);
  if (review.phase === "review") controller.approve(review.review.id);
  for (let turn = 0; turn < 300 && controller.getState().phase !== "succeeded"; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  const done = controller.getState();
  assert.equal(done.phase, "succeeded");
  const read = await readCompletedTrade(fixture.client, deployment, done.phase === "succeeded" ? done.digest : "");
  assert.equal(read.status, "ok");
  if (read.status !== "ok" || read.trade.kind !== "Bought") return assert.fail("no Bought");
  assert.ok(read.trade.quoteRefund > 0n);
  // `Bought.quote_in` is the SUI kept by the curve, already net of the refund: the review's "You pay".
  const message = describeCompletedTrade(read.trade, "TOAD", 9);
  assert.match(message, new RegExp(`for ${facts["quote-in"]!.replace(/[.]/g, "\\.")}\\.$`));
  assert.match(message, /^Bought [\d,.]+ TOAD for /);
});

test("a sale reports the coin sold and the SUI received", () => {
  assert.equal(describeCompletedTrade({ kind: "Sold", memeIn: 1_000_000_000_000_000n, quoteOutNet: 5_616_370_951n }, "TOAD", 9), "Sold 1,000,000 TOAD for 5.616370951 SUI.");
});

test("a completed curve trade's toast says what filled and links the transaction", () => {
  const curve = { symbol: "FROG", decimals: 6, quote: { decimals: 9, symbol: "SUI" } };
  assert.deepEqual(
    curveTradeToast({ kind: "Bought", quoteIn: 2_500_000_000n, quoteRefund: 0n, memeOutNet: 47_566_000_000n }, curve, "https://suiscan.xyz/mainnet/tx/D1"),
    { title: "Bought 47,566 FROG for 2.5 SUI", options: { href: "https://suiscan.xyz/mainnet/tx/D1", link: "View transaction" } },
  );
  assert.deepEqual(curveTradeToast("unavailable", curve, null), { title: "Trade confirmed", options: {} });
});
