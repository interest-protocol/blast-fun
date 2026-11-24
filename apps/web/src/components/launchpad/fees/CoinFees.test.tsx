import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";
import { poll, requests } from "../../../../test/fixtures/launchpad/fees/refresh-fixture.ts";

const fixtureUrl = import.meta.resolve("../../../../test/fixtures/launchpad/fees/refresh-fixture.ts");
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith("/fees/CoinFees.tsx") && ["./fees-client", "../use-market-poll", "../blast-infra-browser"].includes(specifier)) {
    return { shortCircuit: true, url: fixtureUrl };
  }
  return next(specifier, context);
} });
installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CoinFees } = await import("./CoinFees");

async function mount(t: test.TestContext) {
  requests.length = 0;
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(<CoinFees source={{ launchId: "0x1", expected: null, units: { symbol: "WAL", memeDecimals: 9, quoteSymbol: "SUI", quoteDecimals: 9 } }} />));
  return container.querySelector<HTMLButtonElement>("button")!;
}

test("a failed manual fee refresh releases its busy state and permits retry", async t => {
  const button = await mount(t);
  await act(async () => button.click());
  assert.equal(button.getAttribute("aria-busy"), "true");
  await act(async () => requests[0]!.reject(new Error("offline")));
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute("aria-busy"), null);
  await act(async () => button.click());
  assert.equal(requests.length, 2);
  await act(async () => requests[1]!.resolve({ kind: "failed", reason: "unavailable" }));
  assert.equal(button.disabled, false);
});

test("a newer poll does not strand the manual refresh indicator", async t => {
  const button = await mount(t);
  await act(async () => button.click());
  await act(async () => poll.refresh(null));
  await act(async () => requests[1]!.resolve({ kind: "failed", reason: "unavailable" }));
  assert.equal(button.getAttribute("aria-busy"), "true", "the manual request still owns its indicator");
  await act(async () => requests[0]!.reject(new Error("offline")));
  assert.equal(button.getAttribute("aria-busy"), null);
  assert.equal(button.disabled, false);
});
