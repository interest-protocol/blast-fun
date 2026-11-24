import assert from "node:assert/strict";
import test from "node:test";
import type { ReactNode } from "react";

import { installTestDom, type TestElement } from "../../../test/fixtures/social/test-dom.ts";

/**
 * OA-28 M5: the feed list is virtual in the browser (react-virtuoso, scrolled
 * by the window). The server and hydration draw the plain list (Virtuoso's
 * inline styles would be refused by the CSP); after hydration the virtual
 * list takes over from the same rows. Paging is unchanged: the sentinel below
 * the list asks for the next keyset page, and "Show more" is the keyboard's.
 *
 * jsdom has no layout (every box is zero), so
 * these pin the server's markup, the browser's structure and the paging; the
 * hand-over at hydration, the window, the drawn range and the pixels are the
 * browser check's.
 */

const dom = installTestDom();

/** The sentinel's observers, so a test can say "the end of the list came near". */
const observers: { callback: IntersectionObserverCallback; targets: unknown[] }[] = [];
class CapturingObserver {
  readonly targets: unknown[] = [];
  constructor(readonly callback: IntersectionObserverCallback) {
    observers.push(this);
  }
  observe(target: unknown) {
    this.targets.push(target);
  }
  unobserve() {}
  disconnect() {
    this.targets.length = 0;
  }
  takeRecords() {
    return [];
  }
}
Object.defineProperty(globalThis, "IntersectionObserver", { value: CapturingObserver, configurable: true, writable: true });
Object.defineProperty(dom.window, "IntersectionObserver", { value: CapturingObserver, configurable: true, writable: true });

const requests: string[] = [];
let answer: (url: URL) => Response = () => new Response("{}", { status: 404 });
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(String(input), "http://127.0.0.1");
  if (url.pathname === "/api/social/card-identities") return json(Object.fromEntries(url.searchParams.get("callsigns")!.split(",").map((callsign) => [callsign, null])));
  requests.push(`${url.pathname}${url.search}`);
  return answer(url);
}) as typeof fetch;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToString } = await import("react-dom/server");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
const { queryKeys } = await import("#web/lib/query/keys.ts");
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { feedItem, feedPage, FIXTURE_NOW } = await import("../../../test/fixtures/social/feed-fixtures.ts");
const { FeedList } = await import("./FeedList");
const { feedItems } = await import("./feed-query");

const ENDPOINT = "/api/social/feed?tab=for_you";
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 40)));

/** The list's query (OA-38), one per mount. */
let client = createTestQueryClient();

/** What the list holds (its query's pages): every loaded row, drawn or not. */
const loaded = () => feedItems(client.getQueryData(queryKeys.feed.list(ENDPOINT))).map((item) => item.entry_id);

function tree(initial: ReturnType<typeof feedPage> | null): ReactNode {
  return withQueryClient(
    client,
    <PathnameContext value="/">
      <FeedList endpoint={ENDPOINT} heading="Home feed" initial={initial} nowMs={FIXTURE_NOW} />
    </PathnameContext>,
  );
}

const rows = (root: TestElement) => [...root.querySelectorAll<HTMLElement>("li[data-post]")];
const virtual = (root: TestElement) => root.querySelector<HTMLElement>("[data-virtuoso-scroller]");

async function mount(initial: ReturnType<typeof feedPage> | null) {
  observers.length = 0;
  requests.length = 0;
  client = createTestQueryClient();
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(tree(initial)));
  await settle();
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.parentNode?.removeChild(container);
    },
  };
}

test("the server (and so hydration) draws the plain list: no inline style for the CSP to refuse, no virtual wrapper", () => {
  const html = renderToString(tree(feedPage()));
  assert.doesNotMatch(html, /\sstyle="/);
  assert.doesNotMatch(html, /data-virtuoso|data-index/);
  const markup = dom.document.createElement("template");
  markup.innerHTML = html;
  const section = [...markup.content.children].find((node) => node.matches('section.feed[aria-label="Home feed"]'));
  assert.equal(section?.getAttribute("aria-busy"), "false");
  assert.ok(section?.querySelector(':scope > ol.list > li[data-post="a:5000:1:0:0"]:first-child > article'));
});

test("in the browser the same rows are the virtual list's, in order", async () => {
  const { container, unmount } = await mount(feedPage());
  try {
    assert.ok(virtual(container), "Virtuoso's window-scrolled list");
    assert.deepEqual(rows(container).map((row) => row.getAttribute("data-post")), ["a:5000:1:0:0", "a:4999:1:0:0"]);
  } finally {
    await unmount();
  }
});

test("a11y: one labelled section, an ordered list whose drawn rows say where they sit in the loaded list", async () => {
  const { container, unmount } = await mount(feedPage());
  try {
    const section = container.querySelector("section")!;
    assert.equal(section.getAttribute("aria-label"), "Home feed");
    assert.equal(section.getAttribute("aria-busy"), "false");
    const list = virtual(container)!.querySelector("ol")!;
    assert.ok(list.className.split(/\s+/).includes("list"), "the plain list's class (and its 13 px gap)");
    assert.deepEqual(
      rows(container).map((row) => [row.getAttribute("aria-posinset"), row.getAttribute("aria-setsize"), row.querySelector("article") !== null]),
      [
        ["1", "2", true],
        ["2", "2", true],
      ],
    );
    // The keyboard's way to the next page is still there, after the list.
    assert.ok([...container.querySelectorAll("button")].some((button) => button.textContent === "Show more"));
  } finally {
    await unmount();
  }
});

test("paging is unchanged: the sentinel under the list asks for the next keyset page once, and the rows grow", async () => {
  const { container, unmount } = await mount(feedPage());
  try {
    const page2 = feedPage({ items: [feedItem({ entry_id: "a:4998:1:0:0" }), feedItem({ entry_id: "a:4997:1:0:0" })], next_cursor: null });
    answer = (url) => (url.searchParams.get("cursor") === "cursor-1" ? json(page2) : new Response("{}", { status: 404 }));
    // The sentinel: the empty marker at the end of the list's footer, after every row however many are drawn.
    const watching = observers.filter((observer) => observer.targets.some((target) => (target as TestElement).parentNode === container.querySelector<HTMLElement>(".more")));
    assert.equal(watching.length, 1, "one observer, on the sentinel below the list");
    const sentinel = watching[0]!;
    assert.equal(requests.length, 0, "nothing is read before the end comes near");
    await act(async () => sentinel.callback([{ isIntersecting: true } as IntersectionObserverEntry], sentinel as unknown as IntersectionObserver));
    await settle();
    assert.deepEqual(requests, [`${ENDPOINT}&cursor=cursor-1`]);
    assert.deepEqual(loaded(), ["a:5000:1:0:0", "a:4999:1:0:0", "a:4998:1:0:0", "a:4997:1:0:0"], "the page is appended, in order");
    // Which rows are drawn is the window's business (none here: no layout); each drawn row counts them all.
    assert.ok(rows(container).length > 0 && rows(container).every((row) => row.getAttribute("aria-setsize") === "4"));
    assert.match(container.textContent, /You’re all caught up\./);
    assert.ok(![...container.querySelectorAll("button")].some((button) => button.textContent === "Show more"), "no cursor, no more pages");
  } finally {
    await unmount();
  }
});

test("empty and failed reads: no list at all, the next action, and a retry that keeps what is shown", async () => {
  const empty = await mount(feedPage({ items: [], next_cursor: null }));
  try {
    assert.equal(virtual(empty.container), null);
    assert.equal(empty.container.querySelector("ol"), null);
    assert.match(empty.container.textContent, /Nothing here yet/);
  } finally {
    await empty.unmount();
  }
  answer = () => new Response("{}", { status: 500 });
  const failed = await mount(null);
  try {
    assert.equal(virtual(failed.container), null);
    assert.match(failed.container.textContent, /Couldn’t load posts\./);
    assert.ok([...failed.container.querySelectorAll("button")].some((button) => button.textContent === "Try again"));
  } finally {
    await failed.unmount();
  }
});
