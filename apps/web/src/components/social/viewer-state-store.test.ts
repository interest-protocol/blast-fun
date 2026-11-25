import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { createTestQueryClient } from "#web/lib/query/test-client.ts";
afterEach(() => mock.restoreAll());

import { SOCIAL_FOLLOW_LIMIT } from "@blast/core/modules/social/contracts/follows.ts";
import type { SocialViewerStateRequest } from "@blast/core/modules/social/contracts/viewer-state.ts";

import { followErrorMessage, viewerStateBatches } from "./viewer-state-client";
import { ViewerStateStore } from "./viewer-state-store";
import { hex } from "../../../../../packages/core/test/kit.ts";

/** Social-feed T-009: the viewer-state store and client against a scripted fetch. */

const PRESALE = hex("ab");

type Call = Readonly<{ method: string; url: string; authorization: string | null; body: unknown }>;

/** A fetch that records calls and answers viewer-state from `followed` and follow writes from `writeStatus`. */
function scripted(
  options: { followed?: Set<string>; writeStatus?: number; writeBody?: unknown; stateStatus?: number; stateGate?: Promise<void> } = {},
) {
  const calls: Call[] = [];
  const followed = options.followed ?? new Set<string>();
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
    calls.push({ method: init?.method ?? "GET", url: String(input), authorization: headers.get("authorization"), body });
    if (String(input) === "/api/social/viewer-state") {
      if (options.stateStatus && options.stateStatus !== 200) {
        return Response.json({ error: { code: "service_unavailable", message: "x" } }, { status: options.stateStatus });
      }
      const request = body as SocialViewerStateRequest;
      const answer = {
        reactions: Object.fromEntries((request.entry_ids ?? []).map((id) => [id, id === "a:1:0:0:0" ? ["fire"] : []])),
        follows: {
          accounts: Object.fromEntries((request.callsigns ?? []).map((c) => [c, followed.has(`c:${c}`)])),
          presales: Object.fromEntries((request.presale_ids ?? []).map((p) => [p, followed.has(`p:${p}`)])),
        },
        backers: Object.fromEntries((request.backers_of ?? []).map((p) => [p, { count: 2, accounts: [] }])),
        follows_you: Object.fromEntries((request.follows_you ?? []).map((c) => [c, followed.has(`y:${c}`)])),
      };
      await options.stateGate;
      return Response.json(answer);
    }
    const status = options.writeStatus ?? 204;
    if (status === 204) {
      const key = String(input).startsWith("/api/social/follows/account/")
        ? `c:${String(input).split("/").pop()}`
        : `p:${String(input).split("/").pop()}`;
      if (init?.method === "PUT") followed.add(key);
      else followed.delete(key);
      return new Response(null, { status: 204 });
    }
    return Response.json(options.writeBody ?? { error: { code: "service_unavailable", message: "x" } }, {
      status,
      headers: status === 429 ? { "retry-after": "17" } : {},
    });
  }) as typeof globalThis.fetch;
  return { calls, fetch, followed };
}

/** A store whose batched reads run when the test calls `run()`. */
function storeWith(fetch: typeof globalThis.fetch, token: string | null = "token-1") {
  let queued: (() => void) | null = null;
  mock.method(globalThis, "setTimeout", ((run: () => void) => { queued = run as () => void; return { unref() {} }; }) as typeof setTimeout);
  const store = new ViewerStateStore({ getAccessToken: async () => token, fetch, client: createTestQueryClient() });
  return { store, scheduled: () => queued !== null, run: async () => { queued = null; await store.flush(); } };
}

test("T-009 (AC-125): ids asked for in one turn are read in one private POST, once each", async () => {
  const { calls, fetch } = scripted({ followed: new Set(["c:nova"]) });
  const { store, run, scheduled } = storeWith(fetch);
  let notified = 0;
  store.subscribe(() => { notified += 1; });
  store.want({ callsigns: ["kai"] });
  store.want({ callsigns: ["nova", "kai"], presaleIds: [PRESALE] });
  store.want({ entryIds: ["a:1:0:0:0", "a:2:0:0:0"] });
  assert.ok(scheduled());
  assert.equal(store.following({ kind: "account", callsign: "nova" }), undefined);
  await run();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    method: "POST",
    url: "/api/social/viewer-state",
    authorization: "Bearer token-1",
    body: { entry_ids: ["a:1:0:0:0", "a:2:0:0:0"], callsigns: ["kai", "nova"], presale_ids: [PRESALE] },
  });
  assert.equal(store.following({ kind: "account", callsign: "nova" }), true);
  assert.equal(store.following({ kind: "account", callsign: "kai" }), false);
  assert.equal(store.following({ kind: "presale", presale_id: PRESALE }), false);
  assert.deepEqual(store.reactions("a:1:0:0:0"), ["fire"]);
  assert.deepEqual(store.reactions("a:2:0:0:0"), []);
  assert.equal(notified, 1);
  // Already read: nothing more is asked.
  store.want({ callsigns: ["nova"], presaleIds: [PRESALE] });
  assert.equal(scheduled(), false);
});

test("T-009 (AC-125): batches hold at most 50 ids per list and 4 KiB of JSON", () => {
  const presales = Array.from({ length: 120 }, (_, n) => hex(`p${n}`));
  const callsigns = Array.from({ length: 70 }, (_, n) => `crew_${n}`);
  const entries = Array.from({ length: 60 }, (_, n) => `l:${hex(`e${n}`)}:funded`);
  const batches = viewerStateBatches({ entryIds: entries, callsigns, presaleIds: [...presales, presales[0]!] });
  for (const batch of batches) {
    assert.ok(JSON.stringify(batch).length <= 4_096);
    for (const list of [batch.entry_ids, batch.callsigns, batch.presale_ids]) assert.ok((list?.length ?? 0) <= 50);
  }
  assert.deepEqual(batches.flatMap((batch) => batch.entry_ids ?? []), entries);
  assert.deepEqual(batches.flatMap((batch) => batch.callsigns ?? []), callsigns);
  assert.deepEqual(batches.flatMap((batch) => batch.presale_ids ?? []), presales);
  assert.deepEqual(viewerStateBatches({}), []);
});

test("T-009-AC-6 (AC-033, AC-165): a tap writes the follow, updates every control, and a reload reads it back", async () => {
  let release = () => {};
  const server = scripted({ stateGate: new Promise<void>((resolve) => { release = resolve; }) });
  const first = storeWith(server.fetch);
  first.store.want({ callsigns: ["nova"] });
  // A read already in flight (answering "not following") when the tap lands does not undo it.
  const reading = first.run();
  const followed = await first.store.setFollowing({ kind: "account", callsign: "nova" }, true);
  release();
  await reading;
  assert.deepEqual(followed, { status: "ok" });
  assert.equal(first.store.following({ kind: "account", callsign: "nova" }), true);
  const put = server.calls.find((call) => call.method === "PUT");
  assert.deepEqual(put, { method: "PUT", url: "/api/social/follows/account/nova", authorization: "Bearer token-1", body: null });

  // Reload: a fresh store reads the stored follow.
  const reload = storeWith(server.fetch);
  reload.store.want({ callsigns: ["nova"] });
  await reload.run();
  assert.equal(reload.store.following({ kind: "account", callsign: "nova" }), true);

  // Unfollow is a DELETE on the same path.
  assert.deepEqual(await reload.store.setFollowing({ kind: "account", callsign: "nova" }, false), { status: "ok" });
  assert.equal(server.calls.at(-1)?.method, "DELETE");
  assert.equal(reload.store.following({ kind: "account", callsign: "nova" }), false);
  assert.deepEqual(await reload.store.setFollowing({ kind: "presale", presale_id: PRESALE }, true), { status: "ok" });
  assert.equal(server.calls.at(-1)?.url, `/api/social/follows/presale/${PRESALE}`);
});

test("T-009: a refused write changes nothing and explains itself; no token goes as the wallet session", async () => {
  const limit = scripted({ writeStatus: 422, writeBody: { error: { code: "follow_limit", message: "x" } } });
  const { store } = storeWith(limit.fetch);
  const refused = await store.setFollowing({ kind: "presale", presale_id: PRESALE }, true);
  assert.deepEqual(refused, { status: "refused", code: "follow_limit", retryAfterSeconds: null, httpStatus: 422 });
  assert.equal(store.following({ kind: "presale", presale_id: PRESALE }), undefined);
  assert.match(followErrorMessage(refused as Exclude<typeof refused, { status: "ok" }>, true), new RegExp(SOCIAL_FOLLOW_LIMIT.toLocaleString("en-US")));

  const limited = scripted({ writeStatus: 429, writeBody: { error: { code: "rate_limited", message: "x" } } });
  const rate = await storeWith(limited.fetch).store.setFollowing({ kind: "account", callsign: "nova" }, false);
  assert.deepEqual(rate, { status: "refused", code: "rate_limited", retryAfterSeconds: 17, httpStatus: 429 });
  assert.equal(
    followErrorMessage(rate as Exclude<typeof rate, { status: "ok" }>, false),
    "Too many follows in a short time. Try again in 17 seconds. You are still following it. Code: rate_limited.",
  );

  // OA-16: without a Privy token the call goes with the wallet session cookie (no Authorization); the server decides.
  const anonymous = scripted({ writeStatus: 401, writeBody: { error: { code: "unauthorized", message: "x" } } });
  const signedOut = storeWith(anonymous.fetch, null);
  assert.deepEqual(await signedOut.store.setFollowing({ kind: "account", callsign: "nova" }, true), {
    status: "refused",
    code: "unauthorized",
    retryAfterSeconds: null,
    httpStatus: 401,
  });
  assert.equal(anonymous.calls.length, 1);
  assert.equal(anonymous.calls[0]?.authorization, null);
});

test("UI-12b (OA-17): follow writes that succeed are heard (the watchlist card); refused ones and unsubscribed listeners are not", async () => {
  const heard: string[] = [];
  const ok = storeWith(scripted().fetch).store;
  const stop = ok.subscribeFollowWrites((target, following) => heard.push(`${target.kind}:${following}`));
  await ok.setFollowing({ kind: "presale", presale_id: PRESALE }, true);
  await ok.setFollowing({ kind: "account", callsign: "nova" }, false);
  stop();
  await ok.setFollowing({ kind: "presale", presale_id: PRESALE }, false);
  const refused = storeWith(scripted({ writeStatus: 422, writeBody: { error: { code: "follow_limit", message: "x" } } }).fetch).store;
  refused.subscribeFollowWrites(() => heard.push("refused"));
  await refused.setFollowing({ kind: "presale", presale_id: PRESALE }, true);
  assert.deepEqual(heard, ["presale:true", "account:false"]);
});

test("T-009: a failed read leaves ids unknown and asks again on the next want", async () => {
  const down = scripted({ stateStatus: 503 });
  const { store, run, scheduled } = storeWith(down.fetch);
  store.want({ callsigns: ["nova"] });
  await run();
  assert.equal(store.following({ kind: "account", callsign: "nova" }), undefined);
  assert.equal(store.followReadFailed({ kind: "account", callsign: "nova" }), true);
  store.want({ callsigns: ["nova"] });
  assert.equal(store.followReadFailed({ kind: "account", callsign: "nova" }), false);
  assert.ok(scheduled());
  await run();
  assert.equal(down.calls.length, 2);
});

/** A fetch for reaction writes: each PUT/DELETE waits for its own gate and answers `status`. */
function reactionFetch(statuses: number[], gates: Promise<void>[] = []) {
  const calls: { method: string; url: string; authorization: string | null }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (String(input) === "/api/social/viewer-state") {
      const request = JSON.parse(String(init?.body)) as SocialViewerStateRequest;
      return Response.json({
        reactions: Object.fromEntries((request.entry_ids ?? []).map((id) => [id, id === "a:9:0:0:0" ? ["rocket"] : []])),
        follows: { accounts: {}, presales: {} },
        follows_you: {},
        backers: Object.fromEntries((request.backers_of ?? []).map((p) => [p, { count: 7, accounts: [] }])),
      });
    }
    const index = calls.length;
    calls.push({ method: init?.method ?? "GET", url: String(input), authorization: headers.get("authorization") });
    await gates[index];
    const status = statuses[index] ?? 204;
    if (status === 204) return new Response(null, { status });
    const code = status === 429 ? "rate_limited" : status === 401 ? "unauthorized" : "not_found";
    return Response.json({ error: { code, message: "x" } }, { status });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

test("T-010 (AC-075): a rocket shows at once, writes PUT/DELETE with the bearer token, and keeps the first read", async () => {
  const { calls, fetch } = reactionFetch([204, 204]);
  const { store, run } = storeWith(fetch);
  store.want({ entryIds: ["a:9:0:0:0", "a:1:0:0:0"] });
  await run();
  assert.deepEqual(store.reactions("a:9:0:0:0"), ["rocket"]);
  assert.deepEqual(store.reactionsAtRead("a:9:0:0:0"), ["rocket"]);
  let notified = 0;
  store.subscribe(() => { notified += 1; });
  const tap = store.setReaction("a:1:0:0:0", "rocket", true);
  // Optimistic: shown before the route answers.
  assert.deepEqual(store.reactions("a:1:0:0:0"), ["rocket"]);
  assert.equal((await tap).status, "ok");
  assert.deepEqual(calls[0], { method: "PUT", url: "/api/social/items/a%3A1%3A0%3A0%3A0/reactions/rocket", authorization: "Bearer token-1" });
  assert.equal((await store.setReaction("a:9:0:0:0", "rocket", false)).status, "ok");
  assert.equal(calls[1]?.method, "DELETE");
  assert.deepEqual(store.reactions("a:9:0:0:0"), []);
  // What the public count included stays the first read.
  assert.deepEqual(store.reactionsAtRead("a:9:0:0:0"), ["rocket"]);
  assert.ok(notified >= 2);
});

test("T-010: a refused rocket rolls back and says why; a late answer of an older tap never undoes a newer one", async () => {
  const { fetch } = reactionFetch([429]);
  const { store, run } = storeWith(fetch);
  store.want({ entryIds: ["a:1:0:0:0"] });
  await run();
  const result = await store.setReaction("a:1:0:0:0", "rocket", true);
  assert.equal(result.status, "refused");
  assert.deepEqual(store.reactions("a:1:0:0:0"), []);

  let release: () => void = () => undefined;
  const slow = new Promise<void>((resolve) => { release = resolve; });
  const ordered = reactionFetch([500, 204], [slow, Promise.resolve()]);
  const second = storeWith(ordered.fetch);
  second.store.want({ entryIds: ["a:1:0:0:0"] });
  await second.run();
  const first = second.store.setReaction("a:1:0:0:0", "rocket", true);
  const latest = await second.store.setReaction("a:1:0:0:0", "rocket", false);
  assert.equal(latest.status, "ok");
  release();
  assert.equal((await first).status, "refused");
  // The first tap failed after the second succeeded: the second's state stands.
  assert.deepEqual(second.store.reactions("a:1:0:0:0"), []);
});

test("T-010: a read finishing after a tap does not undo it; without a token the call rides the wallet session cookie (OA-16)", async () => {
  const { calls, fetch } = reactionFetch([204, 401]);
  const { store, run } = storeWith(fetch);
  store.want({ entryIds: ["a:1:0:0:0"] });
  await store.setReaction("a:1:0:0:0", "rocket", true);
  await run();
  assert.deepEqual(store.reactions("a:1:0:0:0"), ["rocket"]);
  const anonymous = storeWith(fetch, null);
  const refused = await anonymous.store.setReaction("a:1:0:0:0", "rocket", true);
  // No Privy token: the write still goes (no Authorization header; the browser
  // sends the wallet session cookie, if any), and with no session the route's
  // 401 is a refusal.
  assert.deepEqual(refused, { status: "refused", code: "unauthorized", retryAfterSeconds: null, httpStatus: 401 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.authorization, null);
});

test("UI-03 (§3.5): followed backers are read in the same batched POST as the rest", async () => {
  const { fetch } = reactionFetch([]);
  const { store, run } = storeWith(fetch);
  store.want({ backersOf: [PRESALE], entryIds: ["a:1:0:0:0"] });
  assert.equal(store.backers(PRESALE), undefined);
  await run();
  assert.deepEqual(store.backers(PRESALE), { count: 7, accounts: [] });
  assert.deepEqual(viewerStateBatches({ backersOf: [PRESALE, PRESALE] }), [{ backers_of: [PRESALE] }]);
});

test("UI-05: 'follows you' is read with the follows in one batch, per callsign, and a failed read forgets it", async () => {
  const { calls, fetch } = scripted({ followed: new Set(["c:theopark", "y:samokafor"]) });
  const store = new ViewerStateStore({ getAccessToken: async () => "token", fetch, client: createTestQueryClient() });
  store.want({ callsigns: ["theopark", "samokafor"], followsYou: ["theopark", "samokafor"] });
  await store.flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.body, { callsigns: ["theopark", "samokafor"], follows_you: ["theopark", "samokafor"] });
  assert.equal(store.following({ kind: "account", callsign: "theopark" }), true);
  assert.equal(store.followsYou("theopark"), false);
  assert.equal(store.followsYou("samokafor"), true);
  assert.equal(store.followsYou("nobody"), undefined);
  store.want({ followsYou: ["samokafor"] });
  await store.flush();
  assert.equal(calls.length, 1, "already read");
  const failing = scripted({ stateStatus: 503 });
  const other = new ViewerStateStore({ getAccessToken: async () => "token", fetch: failing.fetch, client: createTestQueryClient() });
  other.want({ followsYou: ["samokafor"] });
  await other.flush();
  other.want({ followsYou: ["samokafor"] });
  await other.flush();
  assert.equal(failing.calls.length, 2);
});


test("follow requests are shared per target and invalidate exact counts without guessed privacy deltas", async () => {

  const { queryKeys } = await import("#web/lib/query/keys.ts");
  const client = createTestQueryClient();
  const gate = Promise.withResolvers<void>();
  const server = scripted({ followed: new Set(["c:nova"]) });
  const fetch: typeof globalThis.fetch = async (path, init) => {
    if (String(path).includes("/follows/")) await gate.promise;
    return server.fetch(path, init);
  };
  const store = new ViewerStateStore({ getAccessToken: async () => "token", client, scope: "kai", fetch });
  store.want({ callsigns: ["nova"] });
  await store.flush();
  const ownCounts = queryKeys.me.connections.counts("kai", "kai");
  const targetCounts = queryKeys.me.connections.counts("nova", "kai");
  client.setQueryData(ownCounts, { following: 3, followers: 1 });
  client.setQueryData(targetCounts, { following: 2, followers: 8 });
  const target = { kind: "account" as const, callsign: "nova" };
  const write = store.setFollowing(target, false);
  assert.equal(store.following(target), false, "the tap shows at once");
  assert.equal(store.setFollowing(target, false), write, "every control shares one settlement");
  assert.equal(store.setFollowing(target, true), write);
  assert.equal(store.following(target), true, "the newest tap wins");
  gate.resolve();
  assert.equal((await write).status, "ok");
  assert.equal(store.following(target), true);
  assert.deepEqual(client.getQueryData(ownCounts), { following: 3, followers: 1 });
  assert.deepEqual(client.getQueryData(targetCounts), { following: 2, followers: 8 });
  assert.equal(client.getQueryState(ownCounts)?.isInvalidated, true);
  assert.equal(client.getQueryState(targetCounts)?.isInvalidated, true);
  assert.deepEqual(server.calls.filter((call) => call.url.includes("/follows/")).map((call) => call.method), ["DELETE", "PUT"], "writes go one at a time, in tap order");
  await store.setFollowing(target, true);
  assert.equal(server.calls.filter((call) => call.url.includes("/follows/")).length, 2, "a tap that matches the server sends nothing");
  assert.deepEqual(client.getQueryData(ownCounts), { following: 3, followers: 1 });
  assert.deepEqual(client.getQueryData(targetCounts), { following: 2, followers: 8 });
  client.clear();
});

test("a private actor's follow waits for exact counts without temporarily adding a public follower", async () => {
  const { QueryObserver } = await import("@tanstack/react-query");

  const { queryKeys } = await import("#web/lib/query/keys.ts");
  const client = createTestQueryClient();
  const countsRead = Promise.withResolvers<void>();
  const releaseCounts = Promise.withResolvers<void>();
  const key = queryKeys.me.connections.counts("nova", "kai");
  const counts = { followers: 0, following: 0 };
  const observer = new QueryObserver(client, {
    queryKey: key, initialData: counts, staleTime: Infinity,
    queryFn: async () => { countsRead.resolve(); await releaseCounts.promise; return counts; },
  });
  const unsubscribe = observer.subscribe(() => undefined);
  const server = scripted({ followed: new Set() });
  const store = new ViewerStateStore({ getAccessToken: async () => "token", client, scope: "kai", fetch: server.fetch });
  const target = { kind: "account" as const, callsign: "nova" };
  try {
    store.want({ callsigns: ["nova"] }); await store.flush();
    const write = store.setFollowing(target, true);
    await countsRead.promise;
    assert.equal(store.following(target), true);
    assert.deepEqual(client.getQueryData(key), counts, "private actors are excluded from public follower totals");
    releaseCounts.resolve(); await write;
    assert.deepEqual(client.getQueryData(key), counts);
  } finally { releaseCounts.resolve(); unsubscribe(); client.clear(); }
});


/** A fetch whose follow writes wait on `release()` one by one, answering with `statuses` in order (204 by default). */
function heldWrites(statuses: number[] = []) {
  const server = scripted();
  const held: Array<() => void> = [];
  let index = 0;
  let started = 0;
  const fetch: typeof globalThis.fetch = async (path, init) => {
    if (!String(path).includes("/follows/")) return server.fetch(path, init);
    started += 1;
    const status = statuses[index++] ?? 204;
    await new Promise<void>((resolve) => held.push(resolve));
    if (status === 204) return server.fetch(path, init);
    return Response.json({ error: { code: "follow_limit", message: "x" } }, { status });
  };
  // `storeWith` mocks `setTimeout`, so these waits use `setImmediate`.
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const release = async () => {
    for (let i = 0; held.length === 0; i += 1) {
      if (i > 200) throw new Error("no follow write is waiting");
      await tick();
    }
    held.shift()!();
    for (let i = 0; i < 5; i += 1) await tick();
  };
  const writes = () => server.calls.filter((call) => call.url.includes("/follows/")).map((call) => call.method);
  return { fetch, release, writes, started: () => started };
}

test("Slice B: a follow shows at once, and listeners hear it only once the route accepts it", async () => {
  const net = heldWrites();
  const { store } = storeWith(net.fetch);
  const target = { kind: "presale" as const, presale_id: PRESALE };
  const heard: boolean[] = [];
  store.subscribeFollowWrites((_target, following) => heard.push(following));
  const write = store.setFollowing(target, true);
  assert.equal(store.following(target), true);
  assert.deepEqual(heard, [], "nothing confirmed yet");
  await net.release();
  assert.deepEqual(await write, { status: "ok" });
  assert.deepEqual(heard, [true]);
  assert.deepEqual(net.writes(), ["PUT"]);
});

test("Slice B: a refused follow puts back the state that was read", async () => {
  const server = scripted({ writeStatus: 422, writeBody: { error: { code: "follow_limit", message: "x" } } });
  const { store, run } = storeWith(server.fetch);
  const target = { kind: "account" as const, callsign: "nova" };
  store.want({ callsigns: ["nova"] });
  await run();
  assert.equal(store.following(target), false);
  const heard: boolean[] = [];
  store.subscribeFollowWrites((_target, following) => heard.push(following));
  const write = store.setFollowing(target, true);
  assert.equal(store.following(target), true);
  assert.equal((await write).status, "refused");
  assert.equal(store.following(target), false);
  assert.deepEqual(heard, []);
});

test("Slice B: follow then unfollow in quick succession sends both, in order, and ends unfollowed", async () => {
  const net = heldWrites();
  const { store } = storeWith(net.fetch);
  const target = { kind: "account" as const, callsign: "nova" };
  const heard: boolean[] = [];
  store.subscribeFollowWrites((_target, following) => heard.push(following));
  const first = store.setFollowing(target, true);
  const second = store.setFollowing(target, false);
  assert.equal(store.following(target), false, "the second tap is not dropped");
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(net.started(), 1, "the second write waits for the first answer");
  await net.release();
  assert.equal(net.started(), 2);
  await net.release();
  assert.deepEqual(await first, { status: "ok" });
  assert.deepEqual(await second, { status: "ok" });
  assert.deepEqual(net.writes(), ["PUT", "DELETE"]);
  assert.deepEqual(heard, [true, false]);
  assert.equal(store.following(target), false);
});

test("Slice B: rapid taps collapse; a tap back to the server's state while a write is in flight sends nothing more", async () => {
  const net = heldWrites();
  const { store } = storeWith(net.fetch);
  const target = { kind: "presale" as const, presale_id: PRESALE };
  const write = store.setFollowing(target, true);
  store.setFollowing(target, false);
  store.setFollowing(target, true);
  store.setFollowing(target, false);
  store.setFollowing(target, true);
  await net.release();
  await write;
  assert.deepEqual(net.writes(), ["PUT"], "one write for five taps that end where the first went");
  assert.equal(store.following(target), true);
});

test("Slice B: a refused write is not resent when the newest tap asks for the same thing", async () => {
  // Taps follow, unfollow, follow; the first PUT is refused while the newest tap still wants follow.
  const net = heldWrites([422]);
  const { store } = storeWith(net.fetch);
  const target = { kind: "account" as const, callsign: "nova" };
  const write = store.setFollowing(target, true);
  store.setFollowing(target, false);
  store.setFollowing(target, true);
  await net.release();
  assert.equal((await write).status, "refused");
  assert.equal(net.started(), 1, "the same write would be refused again, so nothing more is sent");
  assert.equal(store.following(target), undefined, "back to what the page read");
});

test("Slice B: a write in flight when the viewer pauses does not swallow the next tap", async () => {
  const net = heldWrites();
  const { store } = storeWith(net.fetch);
  const target = { kind: "presale" as const, presale_id: "0x1" };
  void store.setFollowing(target, true);
  store.setActive(false);
  assert.equal(store.following(target), undefined, "back to the last confirmed state");
  store.setActive(true);
  const next = store.setFollowing(target, true);
  assert.equal(store.following(target), true);
  await net.release();
  await net.release();
  assert.deepEqual(await next, { status: "ok" });
  assert.equal(net.started(), 2, "the new tap is written by its own queue");
});
