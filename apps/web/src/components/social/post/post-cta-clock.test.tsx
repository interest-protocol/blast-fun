import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

const { document, window } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
const { FeedOverlaysProvider } = await import("../feed-ui/shell-bridge");
const { feedItem, fixturePresale, FIXTURE_NOW } = await import("../../../../test/fixtures/social/feed-fixtures.ts");
const { PostCard } = await import("./PostCard");

/** #588: a post's "Blast" for a sale scheduled to open later starts charging at the start, with the page left open. */

/** A press that starts a hold asks the kit for a fresh quote (`useHeldBlast`'s `onPress`); a button without the hold asks nothing. */
const wants: string[] = [];
const kit = { signedIn: true, quotes: { peek: () => ({ facts: null }), want: (presaleId: string) => void wants.push(presaleId) } };

test("the Blast button's hold turns on when the sale's start passes, with no new read", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: FIXTURE_NOW });
  const item = feedItem({ presale: fixturePresale({ lifecycle: "open", start_ms: FIXTURE_NOW + 5_000 }) });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(
    <PathnameContext value="/">
      <FeedOverlaysProvider value={{ openCommit: () => undefined, commitKit: kit as never }}>
        <PostCard item={item} nowMs={FIXTURE_NOW} />
      </FeedOverlaysProvider>
    </PathnameContext>,
  ));
  const blast = () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Blast")!;
  const press = async () => {
    wants.length = 0;
    await act(async () => { blast().dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true, pointerId: 1, pointerType: "mouse" })); });
    await act(async () => { blast().dispatchEvent(new window.PointerEvent("pointercancel", { bubbles: true, pointerId: 1, pointerType: "mouse" })); });
    return wants.length > 0;
  };
  assert.equal(await press(), false, "not open yet: a tap opens the dialog, a hold does nothing");
  await act(async () => t.mock.timers.tick(4_999));
  assert.equal(await press(), false);
  await act(async () => t.mock.timers.tick(1));
  assert.equal(await press(), true, "open from its start");
});
