import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom, setInputValue, testEvent } from "../../../../test/fixtures/social/test-dom.ts";
import type { SocialProfile } from "@blast/core/modules/social/contracts/profiles.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { createTestQueryClient, settleQueries } = await import("#web/lib/query/test-client.ts");
const { SocialViewerProvider } = await import("../SignInGate");
const { ViewerStateStore } = await import("../viewer-state-store");
const { ConnectionsView } = await import("./ConnectionsView");
const { ProfileConnectionCounts } = await import("./ProfileConnectionCounts");

const profile: SocialProfile = { callsign: "kai", display_name: "Kai", avatar_url: null, verified: true, x_handle: null, private: false, portfolio_public: false, as_of: { checkpoint: 1, timestamp_ms: 1, lag_ms: 0 } };
const account = (callsign: string) => ({ callsign, display_name: callsign.toUpperCase(), avatar_url: null, verified: true, private: false });
const page = (accounts = [account("kai"), account("nova")], next_cursor: string | null = null) => ({ accounts, next_cursor });

test("connections render URL tabs, counts, paging, real search and no self-follow", async (t) => {
  t.mock.method(ViewerStateStore.prototype, "want", () => undefined);
  const reads: URL[] = [];
  t.mock.method(globalThis, "fetch", async (path: string | URL | Request) => {
    const url = new URL(String(path), "https://blast.fun"); reads.push(url);
    const body = !url.searchParams.has("tab") ? { followers: 2, following: 1 } : url.searchParams.has("cursor") ? page([account("mallory")]) : url.searchParams.get("q") ? page([]) : page(undefined, "next");
    return Response.json(body);
  });
  const client = createTestQueryClient();
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(async () => root.render(<QueryProvider client={client}><SocialViewerProvider signedIn callsign="kai"><ConnectionsView profile={{ ...profile, callsign: "nova" }} tab="followers" /><ProfileConnectionCounts profile={profile} own /></SocialViewerProvider></QueryProvider>));
  await act(async () => settleQueries(client));
  assert.equal(container.querySelector('nav a[aria-current="page"]')?.getAttribute("href"), "/@nova/followers");
  assert.ok(container.querySelector('a[href="/@kai/following"]'));
  assert.equal(container.querySelectorAll("li").length, 2);
  assert.match(container.querySelector("li")!.textContent!, /You/);
  assert.equal(container.querySelector("li")!.querySelector("button"), null);
  assert.match(container.textContent!, /2 followers/);
  const more = [...container.querySelectorAll("button")].find((b) => b.textContent === "Load more")!;
  await act(async () => { more.click(); await settleQueries(client); });
  assert.equal(container.querySelectorAll("li").length, 3);
  assert.ok(reads.some((url) => url.searchParams.get("cursor") === "next"));
  const input = container.querySelector("input")!;
  await act(async () => { setInputValue(input, "nobody"); input.dispatchEvent(testEvent("input")); });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 220)));
  await act(async () => settleQueries(client));
  assert.match(container.textContent!, /No matching people/);
  assert.ok(reads.some((url) => url.searchParams.get("q") === "nobody"));
  assert.equal(reads.filter((url) => url.pathname.includes("/nova/") && !url.searchParams.has("tab")).length, 1, "paging and search reuse the separate counts query");
});

test("private lists are owner-only and disappear on sign-out", async (t) => {
  t.mock.method(ViewerStateStore.prototype, "want", () => undefined);
  const fetch = t.mock.method(globalThis, "fetch", async (path: string | URL | Request) => Response.json(String(path).includes("?") ? page() : { followers: 2, following: 1 }));
  const client = createTestQueryClient();
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  const render = (signedIn: boolean, callsign: string | null) => <QueryProvider client={client}><SocialViewerProvider signedIn={signedIn} callsign={callsign}><ConnectionsView profile={{ ...profile, private: true }} tab="following" /><ProfileConnectionCounts profile={{ ...profile, private: true }} own={signedIn && callsign === "kai"} /></SocialViewerProvider></QueryProvider>;
  await act(async () => root.render(render(true, "nova")));
  assert.match(container.textContent!, /connections are private/);
  assert.equal(fetch.mock.callCount(), 0);
  await act(async () => root.render(render(true, "kai")));
  await act(async () => settleQueries(client));
  assert.equal(container.querySelectorAll("li").length, 2);
  await act(async () => root.render(render(false, null)));
  assert.equal(container.querySelectorAll("li").length, 0);
  assert.match(container.textContent!, /connections are private/);
  assert.equal(container.querySelector('[href="/@kai/followers"]')?.textContent, "Followers", "an unavailable count is omitted, never a dash");
});

test("failed list reads show a retry and no invented zero count", async (t) => {
  let failed = true;
  t.mock.method(globalThis, "fetch", async (path: string | URL | Request) => failed ? Response.json({ error: { code: "service_unavailable" } }, { status: 503 }) : Response.json(String(path).includes("?") ? page([]) : { followers: 0, following: 0 }));
  const client = createTestQueryClient();
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(async () => root.render(<QueryProvider client={client}><ConnectionsView profile={profile} tab="followers" /></QueryProvider>));
  await act(async () => settleQueries(client));
  assert.match(container.querySelector('[role="alert"]')!.textContent!, /couldn’t load/);
  assert.equal(container.querySelector("nav")!.textContent, "FollowersFollowing");
  failed = false;
  await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === "Try again")!.click(); await settleQueries(client); });
  assert.match(container.textContent!, /No followers yet/);
});

test("unresolved signed-in viewers wait; visitor reads explicitly request public data despite gate cookies", async (t) => {
  const reads: RequestInit[] = [];
  t.mock.method(ViewerStateStore.prototype, "want", () => undefined);
  t.mock.method(globalThis, "fetch", async (path: string | URL | Request, init?: RequestInit) => {
    reads.push(init ?? {});
    return Response.json(String(path).includes("?") ? page([]) : { followers: 0, following: 0 });
  });
  const client = createTestQueryClient();
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  const render = (signedIn: boolean) => <QueryProvider client={client}><SocialViewerProvider signedIn={signedIn} callsign={null}><ConnectionsView profile={profile} tab="following" /></SocialViewerProvider></QueryProvider>;
  await act(async () => root.render(render(true)));
  await act(async () => settleQueries(client));
  assert.equal(reads.length, 0);
  await act(async () => root.render(render(false)));
  await act(async () => settleQueries(client));
  assert.equal(reads.length, 3, "counts, active list and one adjacent first page");
  for (const init of reads) assert.equal(new Headers(init.headers).get("x-blast-public-view"), "1");
});

test("a private-profile refusal hides cached public counts and rows", async (t) => {
  t.mock.method(ViewerStateStore.prototype, "want", () => undefined);
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: { code: "not_found" } }, { status: 404 }));
  const { queryKeys } = await import("#web/lib/query/keys.ts");
  const client = createTestQueryClient();
  const countsKey = queryKeys.me.connections.counts("kai", "visitor");
  const listKey = queryKeys.me.connections.list("kai", "visitor", "followers", "");
  client.setQueryData(countsKey, { followers: 2, following: 1 });
  client.setQueryData(listKey, { pages: [page()], pageParams: [null] });
  await client.invalidateQueries({ queryKey: queryKeys.me.connections.all });
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(async () => root.render(<QueryProvider client={client}><ConnectionsView profile={profile} tab="followers" /><ProfileConnectionCounts profile={profile} own={false} /></QueryProvider>));
  await act(async () => settleQueries(client));
  assert.match(container.textContent!, /connections are private/);
  assert.equal(container.querySelectorAll("li").length, 0);
  assert.equal(container.querySelectorAll('a[href="/@kai/followers"]').length, 1, "only the route tab remains, without the cached count link");
  assert.equal(container.querySelector("nav")!.textContent, "FollowersFollowing");
});

test("unfollow keeps its position, reconciles counts, and Undo performs a real follow with retry", async (t) => {
  t.mock.method(ViewerStateStore.prototype, "want", () => undefined);
  let followed = true;
  let failUndo = false;
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const writes: string[] = [];
  t.mock.method(ViewerStateStore.prototype, "following", (target: { callsign?: string }) => target.callsign === "nova" ? followed : true);
  t.mock.method(ViewerStateStore.prototype, "followsYou", () => true);
  t.mock.method(globalThis, "fetch", async (path: string | URL | Request, init?: RequestInit) => {
    if (String(path).includes("/follows/account/")) {
      writes.push(init?.method ?? "");
      if (init?.method === "DELETE") await pending;
      if (failUndo) return Response.json({ error: { code: "service_unavailable" } }, { status: 503 });
      followed = init?.method === "PUT";
      return new Response(null, { status: 204 });
    }
    return Response.json(String(path).includes("?") ? page(followed ? [account("nova"), account("mallory")] : [account("mallory")]) : { followers: 1, following: followed ? 2 : 1 });
  });
  const client = createTestQueryClient();
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(async () => root.render(<QueryProvider client={client}><SocialViewerProvider signedIn callsign="kai"><ConnectionsView profile={profile} tab="following" /></SocialViewerProvider></QueryProvider>));
  await act(async () => settleQueries(client));
  const row = container.querySelector("li")!;
  const button = row.querySelector("button")!;
  await act(async () => { button.click(); button.click(); });
  assert.equal(button.getAttribute("aria-disabled"), "true");
  assert.match(button.textContent!, /Saving/);
  assert.equal(writes.length, 1);
  await act(async () => { finish(); await settleQueries(client); });
  assert.equal(container.querySelector("li"), row);
  assert.equal(container.querySelectorAll("li").length, 2);
  assert.match(row.textContent!, /No longer following/);
  assert.match(button.textContent!, /Undo/);
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.match(container.querySelector('nav a[aria-current]')!.textContent!, /Following1/);
  failUndo = true;
  await act(async () => { button.click(); await settleQueries(client); });
  assert.match(row.querySelector('[role="alert"]')!.textContent!, /Try again/);
  assert.match(button.textContent!, /Undo/);
  assert.equal(container.querySelector("li"), row);
  failUndo = false;
  await act(async () => { button.click(); await settleQueries(client); });
  assert.deepEqual(writes, ["DELETE", "PUT", "PUT"]);
  assert.equal(container.querySelector("li"), row);
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.match(row.textContent!, /Follows you/);
  assert.match(container.querySelector('nav a[aria-current]')!.textContent!, /Following2/);
  await act(async () => { button.click(); await settleQueries(client); });
  assert.match(row.textContent!, /No longer following/);
  await act(async () => root.render(<QueryProvider client={client}><SocialViewerProvider signedIn callsign="kai"><ConnectionsView profile={{ ...profile, callsign: "sol" }} tab="following" /></SocialViewerProvider></QueryProvider>));
  await act(async () => settleQueries(client));
  assert.doesNotMatch(container.textContent!, /No longer following|NOVA/, "retained rows belong only to their original profile");
});

test("returning to a cached tab keeps its rows during background revalidation", async (t) => {
  t.mock.method(ViewerStateStore.prototype, "want", () => undefined);
  const gates = new Map<string, () => void>();
  let delayed = false;
  t.mock.method(globalThis, "fetch", async (path: string | URL | Request) => {
    const url = new URL(String(path), "https://blast.fun");
    const tab = url.searchParams.get("tab");
    if (tab && delayed) await new Promise<void>((resolve) => { gates.set(tab, resolve); });
    return Response.json(tab ? page([account(tab === "followers" ? "nova" : "mallory")]) : { followers: 1, following: 1 });
  });
  const client = createTestQueryClient();
  client.setDefaultOptions({ queries: { gcTime: Infinity, retry: false } });
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => { for (const finish of gates.values()) finish(); await act(async () => root.unmount()); client.clear(); container.remove(); });
  const render = (tab: "followers" | "following") => <QueryProvider client={client}><ConnectionsView profile={profile} tab={tab} /></QueryProvider>;
  await act(async () => root.render(render("followers")));
  await act(async () => settleQueries(client));
  await act(async () => root.render(render("following")));
  await act(async () => settleQueries(client));
  delayed = true;
  await act(async () => root.render(render("followers")));
  assert.match(container.querySelector('ul[aria-label="Followers"]')!.textContent!, /NOVA/);
  assert.equal(container.querySelector('ul[aria-label="Followers"]')!.getAttribute("aria-busy"), "true");
  assert.doesNotMatch(container.textContent!, /MALLORY/);
  await act(async () => { gates.get("followers")?.(); await settleQueries(client); });
});

test("focusing the adjacent tab prefetches one public first page and reuses it", async (t) => {
  const reads: URL[] = [];
  t.mock.method(globalThis, "fetch", async (path: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(path), "https://blast.fun"); reads.push(url);
    assert.equal(new Headers(init?.headers).get("x-blast-public-view"), "1");
    return Response.json(url.searchParams.has("tab") ? page([account("nova")]) : { followers: 1, following: 1 });
  });
  const client = createTestQueryClient();
  client.setDefaultOptions({ queries: { gcTime: Infinity, retry: false } });
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(async () => root.render(<QueryProvider client={client}><ConnectionsView profile={profile} tab="followers" /></QueryProvider>));
  await act(async () => settleQueries(client));
  const tab = container.querySelector('nav a[href="/@kai/following"]')!;
  await act(async () => { tab.dispatchEvent(testEvent("focusin")); await settleQueries(client); });
  await act(async () => { tab.dispatchEvent(testEvent("focusin")); await settleQueries(client); });
  assert.equal(reads.filter((url) => url.searchParams.get("tab") === "following").length, 1);
  assert.ok(reads.every((url) => !url.searchParams.has("cursor")));
});


test("known-count loading uses complete rows; cached returns keep content during revalidation", async (t) => {
  t.mock.method(ViewerStateStore.prototype, "want", () => undefined);
  let pending = Promise.withResolvers<void>();
  const reads: string[] = [];
  t.mock.method(globalThis, "fetch", async (path: string | URL | Request) => {
    const url = new URL(String(path), "https://blast.fun");
    reads.push(String(path));
    if (!url.searchParams.has("tab")) return Response.json({ followers: 1, following: 2 });
    if (url.searchParams.get("tab") === "followers") { await pending.promise; return Response.json(page([account("luna")])); }
    return Response.json(page([account("nova"), account("sol")]));
  });
  const client = createTestQueryClient({ queries: { gcTime: 60_000 } });
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  const render = (tab: "followers" | "following") => <QueryProvider client={client}><ConnectionsView profile={profile} tab={tab} /></QueryProvider>;
  await act(async () => root.render(render("followers")));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  assert.equal(container.querySelectorAll('[aria-hidden="true"] li').length, 1);
  assert.ok(container.querySelector(".avatarSkeleton"));
  assert.equal(container.querySelectorAll('.identity span[aria-hidden="true"]').length, 2);
  assert.ok(container.querySelector(".buttonSkeleton"));
  await act(async () => { pending.resolve(); await settleQueries(client); });
  pending = Promise.withResolvers<void>();
  const { queryKeys } = await import("#web/lib/query/keys.ts");
  await act(async () => { void client.invalidateQueries({ queryKey: queryKeys.me.connections.list("kai", "visitor", "followers", "") }); });
  const input = container.querySelector("input");
  await act(async () => root.render(render("following")));
  assert.equal(container.querySelector("input"), input, "the navigation shell retains its search field");
  assert.match(container.querySelector("ul[aria-label]")!.textContent!, /NOVA/);
  await act(async () => pending.resolve());
  await act(async () => settleQueries(client));
  assert.doesNotMatch(container.querySelector("ul[aria-label]")!.textContent!, /LUNA/, "late responses cannot overwrite the other tab");
  pending = Promise.withResolvers<void>();
  await act(async () => root.render(render("followers")));
  assert.match(container.querySelector("ul[aria-label]")!.textContent!, /LUNA/, "cached rows render before the background read settles");
  await act(async () => { pending.resolve(); await settleQueries(client); });
  assert.ok(reads.filter((path) => path.includes("tab=following")).length <= 2, "bounded adjacent prefetch and one active revalidation");
});

test("unfollow retains its position, Undo performs a real request, failures keep context and counts", async (t) => {
  const followed = new Set(["nova", "sol"]);
  let order = ["nova", "sol"];
  let failure = false;
  let release: (() => void) | undefined;
  const methods: string[] = [];
  t.mock.method(globalThis, "fetch", async (path: string | URL | Request, init?: RequestInit) => {
    const url = String(path);
    if (url.includes("/follows/account/")) {
      methods.push(init!.method!);
      await new Promise<void>((resolve) => { release = resolve; });
      if (failure) return Response.json({ error: { code: "service_unavailable" } }, { status: 503 });
      const callsign = url.split("/").at(-1)!;
      followed.delete(callsign);
      if (init!.method === "PUT") { followed.add(callsign); order = [callsign, ...order.filter((name) => name !== callsign)]; }
      return new Response(null, { status: 204 });
    }
    if (url.includes("viewer-state")) return Response.json({ reactions: {}, follows: { accounts: { nova: followed.has("nova"), sol: followed.has("sol") }, presales: {} }, follows_you: { nova: true }, backers: {} });
    const parsed = new URL(url, "https://blast.fun");
    if (!parsed.searchParams.has("tab")) return Response.json({ followers: 1, following: followed.size });
    return Response.json(page(parsed.searchParams.get("tab") === "following" ? order.filter((name) => followed.has(name)).map(account) : [account("nova")]));
  });
  const client = createTestQueryClient();
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(async () => root.render(<QueryProvider client={client}><SocialViewerProvider signedIn callsign="kai"><ConnectionsView profile={profile} tab="following" /><ProfileConnectionCounts profile={profile} own /></SocialViewerProvider></QueryProvider>));
  await act(async () => { await settleQueries(client); await new Promise((resolve) => setTimeout(resolve, 30)); });
  const originalRows = [...container.querySelectorAll("li")];
  const button = originalRows[0]!.querySelector("button")!;
  assert.match(originalRows[0]!.textContent!, /Follows you/);
  await act(async () => { button.click(); button.click(); });
  assert.ok(button.querySelector('[role="status"][aria-label="Saving follow preference"]'));
  assert.equal(button.getAttribute("aria-disabled"), "true");
  assert.equal(methods.length, 1);
  await act(async () => { release!(); await settleQueries(client); });
  assert.deepEqual([...container.querySelectorAll("li")], originalRows);
  assert.match(originalRows[0]!.textContent!, /No longer following/);
  assert.match(originalRows[0]!.textContent!, /Follows you/);
  assert.match(button.textContent!, /Undo/);
  assert.match(container.textContent!, /1 following/);
  failure = true;
  await act(async () => button.click());
  assert.match(button.textContent!, /Saving/);
  await act(async () => { release!(); await settleQueries(client); });
  assert.match(container.querySelector('[role="alert"]')!.textContent!, /Try again/);
  assert.match(button.textContent!, /Undo/);
  assert.deepEqual([...container.querySelectorAll("li")], originalRows);
  failure = false;
  await act(async () => [...container.querySelectorAll("button")].find((entry) => entry.textContent === "Retry")!.click());
  await act(async () => { release!(); await settleQueries(client); });
  assert.deepEqual(methods, ["DELETE", "PUT", "PUT"]);
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(container.querySelector('[role="alert"]'), null);
  assert.match(container.textContent!, /2 following/);
  assert.match(originalRows[0]!.textContent!, /Follows you/);
  const secondButton = originalRows[1]!.querySelector("button")!;
  for (const action of [secondButton, button, secondButton]) {
    await act(async () => action.click());
    await act(async () => { release!(); await settleQueries(client); });
    assert.deepEqual([...container.querySelectorAll("li")], originalRows, "multiple removals and re-follow sorting retain every position");
  }
  assert.match(button.textContent!, /Undo/);
  assert.equal(secondButton.getAttribute("aria-pressed"), "true");
  assert.match(container.textContent!, /1 following/);
});
