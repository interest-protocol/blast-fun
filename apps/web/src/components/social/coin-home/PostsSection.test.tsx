import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { installTestDom, testEvent } from "../../../../test/fixtures/social/test-dom.ts";
import { feedItem, feedPage, FIXTURE_NOW } from "../../../../test/fixtures/social/feed-fixtures.ts";
import { QueryProvider } from "#web/lib/query/provider.tsx";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { PostsSection } = await import("./PostsSection");
const { HomeSections } = await import("./HomeSections");
const { parseHomeSections } = await import("./home-sections");

test("Posts shares table controls, pages beyond the server seed, keeps links and retries a failed next page", async t => {
  const client = new QueryClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const originalFetch = globalThis.fetch;
  let fail = true;
  let hold = false;
  let release: () => void = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  const requests: string[] = [];
  const initial = feedPage({ items: Array.from({ length: 20 }, (_, i) => feedItem({
    entry_id: `a:${5000 - i}:1:0:0`,
    ...(i === 0 ? { kind: "presale_opened", actor: null } : i === 1 ? { actor: { type: "address", address: "0x123", short: "0x1…123" } } : {}),
  })) });
  globalThis.fetch = async input => {
    if (!String(input).startsWith("/api/social/feed?")) return new Response("{}", { status: 503 });
    requests.push(String(input));
    if (hold) await pending;
    return fail ? new Response("{}", { status: 503 }) : Response.json(feedPage({ items: [feedItem({ entry_id: "a:4900:1:0:0", why: { why_id: "f0010000-0000-4000-8000-000000000001", text: "Last post" } })], next_cursor: null }));
  };
  t.after(async () => { await act(async () => root.unmount()); container.remove(); client.clear(); globalThis.fetch = originalFetch; });
  const click = async (selector: string) => act(async () => {
    const button = container.querySelector(selector);
    assert.ok(button, selector);
    button.dispatchEvent(testEvent("click", { detail: 1 }));
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  await act(async () => root.render(<QueryProvider client={client}><PostsSection initial={initial} nowMs={FIXTURE_NOW} /></QueryProvider>));
  assert.equal(requests.length, 0, "server seed avoids a duplicate read");
  assert.equal(container.querySelectorAll('ol[aria-label="Posts"] li').length, 5);
  const authors = container.querySelectorAll(".postAuthor");
  assert.ok(authors[0].querySelector(".mk"), "presale announcements use the coin image as their author image");
  assert.ok(authors[1].querySelector(".wav"), "unnamed wallets retain their identity image");
  assert.ok(authors[2].querySelector(".av"), "account authors retain their profile picture");
  assert.ok(container.querySelector('[data-table-footer]'));
  assert.ok(container.querySelector('a[href="/p/a-5000-1-0-0"]'));
  assert.ok(container.querySelector('a[href="/@mirachen"]'));
  assert.ok(container.querySelector('a[href^="/presale/"]'));
  for (let page = 2; page <= 4; page++) await click('[aria-label="Next page"]');
  assert.equal(requests.length, 0);
  await click('[aria-label="Next page"]');
  assert.match(container.textContent ?? "", /Posts couldn’t load/);
  assert.equal(container.querySelector('[aria-current="page"]')?.textContent, "4", "failed reads preserve the page");
  fail = false;
  hold = true;
  await click('[aria-label="Next page"]');
  await click('[aria-label="Previous page"]');
  assert.equal(container.querySelector('[aria-current="page"]')?.textContent, "3");
  await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 30)); });
  assert.equal(container.querySelector('[aria-current="page"]')?.textContent, "3", "an answered request does not undo a newer page choice");
  await click('[aria-label="Next page"]');
  await click('[aria-label="Next page"]');
  assert.match(requests.at(-1) ?? "", /cursor=cursor-1/);
  assert.match(container.querySelector('ol[aria-label="Posts"]')?.textContent ?? "", /Last post/);
  assert.equal(container.querySelectorAll('ol[aria-label="Posts"] li').length, 1);
  assert.equal(container.querySelector('[aria-label="Next page"]')?.hasAttribute("disabled"), true);
  await click('[aria-label="Previous page"]');
  assert.equal(container.querySelectorAll('ol[aria-label="Posts"] li').length, 5);
});

test("hidden Posts never mounts or reads; Customize Home can restore it in its saved position", async t => {
  const client = new QueryClient();
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; return Response.json(feedPage({ items: [], next_cursor: null })); };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); client.clear(); globalThis.fetch = originalFetch; });
  const render = (hidden: boolean) => act(async () => {
    root.render(<QueryProvider client={client}><HomeSections prefs={parseHomeSections(`-coins.-traders.${hidden ? "-" : ""}posts`)} empty={<p>Hidden</p>} sections={{ coins: { children: null }, bonding: { children: null }, traders: { children: null }, posts: { children: <PostsSection initial={null} nowMs={FIXTURE_NOW} /> } }} /></QueryProvider>);
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  await render(true);
  assert.equal(requests, 0);
  assert.equal(container.querySelector('[data-section="posts"]'), null);
  await render(false);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  assert.equal(requests, 1);
  assert.ok(container.querySelector('[data-section="posts"]'));
  assert.match(container.textContent ?? "", /No posts yet/);
});
