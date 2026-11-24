import assert from "node:assert/strict";
import test from "node:test";
import {
  installTestDom,
  testEvent,
} from "../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { PresalesControls } = await import("./PresalesControls");

test("view tabs associate with panels and arrow focus waits for explicit activation", async (t) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const choices: string[] = [];
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const render = (view: "list" | "calendar" | "backed") => (
    <PresalesControls
      featured={<section aria-label="Featured presales">Featured</section>}
      onChoose={(value) => choices.push(value)}
      onView={(value) => choices.push(value)}
      sort="ending"
      status="live"
      view={view}
    >
      <div>Results</div>
    </PresalesControls>
  );
  await act(async () => root.render(render("list")));
  const navigation = container.querySelector('[aria-label="View"]')!;
  assert.deepEqual([...navigation.querySelectorAll("button, a")].map(item => item.textContent), ["Browse", "Calendar", "Backed"]);
  assert.equal(navigation.querySelectorAll("a").length, 0);
  const tabs = [
    ...container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ];
  assert.deepEqual(tabs.map((tab) => tab.textContent), ["Live", "Upcoming", "Ended"]);
  for (const tab of tabs) {
    const panel = document.getElementById(tab.getAttribute("aria-controls")!);
    assert.equal(panel?.getAttribute("role"), "tabpanel");
    assert.equal(panel?.getAttribute("aria-labelledby"), tab.id);
  }
  // The catalog controls precede the optional feature.
  assert.ok(
    tabs[0].compareDocumentPosition(container.querySelector("section")!) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  );
  await act(async () => {
    tabs[0].focus();
    tabs[0].dispatchEvent(testEvent("keydown", { key: "ArrowRight" }));
  });
  assert.equal(document.activeElement, tabs[1]);
  assert.equal(tabs[0].getAttribute("aria-selected"), "true");
  assert.deepEqual(choices, []);
  await act(async () => tabs[1].click());
  assert.deepEqual(choices, ["upcoming"]);
  await act(async () => root.render(render("calendar")));
  assert.equal(container.querySelector('[aria-label="View"] button[aria-pressed="true"]')?.textContent, "Calendar");
  assert.equal(container.querySelectorAll('[aria-label="View"] button').length, 3);
  await act(async () => root.render(render("backed")));
  assert.equal(container.querySelector('[aria-label="View"] button[aria-pressed="true"]')?.textContent, "Backed");
  assert.equal(container.querySelectorAll('[role="tablist"]').length, 0);
  const backed = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="View"] button')].find(b => b.textContent === "Browse")!;
  await act(async () => backed.click());
  assert.equal(choices.at(-1), "list");
  await act(async () => root.render(render("list")));
  assert.equal(navigation.querySelectorAll('button[aria-pressed="true"]').length, 1);
  assert.equal(navigation.querySelector('button[aria-pressed="true"]')?.textContent, "Browse");
  assert.equal(container.querySelectorAll('[aria-label="View"] button:not(:disabled)').length, 3);
  assert.equal(
    container.querySelectorAll('[role="tab"][aria-selected="true"]').length,
    1,
  );
  assert.equal(container.querySelector('[aria-label="View"]')?.closest("[inert]"), null);
  assert.ok(
    !container.querySelector(
      '[role="tabpanel"]:not([hidden]) [aria-label^="Sort presales:"]',
    ),
  );
  // The status tabs carry no counts: the list below already shows what is there.
  assert.equal(container.querySelector('[role="tab"] .presale-view-count'), null);
  assert.equal(container.querySelector(".presale-view-ind")?.hasAttribute("data-tab-indicator"), true, "the thumb stays still during keyboard navigation");
});


test("Watchlist passes the activation event so guests can open sign-in", async (t) => {
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  let activated = false;
  await act(async () => root.render(<PresalesControls sort="pinned" status="live" view="list" watchlist
    onScope={(scope, event) => {
      assert.equal(scope, "watch");
      assert.equal(event?.currentTarget.textContent, "Watchlist only");
      activated = true;
    }}
  />));
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label^="Filters"]')!.click());
  await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent === "Watchlist only")!.click());
  assert.equal(activated, true);
});

test("selection scrolls only the tab row to reveal an offscreen active tab", async (t) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const render = (status: "live" | "ended") => <PresalesControls onChoose={() => undefined} onView={() => undefined} sort={status === "live" ? "ending" : "recent"} status={status} view="list">Results</PresalesControls>;
  await act(async () => root.render(render("live")));
  const list = container.querySelector<HTMLElement>('[role="tablist"]')!;
  const tabs = container.querySelectorAll<HTMLElement>('[role="tab"]');
  list.getBoundingClientRect = () => ({ left: 20, right: 300 } as DOMRect);
  tabs[2].getBoundingClientRect = () => ({ left: 280, right: 390 } as DOMRect);
  await act(async () => root.render(render("ended")));
  assert.equal(list.scrollLeft, 90, "reveal the right edge of Ended");
  tabs[0].getBoundingClientRect = () => ({ left: -70, right: 10 } as DOMRect);
  await act(async () => root.render(render("live")));
  assert.equal(list.scrollLeft, 0, "reveal Live when returning from the right");
});
