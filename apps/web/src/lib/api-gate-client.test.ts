import assert from "node:assert/strict";
import test from "node:test";

import { createGateAwareFetch, gatedFetch, installGateAwareFetch } from "./api-gate-client.ts";
import { fetchCoinMarket } from "../components/social/blast-mode/workspace/panels/coin-market-reads.ts";
import { WorkspaceDataUnavailable } from "../components/social/blast-mode/workspace/live-read.ts";
import { publicJson } from "../components/social/public-json.ts";
import { socialPresaleListPageSchema } from "@blast/core/web/contracts/presale-schemas.ts";
import { fetchSettings } from "../components/social/settings/settings-client.ts";

/**
 * WP3: the browser's side of the API gate (docs/security/bot-protection.md).
 * A `gate_required` 401 triggers one shared `GET /api/gate` and one retry;
 * `credentials: "omit"` on our own API becomes `same-origin`.
 */

type Call = { url: string; credentials: RequestCredentials | undefined; method: string; body: string | null };

const refusal = () =>
  Response.json({ error: "gate_required" }, { status: 401, headers: { "x-blast-gate": "required", "cache-control": "no-store" } });

/** A fake network: answers each URL from a script and records every call. */
function network(script: (url: string, count: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body !== undefined && init?.body !== null ? String(init.body) : request && request.body ? await request.clone().text() : null;
    calls.push({ url, credentials: init?.credentials ?? request?.credentials, method: init?.method ?? request?.method ?? "GET", body });
    const count = (counts.get(url) ?? 0) + 1;
    counts.set(url, count);
    return script(url, count);
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

test("an expired gate: one refresh, then the same call again, which succeeds", async () => {
  const net = network((url, count) => (url === "/api/gate" ? new Response(null, { status: 204 }) : count === 1 ? refusal() : Response.json({ ok: true })));
  const fetch = createGateAwareFetch(net.fetch);
  const response = await fetch("/api/social/me/settings", { method: "PUT", body: JSON.stringify({ private: true }), credentials: "same-origin" });
  assert.equal(response.status, 200);
  assert.deepEqual(net.calls.map((call) => `${call.method} ${call.url}`), ["PUT /api/social/me/settings", "GET /api/gate", "PUT /api/social/me/settings"]);
  assert.equal(net.calls[2]?.body, JSON.stringify({ private: true }), "the retry sends the same body");
  assert.equal(net.calls[1]?.credentials, "same-origin");
});

test("a failed refresh answers the original refusal; a route's own 401 never refreshes", async () => {
  const failing = network((url) => (url === "/api/gate" ? Response.json({ error: "rate_limited" }, { status: 429 }) : refusal()));
  const response = await createGateAwareFetch(failing.fetch)("/api/social/feed");
  assert.equal(response.status, 401);
  assert.deepEqual(failing.calls.map((call) => call.url), ["/api/social/feed", "/api/gate"], "one refresh, no retry");

  const own = network(() => Response.json({ error: { code: "unauthorized" } }, { status: 401 }));
  assert.equal((await createGateAwareFetch(own.fetch)("/api/social/me")).status, 401);
  assert.equal(own.calls.length, 1);

  const twice = network((url) => (url === "/api/gate" ? new Response(null, { status: 204 }) : refusal()));
  assert.equal((await createGateAwareFetch(twice.fetch)("/api/social/feed")).status, 401);
  assert.deepEqual(twice.calls.map((call) => call.url), ["/api/social/feed", "/api/gate", "/api/social/feed"], "retried once, never looped");
});

test("concurrent refusals share one refresh", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const net = network(async (url, count) => {
    if (url === "/api/gate") {
      await gate;
      return new Response(null, { status: 204 });
    }
    return count === 1 ? refusal() : Response.json({ url });
  });
  const fetch = createGateAwareFetch(net.fetch);
  const pending = Promise.all([fetch("/api/social/feed"), fetch("/api/social/happening"), fetch("/api/social/prices")]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  const answers = await pending;
  assert.deepEqual(answers.map((answer) => answer.status), [200, 200, 200]);
  assert.equal(net.calls.filter((call) => call.url === "/api/gate").length, 1);
});

test("credentials: omit on our API becomes same-origin; other origins and paths pass through untouched", async () => {
  const net = network(() => Response.json({}));
  const fetch = createGateAwareFetch(net.fetch);
  await fetch("/api/social/feed", { credentials: "omit" });
  await fetch(new Request("https://infra.blast.fun/v1/presales", { credentials: "omit" }));
  await fetch("/feed", { credentials: "omit" });
  await fetch("//evil.example/api/x", { credentials: "omit" });
  assert.deepEqual(net.calls.map((call) => call.credentials), ["same-origin", "omit", "omit", "omit"]);
});

test("a streamed body is not retried; an aborted call is not retried", async () => {
  const net = network((url) => (url === "/api/gate" ? new Response(null, { status: 204 }) : refusal()));
  const fetch = createGateAwareFetch(net.fetch);
  const stream = new ReadableStream({ start: (controller) => controller.close() });
  assert.equal((await fetch("/api/social/me/profile/picture", { method: "PUT", body: stream, duplex: "half" } as RequestInit)).status, 401);
  const controller = new AbortController();
  controller.abort();
  assert.equal((await fetch("/api/social/feed", { signal: controller.signal })).status, 401);
  assert.deepEqual(net.calls.map((call) => call.url), ["/api/social/me/profile/picture", "/api/social/feed"]);
});

test("installing wraps the global fetch once; gatedFetch uses whatever the global is", async () => {
  const net = network((url, count) => (url === "/api/gate" ? new Response(null, { status: 204 }) : count === 1 ? refusal() : Response.json({ ok: 1 })));
  const target = { fetch: net.fetch };
  installGateAwareFetch(target);
  const wrapped = target.fetch;
  installGateAwareFetch(target);
  assert.equal(target.fetch, wrapped, "idempotent");
  assert.equal((await target.fetch("/api/launchpad/search?q=x")).status, 200);
  assert.equal(createGateAwareFetch(wrapped), wrapped, "never wrapped twice");

  const original = globalThis.fetch;
  const global = network((url, count) => (url === "/api/gate" ? new Response(null, { status: 204 }) : count === 1 ? refusal() : Response.json({ ok: 2 })));
  globalThis.fetch = global.fetch;
  try {
    assert.deepEqual(await (await gatedFetch("/api/analytics/activity")).json(), { ok: 2 });
  } finally {
    globalThis.fetch = original;
  }
});

test("callSocialApi (the shared social helper) retries through the gate by default", async () => {
  const settings = {
    privacy: "public",
    sharing_since_ms: null,
    public_portfolio: false,
    explorer: "suivision",
    sound: null,
    notifications: {},
  };
  const original = globalThis.fetch;
  const net = network((url, count) => (url === "/api/gate" ? new Response(null, { status: 204 }) : count === 1 ? refusal() : Response.json(settings)));
  globalThis.fetch = net.fetch;
  try {
    const answer = await fetchSettings({ getAccessToken: async () => "token" });
    assert.equal(answer.status === "ok" || answer.status === "error", true);
    assert.deepEqual(net.calls.map((call) => call.url), ["/api/social/me/settings", "/api/gate", "/api/social/me/settings"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("a shared public JSON read retries the gate and retains diagnostics for an unreadable success", async (t) => {
  const net = network((url, count) => {
    if (url === "/api/gate") return new Response(null, { status: 204 });
    if (count === 1) return refusal();
    return Response.json([], { headers: { "X-Request-ID": "market-ref" } });
  });
  t.mock.method(globalThis, "fetch", net.fetch);

  await assert.rejects(publicJson("/api/social/presales", "The sales", socialPresaleListPageSchema), {
    name: "QueryTransientError",
    code: "invalid_response",
    httpStatus: 200,
    requestId: "market-ref",
  });
  assert.deepEqual(net.calls.map((call) => call.url), ["/api/social/presales", "/api/gate", "/api/social/presales"]);
  assert.ok(net.calls.every((call) => call.credentials === "same-origin"));
});

test("market reads still treat missing market coverage as unavailable", async (t) => {
  const net = network(() => new Response(null, { status: 404 }));
  t.mock.method(globalThis, "fetch", net.fetch);

  await assert.rejects(fetchCoinMarket("test-coin", new AbortController().signal), WorkspaceDataUnavailable);
  assert.equal(net.calls.length, 1);
});
