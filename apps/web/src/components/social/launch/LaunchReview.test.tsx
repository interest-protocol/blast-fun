import assert from "node:assert/strict";
import test from "node:test";

import { CREATE_SUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import type { LaunchRules } from "@blast/core/modules/social/launch/model.ts";
import { LAUNCH_PUBLISH_STEPS } from "@blast/core/web/contracts/launch.ts";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

const dom = installTestDom();
// jsdom has no AnimationEvent constructor; React otherwise uses a vendor event.
Object.defineProperty(dom.window, "AnimationEvent", { value: dom.window.Event });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { LaunchAside, LaunchSheet } = await import("./LaunchReview");
const { initialLaunchState, launchPublishAction } = await import("./launch-store");
type LaunchState = import("./launch-store").LaunchState;

const RULES: LaunchRules = {
  meme_decimals: [6, 9],
  quote_fee_bps: 100,
  meme_fee_bps: 50,
  protocol_meme_bps: 250,
  protocol_quote_bps: 150,
  creation_fee: "1000000000",
  protocol_fee_share_bps: 6_500,
  pool_fee_meme_bps: 5_000,
  pool_fee_quote_bps: 1_500,
  quotes: [CREATE_SUI_QUOTE_TYPE],
  cetus_tiers: { [CREATE_SUI_QUOTE_TYPE]: [[200, 10_000]] },
  bluefin_options: { status: "ready", min_tick: -443_636, max_tick: 443_636 },
};

function review(change: Partial<LaunchState> = {}): LaunchState {
  const base = initialLaunchState({ rules: RULES, publish: { available: true, reasons: [] } });
  return { ...base, phase: "ready", step: "review", draftId: "00000000-0000-4000-8000-000000000101", version: 2, logoUrl: "https://blob.example/pip.webp", draft: { ...base.draft, name: "Pip", symbol: "PIP" }, ...change };
}

/** Review's Launch on the page, with a count of launches the page ran. */
async function mountLaunch(t: import("node:test").TestContext) {
  const container = dom.document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  dom.document.body.append(container);
  const root = createRoot(container);
  const sent = { launches: 0 };
  const launch = () => {
    sent.launches += 1;
  };
  launchPublishAction.set(launch);
  const render = (state: LaunchState) => act(async () => root.render(<LaunchAside placement="page" state={state} />));
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
    launchPublishAction.set(null);
  });
  const button = () => container.querySelector<HTMLButtonElement>("[data-launch]")!;
  return { container, sent, render, button };
}

test("Launch: the money sentence sits right above Launch; one press starts the launch immediately", async (t) => {
  const screen = await mountLaunch(t);
  const state = review();
  await screen.render(state);
  const cost = screen.container.querySelector(".cr-cost");
  assert.equal(cost?.textContent, "You pay a 1\u00a0SUI creation fee. Launching locks the curve and pool.");
  assert.equal(cost?.nextElementSibling, screen.button(), "the sentence is directly above Launch");
  await act(async () => screen.button().click());
  assert.equal(screen.sent.launches, 1);
});

test("Launch: the ticker in the money sentence takes the shared class, so a long one wraps inside the rail", async (t) => {
  const screen = await mountLaunch(t);
  const base = review();
  await screen.render(review({ draft: { ...base.draft, first_buy: 1 } }));
  const cost = screen.container.querySelector(".cr-cost")!;
  assert.match(cost.textContent!, /and get at least .+\u00a0PIP\. Launching locks the curve and pool\.$/);
  assert.deepEqual([...cost.querySelectorAll(".ticker")].map((node) => node.textContent), ["PIP"]);
});

test("the launch sheet shows progress and wallet prompts only: no second Launch and no money sentence", () => {
  const state = review({ sheetOpen: true, publishStep: LAUNCH_PUBLISH_STEPS[0]! });
  const running = renderToStaticMarkup(<LaunchSheet onLaunch={() => undefined} state={state} />);
  assert.doesNotMatch(running, />Launch</);
  assert.doesNotMatch(running, /You pay/);
  assert.match(running, /Follow your wallet’s prompts/);
  const failed = renderToStaticMarkup(<LaunchSheet onLaunch={() => undefined} state={{ ...state, publishError: "Rejected in the wallet." }} />);
  assert.match(failed, />Resume launching</);
});

test("a live confirmed launch plays the scene and flight before the success sheet; a restored launch does not replay", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const container = dom.document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  dom.document.body.append(container);
  const root = createRoot(container);
  const running = review({ sheetOpen: true, publishStep: "create_launch" });
  const done = { ...running, publishedLaunchId: `0x${"1".repeat(64)}` };
  const render = (state: LaunchState) => act(async () => root.render(<LaunchSheet onLaunch={() => undefined} state={state} />));
  const tick = (ms: number) => act(async () => { t.mock.timers.tick(ms); });
  try {
    await render(running);
    await render(done);
    assert.ok(container.querySelector(".cr-launch-scene"));
    assert.equal(container.querySelector(".cr-launch-flight"), null);
    assert.equal(container.querySelector('a[href^="/coin/"]'), null);
    await tick(1200);
    const rocket = container.querySelector<HTMLElement>(".cr-launch-rocket");
    assert.ok(rocket);
    await tick(6000);
    assert.equal(container.querySelector('a[href^="/coin/"]'), null, "the sheet waits for the rocket to land");
    await act(async () => { rocket.querySelector("img")!.dispatchEvent(new dom.window.Event("animationend", { bubbles: true })); });
    assert.equal(container.querySelector('a[href^="/coin/"]'), null, "an animation inside the rocket does not land it");
    await act(async () => { rocket.dispatchEvent(new dom.window.Event("animationend", { bubbles: true })); });
    assert.ok(container.querySelector('a[href^="/coin/"]'), "View coin shows as soon as the rocket lands");
    assert.ok(container.querySelector(".cr-launch-seal"), "the scene stays, sealed, above the confirmed steps");
    assert.ok(container.querySelector(".cr-launch-steps"));
    await render(running);
    await render(done);
    await tick(1200);
    assert.ok(container.querySelector(".cr-launch-flight"));
    await tick(9000);
    assert.ok(container.querySelector('a[href^="/coin/"]'), "a flight that never lands still releases the sheet");
    await act(async () => root.unmount());
    const restored = createRoot(container);
    try {
      await act(async () => restored.render(<LaunchSheet onLaunch={() => undefined} state={done} />));
      assert.ok(container.querySelector('a[href^="/coin/"]'));
      assert.equal(container.querySelector(".cr-launch-flight"), null, "a restored launch does not replay the flight");
    } finally {
      await act(async () => restored.unmount());
    }
  } finally {
    container.remove();
  }
});
