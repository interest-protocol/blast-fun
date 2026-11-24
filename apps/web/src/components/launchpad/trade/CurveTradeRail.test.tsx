import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { defineBlastDeployment } from "@interest-protocol/blast-sdk/deployments";

import { NON_PRODUCTION_MANIFEST } from "../../../../test/fixtures/launchpad/transaction/fixtures.ts";
import { LaunchpadSignerProvider } from "../transaction/LaunchpadSignerProvider";
import { readCurve } from "./curve-read";
import { CurveTradeProvider } from "./CurveTradeProvider";
import { CurveTradeRail, CurveTradeUnavailable } from "./CurveTradeRail";
import { indicativeEstimate } from "./curve-trade-rail-model";
import { createTradeFixtureChain, TRADE_LAUNCH_ID, type TradeLifecycle } from "../../../../../../packages/core/test/fixtures/launchpad/trade/trade-fixtures.ts";

const deployment = defineBlastDeployment(NON_PRODUCTION_MANIFEST);

async function render(lifecycle: TradeLifecycle = "Live") {
  const fixture = createTradeFixtureChain({ lifecycle });
  const curve = await readCurve(fixture.client, deployment, TRADE_LAUNCH_ID, 1_790_000_000_000);
  let bridges = 0;
  const html = renderToStaticMarkup(
    <LaunchpadSignerProvider kinds={["wallet", "privy"]} renderBridge={() => void (bridges += 1)}>
      <CurveTradeProvider
        chain={{ client: fixture.client, manifest: NON_PRODUCTION_MANIFEST, mode: "non-production" }}
        launchId={TRADE_LAUNCH_ID}
        initialCurve={curve}
        report={() => {}}
      >
        <CurveTradeRail />
      </CurveTradeProvider>
    </LaunchpadSignerProvider>,
  );
  return { html, text: html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " "), bridges, fixture };
}

test("signed out, the rail offers spot Buy and Sell with units and an indicative estimate labeled with what it observed", async () => {
  const { html, text, bridges, fixture } = await render();
  assert.match(text, /Buy Sell/);
  assert.match(text, /You pay \(SUI\)/);
  assert.match(text, /You sell \(TOAD\)/);
  assert.match(text, /Estimate/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Review buy<\/button>/);
  assert.doesNotMatch(text, /\b(long|short|leverage|leveraged|margin|position|liquidat)/i);
  assert.equal(bridges, 0);
  assert.equal(fixture.calls.simulate, 0);
});

test("a curve that is not Live says why and offers no review", async () => {
  const migrated = await render("Migrated");
  assert.match(migrated.text, /graduated from its curve\. Trade it on its venue pool/);
  const opening = await render("OpeningRound");
  assert.match(opening.text, /opening round is still running/);
});

test("the signed-out buy estimate names the Meme fee as well as the SUI fee", async () => {
  const fixture = createTradeFixtureChain();
  fixture.state.curve.memeFeeBps = 100n;
  const read = await readCurve(fixture.client, deployment, TRADE_LAUNCH_ID, 1_790_000_000_000);
  assert.equal(read.status, "ok");
  if (read.status !== "ok") return;
  const estimate = indicativeEstimate(read.curve, { launchId: TRADE_LAUNCH_ID, direction: "buy", amount: "10", slippageBps: 100n }, "buy");
  assert.match(estimate?.detail ?? "", /^[\d.,]+ SUI and [\d.,]+ TOAD$/);
  fixture.state.curve.memeFeeBps = 0n;
  const free = await readCurve(fixture.client, deployment, TRADE_LAUNCH_ID, 1_790_000_000_000);
  if (free.status !== "ok") return assert.fail("curve read");
  assert.match(indicativeEstimate(free.curve, { launchId: TRADE_LAUNCH_ID, direction: "buy", amount: "10", slippageBps: 100n }, "buy")?.detail ?? "", /^[\d.,]+ SUI$/);
});

test("estimates show buy refunds separately and omit zero sell burn and Meme fees", async () => {
  const fixture = createTradeFixtureChain();
  fixture.state.sellBurnBps = 0n;
  fixture.state.curve.memeFeeBps = 0n;
  const read = await readCurve(fixture.client, deployment, TRADE_LAUNCH_ID, 1_790_000_000_000);
  if (read.status !== "ok") return assert.fail("curve read");
  const buy = indicativeEstimate(read.curve, { launchId: TRADE_LAUNCH_ID, direction: "buy", amount: "50000", slippageBps: 100n }, "buy");
  const sell = indicativeEstimate(read.curve, { launchId: TRADE_LAUNCH_ID, direction: "sell", amount: "100", slippageBps: 100n }, "sell");
  assert.match(buy?.refund ?? "", /^[\d.,]+ SUI$/);
  assert.match(buy?.detail ?? "", /^[\d.,]+ SUI$/);
  assert.match(sell?.detail ?? "", /^[\d.,]+ SUI$/);
  assert.equal(sell?.burn, undefined);
  assert.equal(sell?.refund, undefined);
});

test("without a released deployment the rail says so and offers nothing to sign", () => {
  const html = renderToStaticMarkup(<CurveTradeUnavailable reason="Trading opens once this app is connected to a released Blast deployment." />);
  assert.match(html, /data-trade-unavailable/);
  assert.doesNotMatch(html, /<button/);
});
