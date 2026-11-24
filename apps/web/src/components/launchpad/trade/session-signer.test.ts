import assert from "node:assert/strict";
import test from "node:test";
import { createActionController } from "../transaction/controller";
import { gateWhileUnresolved } from "./curve-trade-provider-model";
import { curveTradeAdapter } from "./curve-adapter";
import { createSessionSignerSource } from "./session-signer";
import {
  fixturePrivySigner,
  fixtureWalletSigner,
  NON_PRODUCTION_MANIFEST,
} from "../../../../test/fixtures/launchpad/transaction/fixtures";
import {
  createTradeFixtureChain,
  TRADE_LAUNCH_ID,
} from "../../../../../../packages/core/test/fixtures/launchpad/trade/trade-fixtures";

test("an existing Blast wallet opens curve review without choosing or reconnecting a signer", async () => {
  const session = createSessionSignerSource();
  session.update(fixturePrivySigner());
  const chain = createTradeFixtureChain();
  const controller = createActionController({
    adapter: { ...curveTradeAdapter("buy"), prepare: undefined },
    chain: {
      client: chain.client,
      manifest: NON_PRODUCTION_MANIFEST,
      mode: "non-production",
    },
    signers: session.source,
    input: {
      launchId: TRADE_LAUNCH_ID,
      direction: "buy",
      amount: "1",
      slippageBps: 100n,
    },
  });
  controller.submit();
  assert.notEqual(controller.getState().phase, "choosing-signer");
  for (
    let i = 0;
    i < 300 && controller.getState().phase === "preflighting";
    i++
  )
    await new Promise(setImmediate);
  assert.equal(
    controller.getState().phase,
    "review",
    JSON.stringify(controller.getState(), (_, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  );
  session.update(null);
  assert.equal(session.source.current(), null);
  await assert.rejects(session.source.connect("privy"), /unavailable/);
  session.update(fixtureWalletSigner());
  assert.equal(session.source.current()?.kind, "wallet");
  assert.equal(
    controller.getState().phase,
    "review",
    "account changes retain the transaction controller",
  );
  controller.approve(
    (controller.getState() as { review: { id: string } }).review.id,
  );
  for (
    let i = 0;
    i < 300 && controller.getState().phase === "preflighting";
    i++
  )
    await new Promise(setImmediate);
  assert.notEqual(
    controller.getState().phase,
    "succeeded",
    "a changed wallet cannot silently sign the prior wallet's review",
  );
});


test("the production unresolved gate forwards wallet confirmation to the curve controller", async () => {
  const fixture = createTradeFixtureChain();
  const signer = fixtureWalletSigner();
  const make = () => createActionController({
    adapter: curveTradeAdapter("buy"),
    chain: { client: fixture.client, manifest: NON_PRODUCTION_MANIFEST, mode: "non-production" as const },
    signers: { kinds: ["wallet" as const], current: () => signer, connect: async () => signer },
    input: { launchId: TRADE_LAUNCH_ID, direction: "buy" as const, amount: "1", slippageBps: 100n },
  });
  const buy = make();
  const controllers = gateWhileUnresolved({ buy, sell: make() });
  controllers.buy.submit({ confirmInWallet: true });
  for (let i = 0; i < 300 && ["preflighting", "signing", "reconciling"].includes(buy.getState().phase); i++) await new Promise(setImmediate);
  assert.equal(buy.getState().phase, "succeeded");
  assert.equal(fixture.calls.execute, 1);
});
