import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

/**
 * An open coin page re-reads itself the moment its own coin's identity (name,
 * symbol, description or icon) changes on chain: the tab's hint stream names
 * the coin, and only that coin's change refreshes the page. Its 30 s refresh
 * stays for everything else.
 */

installTestDom();

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const { infraProvenanceFixture } = await import("../../../../../../packages/server/test/fixtures/modules/launchpad-contract/fixtures.ts");
const { CoinLive } = await import("./CoinLive.tsx");

const COIN = `0x${"3f".repeat(32)}::froggy::FROGGY`;
const OTHER = `0x${"4e".repeat(32)}::toad::TOAD`;

test("a coin page refreshes at once on its own coin's identity change, and on nothing else the stream hints", async () => {
  const beforeSource = globalThis.EventSource;
  const sources: { onmessage: ((event: { data: string }) => void) | null; onerror: (() => void) | null }[] = [];
  class FakeEventSource {
    onmessage = null;
    onerror = null;
    constructor(url: string) {
      assert.equal(url, "/api/social/activity/hints");
      sources.push(this);
    }
    close() {}
  }
  let refreshes = 0;
  const router = { bfcacheId: "test", back() {}, forward() {}, refresh() { refreshes += 1; }, hmrRefresh() {}, push() {}, replace() {}, prefetch: async () => {} };
  const receive = (frame: unknown) => sources[0]!.onmessage?.({ data: JSON.stringify(frame) });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    Object.defineProperty(globalThis, "EventSource", { value: FakeEventSource, configurable: true, writable: true });
    await act(async () => root.render(
      <AppRouterContext value={router}>
        <CoinLive launchId={`0x${"a1".repeat(32)}`} coinType={COIN} tradable={false} refreshMs={60_000} />
      </AppRouterContext>,
    ));
    assert.equal(sources.length, 1, "the page joins the tab's one hint stream");
    await act(async () => {
      receive({ type: "hello", provenance: infraProvenanceFixture({ deployment_fingerprint: null }) });
      receive({ type: "pong" });
    });
    assert.equal(refreshes, 0, "connecting is no reason to re-read the page");
    await act(async () => {
      receive({ type: "activity", activity_id: "326274010:1:0:0" });
      receive({ type: "metadata", coin: OTHER, cursor: "326274010:2:4294967295:0" });
    });
    assert.equal(refreshes, 0, "another coin's change and other activity leave the page alone");
    await act(async () => receive({ type: "metadata", coin: COIN, cursor: "326274010:3:4294967295:0" }));
    assert.equal(refreshes, 1, "its own coin's change re-reads the page at once");
    await act(async () => receive({ type: "metadata", coin: COIN, cursor: "326274010:3:4294967295:0" }));
    assert.equal(refreshes, 1, "the same change re-reads it once");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Object.defineProperty(globalThis, "EventSource", { value: beforeSource, configurable: true, writable: true });
  }
});
