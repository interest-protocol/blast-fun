import assert from "node:assert/strict";
import test from "node:test";

import { createTestQueryClient } from "#web/lib/query/test-client.ts";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";
import type { CommitFacts, CommitKit } from "../commit/commit-kit.ts";
import { createCommitQuotes, type CommitQuoteOptions } from "../commit/commit-quote.ts";

const { document, window } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
const { FeedOverlaysProvider } = await import("../feed-ui/shell-bridge");
const { feedItem, fixturePresale, FIXTURE_NOW } = await import("../../../../test/fixtures/social/feed-fixtures.ts");
const { PostCard } = await import("./PostCard");

/** #588: a post's "Blast" for a sale scheduled to open later starts charging at the start, with the page left open. */

test("the Blast button's hold turns on when the sale's start passes, with no new read", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: FIXTURE_NOW });
  const presale = fixturePresale({ lifecycle: "open", start_ms: FIXTURE_NOW + 5_000 });
  const item = feedItem({ presale });
  const client = createTestQueryClient();
  const read = t.mock.fn<CommitQuoteOptions<CommitFacts>["read"]>(async () => null);
  const quotes = createCommitQuotes<CommitFacts>({ client, read });
  const kit: CommitKit = {
    signedIn: true,
    quotes,
    signIn: () => assert.fail("the viewer is signed in"),
    deposit: () => assert.fail("a hold cannot open the deposit sheet"),
    quotePayment: async () => assert.fail("the hold is cancelled"),
    send: async () => assert.fail("the hold is cancelled"),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    quotes.dispose();
    client.clear();
    container.remove();
  });
  await act(async () => root.render(
    <PathnameContext value="/">
      <FeedOverlaysProvider value={{ openCommit: () => undefined, commitKit: kit }}>
        <PostCard item={item} nowMs={FIXTURE_NOW} />
      </FeedOverlaysProvider>
    </PathnameContext>,
  ));
  const blast = () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Blast")!;
  const press = async () => {
    await act(async () => { blast().dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true, pointerId: 1, pointerType: "mouse" })); });
    await act(async () => { blast().dispatchEvent(new window.PointerEvent("pointercancel", { bubbles: true, pointerId: 1, pointerType: "mouse" })); });
  };
  await press();
  assert.equal(read.mock.callCount(), 0, "not open yet: a tap opens the dialog, a hold does nothing");
  await act(async () => t.mock.timers.tick(4_999));
  await press();
  assert.equal(read.mock.callCount(), 0);
  await act(async () => t.mock.timers.tick(1));
  assert.equal(read.mock.callCount(), 0, "opening does not fetch a quote on its own");
  await press();
  assert.equal(read.mock.callCount(), 1, "a hold reads the quote from the sale's start");
  assert.equal(read.mock.calls[0]?.arguments[0], presale.presale_id);
});
