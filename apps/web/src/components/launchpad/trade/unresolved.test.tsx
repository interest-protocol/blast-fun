import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { defineBlastDeployment } from "@interest-protocol/blast-sdk/deployments";

import { createActionController, type ActionController, type SignerSource } from "../transaction/controller";
import { fixtureWalletSigner, NON_PRODUCTION_MANIFEST } from "../../../../test/fixtures/launchpad/transaction/fixtures.ts";
import { LaunchpadSignerProvider, LaunchpadSignerSourceProvider } from "../transaction/LaunchpadSignerProvider";
import { curveTradeAdapter, type CurveTradeInput, type TradeDirection } from "./curve-adapter";
import { readCurve } from "./curve-read";
import { CurveTradeProvider, useCurveTrade, type CurveTradeSession } from "./CurveTradeProvider";
import { unresolvedTrade } from "./curve-trade-provider-model";
import { CurveTradeRail } from "./CurveTradeRail";
import { installTestDom, waitFor } from "../../../../test/fixtures/social/test-dom.ts";
import { createTradeFixtureChain, TRADE_LAUNCH_ID } from "../../../../../../packages/core/test/fixtures/launchpad/trade/trade-fixtures.ts";

const deployment = defineBlastDeployment(NON_PRODUCTION_MANIFEST);

async function lostBuy() {
  const fixture = createTradeFixtureChain({ execution: "unknown" });
  const signer = fixtureWalletSigner();
  const signers: SignerSource = { kinds: ["wallet"], current: () => signer, connect: async () => signer };
  const chain = { client: fixture.client, manifest: NON_PRODUCTION_MANIFEST, mode: "non-production" as const };
  const make = (direction: TradeDirection) =>
    createActionController({
      adapter: curveTradeAdapter(direction),
      chain,
      signers,
      input: { launchId: TRADE_LAUNCH_ID, direction, amount: direction === "buy" ? "10" : "1", slippageBps: 100n } satisfies CurveTradeInput,
    });
  const controllers = { buy: make("buy"), sell: make("sell") };
  const wait = async (phase: string) => {
    for (let turn = 0; turn < 300 && controllers.buy.getState().phase !== phase; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  controllers.buy.submit();
  await wait("review");
  const review = controllers.buy.getState();
  if (review.phase === "review") controllers.buy.approve(review.review.id);
  await wait("ambiguous");
  assert.equal(controllers.buy.getState().phase, "ambiguous");
  return { fixture, chain, controllers, wait };
}

test("while a trade's answer is lost, it can only be reconciled by digest, and neither direction can start a review", async () => {
  const { fixture, chain, controllers } = await lostBuy();
  const pending = unresolvedTrade({ buy: controllers.buy.getState(), sell: controllers.sell.getState() });
  assert.equal(pending?.direction, "buy");
  const curve = await readCurve(fixture.client, deployment, TRADE_LAUNCH_ID, 1_790_000_000_000);
  const html = renderToStaticMarkup(
    <LaunchpadSignerProvider kinds={["wallet"]} renderBridge={() => null}>
      <CurveTradeProvider chain={chain} launchId={TRADE_LAUNCH_ID} initialCurve={curve} controllers={controllers} report={() => {}}>
        <CurveTradeRail />
      </CurveTradeProvider>
    </LaunchpadSignerProvider>,
  );
  const buy = /id="trade-panel-buy"[\s\S]*?(?=id="trade-panel-sell")/.exec(html)?.[0] ?? "";
  const sell = /id="trade-panel-sell"[\s\S]*$/.exec(html)?.[0] ?? "";
  assert.match(buy, /Reconcile and continue/);
  assert.doesNotMatch(buy, /Back to the entry|Trade again|Review buy/);
  assert.match(sell, /A buy is still unresolved on Sui/);
  assert.match(sell, /<button[^>]*disabled=""[^>]*>Review sell<\/button>/);
});

test("reconciling by digest resolves the lost trade without signing again; a new review opens only after it", async () => {
  const { fixture, controllers, wait } = await lostBuy();
  fixture.state.confirmation = "pending";
  // What "Reconcile and continue" does: a digest read only.
  controllers.buy.recheck();
  for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controllers.buy.getState().phase, "ambiguous");
  fixture.state.confirmation = "checkpointed";
  controllers.buy.recheck();
  await wait("succeeded");
  assert.equal(controllers.buy.getState().phase, "succeeded");
  assert.equal(fixture.calls.execute, 1);
  assert.equal(unresolvedTrade({ buy: controllers.buy.getState(), sell: controllers.sell.getState() }), null);
});

test("confirmed curve buys and sells show one toast each and late receipts only update visible toasts", async (t) => {
  const fixture = createTradeFixtureChain({ execution: "unknown" });
  const signer = fixtureWalletSigner();
  const signers: SignerSource = { kinds: ["wallet"], current: () => signer, connect: async () => signer };
  const chain = { client: fixture.client, manifest: NON_PRODUCTION_MANIFEST, mode: "non-production" as const };
  fixture.state.confirmation = "pending";
  let receiptRead = Promise.withResolvers<void>();
  const getTransaction = fixture.client.core.getTransaction.bind(fixture.client.core);
  t.mock.method(fixture.client.core, "getTransaction", async (...args: Parameters<typeof getTransaction>) => {
    await receiptRead.promise;
    return getTransaction(...args);
  });
  const { document } = installTestDom();
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ToastProvider } = await import("#web/components/blast-ui/Toasts.tsx");
  const { toast } = await import("sonner");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    receiptRead.resolve();
    await act(async () => {
      toast.dismiss();
      root.unmount();
    });
    container.remove();
  });

  let session: CurveTradeSession | undefined;
  function CaptureSession() {
    session = useCurveTrade();
    return <CurveTradeRail />;
  }
  await act(async () => root.render(
    <ToastProvider>
      <LaunchpadSignerSourceProvider source={signers}>
        <CurveTradeProvider chain={chain} launchId={TRADE_LAUNCH_ID} report={() => {}} commitOutcome={() => {}} reportOutcome={() => {}}>
          <CaptureSession />
        </CurveTradeProvider>
      </LaunchpadSignerSourceProvider>
    </ToastProvider>,
  ));
  const { controllers } = session!;
  await act(async () => {
    controllers.buy.edit({ ...controllers.buy.getState().input, amount: "10" });
    controllers.buy.submit();
  });
  const buyReview = await waitFor(() => {
    const state = controllers.buy.getState();
    return state.phase === "review" ? state : null;
  }, "the buy review", 750);
  await act(async () => controllers.buy.approve(buyReview.review.id));
  await waitFor(() => controllers.buy.getState().phase === "ambiguous", "the lost buy", 750);
  await act(async () => {
    controllers.buy.recheck();
    await waitFor(() => controllers.buy.getState().phase === "ambiguous", "the unresolved buy", 750);
  });
  assert.equal(container.querySelectorAll("[data-sonner-toast]").length, 0);

  fixture.state.confirmation = "checkpointed";
  await act(async () => {
    controllers.buy.recheck();
    await waitFor(() => controllers.buy.getState().phase === "succeeded", "the recovered buy", 750);
  });
  const confirmed = controllers.buy.getState();
  assert.equal(confirmed.phase, "succeeded");
  const notification = await waitFor(() => container.querySelector("[data-sonner-toast]"), "the confirmed buy toast", 750);
  assert.match(notification.textContent!, /Buy confirmed/);
  assert.equal(notification.querySelector("a")?.href, confirmed.explorerUrl);
  await act(async () => receiptRead.resolve());
  await waitFor(() => /Bought .* TOAD for 10 SUI/.test(notification.textContent?.replace(/\s+/g, " ") ?? ""), "the same toast to show the verified fill", 750);
  assert.ok(notification.querySelector('image[href="/blast-ui/coins/sui.svg"]'));
  assert.equal(container.querySelectorAll("[data-sonner-toast]").length, 1);
  assert.equal(fixture.calls.execute, 1);

  receiptRead = Promise.withResolvers<void>();
  fixture.state.execution = "complete";
  await act(async () => {
    controllers.sell.edit({ ...controllers.sell.getState().input, amount: "1" });
    controllers.sell.submit();
  });
  const review = await waitFor(() => {
    const state = controllers.sell.getState();
    return state.phase === "review" ? state : null;
  }, "the sell review", 750);
  await act(async () => controllers.sell.approve(review.review.id));
  const sellToast = await waitFor(() => [...container.querySelectorAll("[data-sonner-toast]")].find(
    (toast) => toast.textContent?.includes("Sell confirmed"),
  ), "the confirmed sell toast", 750);
  await act(async () => sellToast.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click());
  await waitFor(() => !sellToast.isConnected, "the sell toast to close", 750);
  await act(async () => receiptRead.resolve());
  await waitFor(() => container.querySelector("#trade-panel-sell .success")?.textContent?.includes("Sold"), "the sell receipt", 750);
  assert.equal(container.querySelectorAll("[data-sonner-toast]").length, 1);
  assert.equal(fixture.calls.execute, 2);
});

test("a curve confirmation follows its signer across navigation and stays out of a new account", async (t) => {
  const { SocialViewerProvider } = await import("#web/components/social/SignInGate.tsx");
  const { ToastProvider } = await import("#web/components/blast-ui/Toasts.tsx");
  const { toast: sonner } = await import("sonner");
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { document } = installTestDom();

  for (const scenario of ["navigate", "switch before confirmation", "switch before receipt"] as const) {
    await t.test(scenario, async (subtest) => {
      const fixture = createTradeFixtureChain();
      const chain = { client: fixture.client, manifest: NON_PRODUCTION_MANIFEST, mode: "non-production" as const };
      const signer = fixtureWalletSigner();
      const signers: SignerSource = { kinds: ["wallet"], current: () => signer, connect: async () => signer };
      const confirmation = Promise.withResolvers<void>();
      const receipt = Promise.withResolvers<void>();
      const waitForTransaction = fixture.client.core.waitForTransaction.bind(fixture.client.core);
      const getTransaction = fixture.client.core.getTransaction.bind(fixture.client.core);
      subtest.mock.method(fixture.client.core, "waitForTransaction", async (...args: Parameters<typeof waitForTransaction>) => {
        await confirmation.promise;
        return waitForTransaction(...args);
      });
      subtest.mock.method(fixture.client.core, "getTransaction", async (...args: Parameters<typeof getTransaction>) => {
        await receipt.promise;
        return getTransaction(...args);
      });
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      subtest.after(async () => {
        confirmation.resolve();
        receipt.resolve();
        await act(async () => {
          sonner.dismiss();
          root.unmount();
        });
        container.remove();
      });
      let session!: CurveTradeSession;
      function Trade() {
        session = useCurveTrade();
        return null;
      }
      const render = (account: string, showTrade = true) => root.render(
        <SocialViewerProvider signedIn accountId={account}>
          <ToastProvider>
            {showTrade && <LaunchpadSignerSourceProvider source={signers}>
              <CurveTradeProvider chain={chain} launchId={TRADE_LAUNCH_ID} report={() => {}} commitOutcome={() => {}} reportOutcome={() => {}}>
                <Trade />
              </CurveTradeProvider>
            </LaunchpadSignerSourceProvider>}
          </ToastProvider>
        </SocialViewerProvider>,
      );
      await act(async () => render("first"));
      const { buy } = session.controllers;
      await act(async () => {
        buy.edit({ ...buy.getState().input, amount: "10" });
        buy.submit({ confirmInWallet: true });
      });
      await waitFor(() => buy.getState().phase === "reconciling", "the broadcast buy", 750);

      if (scenario === "navigate") await act(async () => render("first", false));
      if (scenario === "switch before confirmation") await act(async () => render("second", false));
      await act(async () => confirmation.resolve());
      await waitFor(() => buy.getState().phase === "succeeded", "the confirmed buy", 750);
      assert.equal(fixture.calls.execute, 1);

      if (scenario === "switch before confirmation") {
        assert.equal(container.querySelectorAll("[data-sonner-toast]").length, 0);
      } else {
        const toast = await waitFor(() => container.querySelector("[data-sonner-toast]"), "the buy toast", 750);
        assert.match(toast.textContent!, /Buy confirmed/);
        if (scenario === "switch before receipt") {
          await act(async () => render("second"));
          await act(async () => receipt.resolve());
          const state = buy.getState();
          assert.equal(state.phase, "succeeded");
          if (state.phase !== "succeeded") return assert.fail();
          await waitFor(() => session.completed[state.digest], "the verified buy receipt", 750);
          assert.match(toast.textContent!, /Buy confirmed/);
          assert.doesNotMatch(toast.textContent!, /Bought/);
        }
      }
    });
  }
});

const settle = async (turns = 300) => {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** A Sell in `sellPhase`, then a Buy whose answer is lost; the rail rendered through the provider, with the session it hands the rail. */
async function sellThenLostBuy(sellPhase: "review" | "rejected") {
  const fixture = createTradeFixtureChain({ execution: "unknown" });
  let answer: "sign" | "reject" = sellPhase === "rejected" ? "reject" : "sign";
  const signer = fixtureWalletSigner({ decide: () => answer });
  fixture.state.meme[signer.address] = 5_000_000_000_000_000n;
  const signers: SignerSource = { kinds: ["wallet"], current: () => signer, connect: async () => signer };
  const chain = { client: fixture.client, manifest: NON_PRODUCTION_MANIFEST, mode: "non-production" as const };
  const make = (direction: TradeDirection) =>
    createActionController({
      adapter: curveTradeAdapter(direction),
      chain,
      signers,
      input: { launchId: TRADE_LAUNCH_ID, direction, amount: direction === "buy" ? "10" : "1000", slippageBps: 100n } satisfies CurveTradeInput,
    });
  const controllers = { buy: make("buy"), sell: make("sell") };
  const until = async (controller: ActionController<CurveTradeInput>, phase: string) => {
    for (let turn = 0; turn < 300 && controller.getState().phase !== phase; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(controller.getState().phase, phase);
  };
  const approve = (controller: ActionController<CurveTradeInput>) => {
    const state = controller.getState();
    if (state.phase === "review") controller.approve(state.review.id);
  };
  controllers.sell.submit();
  await until(controllers.sell, "review");
  if (sellPhase === "rejected") {
    approve(controllers.sell);
    await until(controllers.sell, "rejected");
    answer = "sign";
  }
  controllers.buy.submit();
  await until(controllers.buy, "review");
  approve(controllers.buy);
  await until(controllers.buy, "ambiguous");
  assert.equal(fixture.calls.execute, 1);
  const curve = await readCurve(fixture.client, deployment, TRADE_LAUNCH_ID, 1_790_000_000_000);
  let session: CurveTradeSession | null = null;
  function Capture() {
    session = useCurveTrade();
    return null;
  }
  const html = renderToStaticMarkup(
    <LaunchpadSignerProvider kinds={["wallet"]} renderBridge={() => null}>
      <CurveTradeProvider chain={chain} launchId={TRADE_LAUNCH_ID} initialCurve={curve} controllers={controllers} report={() => {}}>
        <CurveTradeRail />
        <Capture />
      </CurveTradeProvider>
    </LaunchpadSignerProvider>,
  );
  const sell = /id="trade-panel-sell"[\s\S]*$/.exec(html)?.[0] ?? "";
  return { fixture, controllers, session: session! as CurveTradeSession, sell };
}

test("while a buy is unresolved, a sell review opened before it cannot be signed: the button is disabled and approve does nothing", async () => {
  const { fixture, controllers, session, sell } = await sellThenLostBuy("review");
  assert.match(sell, /A buy is still unresolved on Sui/);
  assert.match(sell, /<button[^>]*disabled=""[^>]*>Sell and sign<\/button>/);
  const review = session.controllers.sell.getState();
  assert.equal(review.phase, "review");
  if (review.phase === "review") session.controllers.sell.approve(review.review.id);
  await settle();
  const after = controllers.sell.getState();
  assert.equal(after.phase, "review");
  // Not even reconfirmed: the gated approve never re-read Sui or replaced the open review.
  assert.equal(after.phase === "review" && review.phase === "review" ? after.review.id : null, review.phase === "review" ? review.review.id : "no review");
  assert.equal(fixture.calls.execute, 1);
});

test("while a buy is unresolved, a declined sell's 'Review again' is disabled and submit opens nothing", async () => {
  const { fixture, controllers, session, sell } = await sellThenLostBuy("rejected");
  assert.match(sell, /<button[^>]*disabled=""[^>]*>Review again<\/button>/);
  session.controllers.sell.submit();
  await settle();
  assert.equal(controllers.sell.getState().phase, "rejected");
  session.controllers.sell.chooseSigner("wallet");
  await settle(50);
  assert.equal(controllers.sell.getState().phase, "rejected");
  assert.equal(fixture.calls.execute, 1);
  // Reconciling the buy by digest lifts the gate.
  session.controllers.buy.recheck();
  for (let turn = 0; turn < 300 && controllers.buy.getState().phase !== "succeeded"; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controllers.buy.getState().phase, "succeeded");
  session.controllers.sell.submit();
  for (let turn = 0; turn < 300 && controllers.sell.getState().phase !== "review"; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controllers.sell.getState().phase, "review");
  assert.equal(fixture.calls.execute, 1);
});
