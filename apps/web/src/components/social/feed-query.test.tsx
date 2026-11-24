import assert from "node:assert/strict";
import test from "node:test";
import type { ReactNode } from "react";

import { installTestDom, type TestElement } from "../../../test/fixtures/social/test-dom.ts";

/**
 * OA-38: the feed's keyset pages are one TanStack infinite query
 * (`feed-query.ts`). The server's first page is its initial data (no read on
 * the first paint); each page is read once however often the end comes near
 * or "Show more" is pressed; a list that goes away stops the page it was
 * reading.
 *
 * Every read is held open until the test answers it, so "in flight" is a
 * state the test controls. Layout and pixels are the browser check's.
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

type Read = { url: string; signal: AbortSignal | null; resolve: (response: Response) => void };
const requests: string[] = [];
let reads: Read[] = [];
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input), "http://127.0.0.1");
  if (url.pathname === "/api/social/card-identities") return Promise.resolve(json(Object.fromEntries(url.searchParams.get("callsigns")!.split(",").map((callsign) => [callsign, null]))));
  const path = `${url.pathname}${url.search}`;
  requests.push(path);
  const signal = init?.signal ?? null;
  return new Promise<Response>((resolve, reject) => {
    signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    reads.push({ url: path, signal, resolve });
  });
}) as typeof fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
const { queryKeys } = await import("#web/lib/query/keys.ts");
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { feedItem, feedPage, FIXTURE_NOW } = await import("../../../test/fixtures/social/feed-fixtures.ts");
const { FeedList } = await import("./FeedList");
const { ProfileTabs } = await import("./profile/ProfileTabs");
const { feedItems } = await import("./feed-query");

const ENDPOINT = "/api/social/feed?tab=for_you";
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 30)));

let client = createTestQueryClient();
const shown = () => feedItems(client.getQueryData(queryKeys.feed.list(ENDPOINT))).map((item) => item.entry_id);

/** Answers the first open read whose path matches. */
async function answer(match: RegExp, response: Response) {
  const at = reads.findIndex((read) => match.test(read.url));
  assert.ok(at >= 0, `a read of ${match} is out (out: ${reads.map((read) => read.url).join(", ") || "none"})`);
  const [read] = reads.splice(at, 1);
  read!.resolve(response);
  await settle();
}

/** Mounts `node` with a new query client (or, `again`, the last one: a later visit in the same browser session). */
async function mount(node: ReactNode, again = false) {
  observers.length = 0;
  requests.length = 0;
  reads = [];
  if (!again) client = createTestQueryClient();
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(withQueryClient(client, <PathnameContext value="/">{node}</PathnameContext>)));
  await settle();
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      await settle();
      container.parentNode?.removeChild(container);
    },
  };
}

const list = (initial: ReturnType<typeof feedPage> | null) => <FeedList endpoint={ENDPOINT} heading="Home feed" initial={initial} nowMs={FIXTURE_NOW} />;

/** The observer on the sentinel below the list: `report()` is "the end of the list came near". */
function sentinelOf(container: TestElement) {
  const watching = observers.filter((observer) => observer.targets.some((target) => (target as TestElement).parentNode === container.querySelector<HTMLElement>(".more")));
  assert.equal(watching.length, 1, "one observer, on the sentinel below the list");
  const sentinel = watching[0]!;
  return { report: () => sentinel.callback([{ isIntersecting: true } as IntersectionObserverEntry], sentinel as unknown as IntersectionObserver) };
}

async function nearEnd(container: TestElement) {
  const sentinel = sentinelOf(container);
  await act(async () => sentinel.report());
}

/** Presses the first button whose text has `text`, as the reader would. */
async function press(container: TestElement, text: string, times = 1) {
  const target = button(container, text);
  assert.ok(target, `a "${text}" button`);
  await act(async () => {
    for (let press = 0; press < times; press += 1) target.click();
  });
  await settle();
}

const button = (container: TestElement, text: string) => [...container.querySelectorAll("button")].find((one) => one.textContent?.includes(text)) ?? null;
const PAGE_2 = feedPage({ items: [feedItem({ entry_id: "a:4998:1:0:0" }), feedItem({ entry_id: "a:4999:1:0:0" })], next_cursor: "cursor-2" });

test("the server's first page is the query's data: nothing is read on the first paint, and nothing refetches it", async () => {
  const { container, unmount } = await mount(list(feedPage()));
  try {
    assert.deepEqual(requests, [], "no read on mount");
    assert.deepEqual(shown(), ["a:5000:1:0:0", "a:4999:1:0:0"]);
    // A reconnect and an invalidation of every public read leave the reader's pages alone.
    await act(async () => {
      await client.invalidateQueries({ queryKey: queryKeys.public });
      await client.refetchQueries();
    });
    await settle();
    assert.deepEqual(requests, [], "the pages are the reader's session: nothing reads them behind the reader");
    assert.equal(container.querySelector("section")?.getAttribute("aria-busy"), "false");
  } finally {
    await unmount();
  }
});

test("paging: one request per page however often the end comes near or Show more is pressed; a repeated entry shows once", async () => {
  const { container, unmount } = await mount(list(feedPage()));
  try {
    // The sentinel and the keyboard's Show more, reported and pressed over and over before the list draws again.
    const sentinel = sentinelOf(container);
    const showMore = button(container, "Show more");
    await act(async () => {
      for (let again = 0; again < 3; again += 1) {
        sentinel.report();
        showMore?.click();
      }
    });
    await settle();
    assert.deepEqual(requests, [`${ENDPOINT}&cursor=cursor-1`], "one read of the next page, however often it was asked for");
    assert.equal(container.querySelector("section")?.getAttribute("aria-busy"), "true");
    assert.ok(container.querySelector('[role="status"][aria-label="Loading more posts"]'));
    await answer(/cursor=cursor-1/, json(PAGE_2));
    assert.deepEqual(shown(), ["a:5000:1:0:0", "a:4999:1:0:0", "a:4998:1:0:0"], "the rank moved: a:4999 is not shown twice");
    await nearEnd(container);
    assert.deepEqual(requests, [`${ENDPOINT}&cursor=cursor-1`, `${ENDPOINT}&cursor=cursor-2`], "then the page after it, by the new cursor");
  } finally {
    await unmount();
  }
});

test("a list that goes away stops the page it was reading", async () => {
  const { container, unmount } = await mount(list(feedPage()));
  await nearEnd(container);
  const read = reads.find((one) => /cursor=cursor-1/.test(one.url));
  assert.ok(read?.signal, "the page read carries the query's signal");
  assert.equal(read.signal.aborted, false);
  await unmount();
  assert.equal(read.signal.aborted, true);
});

test("without the server's page the list reads it once; a failed read offers Try again, which reads once", async () => {
  const { container, unmount } = await mount(list(null));
  try {
    assert.deepEqual(requests, [ENDPOINT], "one read of the first page");
    assert.equal(container.querySelectorAll('article[aria-label="Loading post"]').length, 3);
    await answer(/feed\?tab=for_you$/, json({ error: { code: "unavailable" } }, 503));
    assert.match(container.textContent, /Couldn’t load posts\./);
    await press(container, "Try again", 2);
    assert.deepEqual(requests, [ENDPOINT, ENDPOINT], "Try again reads once");
    await answer(/feed\?tab=for_you$/, json(feedPage({ next_cursor: null })));
    assert.deepEqual(shown(), ["a:5000:1:0:0", "a:4999:1:0:0"]);
    assert.match(container.textContent, /You’re all caught up\./);
  } finally {
    await unmount();
  }
});

test("a failed page keeps what is shown and says so until the reader tries again", async () => {
  const { container, unmount } = await mount(list(feedPage()));
  try {
    await nearEnd(container);
    await answer(/cursor=cursor-1/, json({}, 500));
    assert.match(container.textContent, /Couldn’t load more posts\. What’s shown above is unchanged\./);
    assert.deepEqual(shown(), ["a:5000:1:0:0", "a:4999:1:0:0"]);
    await press(container, "Try again");
    assert.deepEqual(requests, [`${ENDPOINT}&cursor=cursor-1`, `${ENDPOINT}&cursor=cursor-1`]);
    await answer(/cursor=cursor-1/, json(PAGE_2));
    assert.doesNotMatch(container.textContent, /Couldn’t load/);
  } finally {
    await unmount();
  }
});

test("a profile tab keeps its cached empty answer while a stale read refreshes", async () => {
  const endpoint = "/api/social/profiles/test/theses";
  const node = <FeedList endpoint={endpoint} heading="Thesis" initial={null} nowMs={FIXTURE_NOW} empty={<p>No thesis yet.</p>} />;
  const first = await mount(node);
  assert.match(first.container.textContent!, /Loading posts/);
  assert.doesNotMatch(first.container.textContent!, /No thesis yet/);
  await answer(/profiles\/test\/theses/, json(feedPage({ items: [], next_cursor: null })));
  assert.match(first.container.textContent!, /No thesis yet/);
  assert.equal(first.container.querySelector('section[aria-label="Thesis"] > p')?.textContent, "No thesis yet.", "a custom empty panel owns its layout without a second padded wrapper");
  await first.unmount();
  client.setQueryData(queryKeys.feed.list(endpoint), client.getQueryData(queryKeys.feed.list(endpoint)), { updatedAt: 1 });
  const second = await mount(node, true);
  try {
    assert.match(second.container.textContent!, /No thesis yet/);
    assert.doesNotMatch(second.container.textContent!, /Loading posts/);
    assert.deepEqual(requests, [endpoint], "stale data refreshes in the background");
    await answer(/profiles\/test\/theses/, json(feedPage({ items: [feedItem()], next_cursor: null })));
    assert.doesNotMatch(second.container.textContent!, /No thesis yet/);
    assert.equal(feedItems(client.getQueryData(queryKeys.feed.list(endpoint))).length, 1);
  } finally {
    await second.unmount();
  }
});

test("a profile revisit remembers the selected tab and its answered empty result", async () => {
  const node = <ProfileTabs callsign="tab-audit" calls={{ status: "none" }} nowMs={FIXTURE_NOW} />;
  const first = await mount(node);
  // The Profile board's sections: Calls replaced Thesis, so the feed-backed tab is Activity.
  await press(first.container, "Activity");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 140)));
  await answer(/\/items/, json(feedPage({ items: [], next_cursor: null })));
  assert.match(first.container.textContent!, /No public activity yet/);
  await first.unmount();
  const second = await mount(node, true);
  try {
    assert.match(second.container.textContent!, /No public activity yet/);
    assert.equal(button(second.container, "Activity")?.getAttribute("aria-pressed"), "true");
    assert.deepEqual(requests, [], "the tab reuses its fresh answer");
  } finally {
    await second.unmount();
  }
});
