import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchSocialAccount,
  refreshSocialXHandle,
  SOCIAL_ACCOUNT_LOADING,
  SOCIAL_ACCOUNT_SIGNED_OUT,
  SOCIAL_ME_URL,
  socialAccountFromSession,
} from "./social-account-client.ts";

/** Social-feed T-002: the client side of `me` that `useSocialAccount` exposes as `{ status, account }`. */

const ACCOUNT = {
  account_id: "00000000-0000-4000-8000-000000000001",
  kind: "member",
  callsign: "pilot_one",
  display_name: "Pilot One",
  avatar_url: null,
  x_handle: "pilot_one",
  verified: true,
  onboarding: { shown: false, completed: false },
  privacy: "public",
  sharing_since_ms: null,
  wallets: [],
};

test("X handle refresh uses the Privy bearer token and reports only successful updates", async () => {
  const refreshed = fetchReturning(200, { updated: true });
  assert.equal(await refreshSocialXHandle({ getAccessToken: async () => "token", fetch: refreshed.fetch }), true);
  assert.equal(refreshed.calls[0]?.url, `${SOCIAL_ME_URL}/x-handle`);
  assert.equal(refreshed.calls[0]?.init?.method, "POST");
  assert.equal(new Headers(refreshed.calls[0]?.init?.headers).get("authorization"), "Bearer token");
  for (const [status, body] of [[200, { updated: false }], [503, { updated: true }], [200, null], [200, { updated: "true" }]] as const) {
    const response = fetchReturning(status, body);
    assert.equal(await refreshSocialXHandle({ getAccessToken: async () => "token", fetch: response.fetch }), false);
  }
});

test("X handle refresh skips wallet-only sessions and tolerates token, network and abort failures", async () => {
  const response = fetchReturning(200, { updated: true });
  for (const getAccessToken of [async () => null, async () => { throw new Error("Privy unavailable"); }]) {
    assert.equal(await refreshSocialXHandle({ getAccessToken, fetch: response.fetch }), false);
  }
  const controller = new AbortController();
  controller.abort();
  assert.equal(await refreshSocialXHandle({ getAccessToken: async () => "token", fetch: response.fetch, signal: controller.signal }), false);
  assert.equal(response.calls.length, 0);
  assert.equal(await refreshSocialXHandle({ getAccessToken: async () => "token", fetch: async () => { throw new Error("offline"); } }), false);
});

function fetchReturning(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Response.json(body, { status });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

test("a successful account response must satisfy the complete public contract", async () => {
  for (const account of [
    { ...ACCOUNT, verified: undefined },
    { ...ACCOUNT, account_id: "invalid" },
    { ...ACCOUNT, wallets: [{ address: "0x1", kind: "slush", linked_at_ms: 0 }] },
  ]) {
    const response = fetchReturning(200, { account });
    const result = await fetchSocialAccount({ getAccessToken: async () => "token", fetch: response.fetch });
    assert.equal(result.status, "error");
    assert.equal(response.calls.length, 1, "malformed accounts never trigger provisioning");
  }
});

test("the session decides before any read: Privy starting is loading, signed out is signed_out", () => {
  assert.deepEqual(socialAccountFromSession({ ready: false, authenticated: false }), SOCIAL_ACCOUNT_LOADING);
  assert.deepEqual(socialAccountFromSession({ ready: true, authenticated: false }), SOCIAL_ACCOUNT_SIGNED_OUT);
  assert.equal(socialAccountFromSession({ ready: true, authenticated: true }), null);
});

test("me with the Privy token: an existing account, a refused token, a failure", async () => {
  const ok = fetchReturning(200, { account: ACCOUNT });
  assert.deepEqual(await fetchSocialAccount({ getAccessToken: async () => "tok-1", fetch: ok.fetch }), { status: "ready", account: ACCOUNT });
  assert.equal(ok.calls[0]?.url, SOCIAL_ME_URL);
  assert.equal(new Headers(ok.calls[0]?.init?.headers).get("authorization"), "Bearer tok-1");
  assert.equal(ok.calls[0]?.init?.cache, "no-store");

  assert.equal(ok.calls.length, 1, "existing Mission Control accounts are never provisioned again");

  const refused = fetchReturning(401, { error: { code: "unauthorized", message: "Sign in to continue." } });
  assert.deepEqual(await fetchSocialAccount({ getAccessToken: async () => "tok-1", fetch: refused.fetch }), SOCIAL_ACCOUNT_SIGNED_OUT);

  // OA-16: no Privy token reads `me` with the wallet session cookie (no Authorization header).
  const noToken = fetchReturning(200, { account: ACCOUNT });
  assert.deepEqual(await fetchSocialAccount({ getAccessToken: async () => null, fetch: noToken.fetch }), { status: "ready", account: ACCOUNT });
  assert.equal(new Headers(noToken.calls[0]?.init?.headers).get("authorization"), null);
  assert.equal(noToken.calls[0]?.init?.credentials, "same-origin");
  const noSession = fetchReturning(401, { error: { code: "unauthorized", message: "Sign in to continue." } });
  assert.deepEqual(await fetchSocialAccount({ getAccessToken: async () => null, fetch: noSession.fetch }), SOCIAL_ACCOUNT_SIGNED_OUT);

  for (const [status, body] of [[503, { error: { code: "service_unavailable" } }], [429, {}], [200, { nope: true }], [200, { account: { callsign: 1 } }]] as const) {
    const failed = fetchReturning(status, body);
    assertAccountError(await fetchSocialAccount({ getAccessToken: async () => "tok-1", fetch: failed.fetch }));
  }
  const offline = (async () => {
    throw new TypeError("network");
  }) as unknown as typeof globalThis.fetch;
  assertAccountError(await fetchSocialAccount({ getAccessToken: async () => "tok-1", fetch: offline }));
  assertAccountError(await fetchSocialAccount({ getAccessToken: async () => { throw new Error("privy"); }, fetch: ok.fetch }));
});

test("new Privy and wallet sessions get saved random identities before becoming ready, with no identity form", async () => {
  const generated = { ...ACCOUNT, kind: "new", callsign: "cosmic_otter_1234", display_name: "Cosmic Otter" };
  for (const token of ["tok-1", null]) {
    const calls: string[] = [];
    let finish!: (response: Response) => void;
    const created = new Promise<Response>((resolve) => { finish = resolve; });
    let ready = false;
    const result = fetchSocialAccount({ getAccessToken: async () => token, fetch: async (url, init) => {
      calls.push(String(url));
      if (init?.method !== "POST") return Response.json({ account: null });
      assert.equal(String(url), "/api/social/accounts");
      assert.deepEqual(JSON.parse(String(init.body)), {});
      assert.equal(new Headers(init.headers).get("authorization"), token ? `Bearer ${token}` : null);
      assert.equal(init.credentials, "same-origin");
      return created;
    } }).then((state) => { ready = true; return state; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ready, false, "the account stays loading until its identity is saved");
    assert.deepEqual(calls, [SOCIAL_ME_URL, "/api/social/accounts"]);
    finish(Response.json({ account: generated }, { status: 201 }));
    assert.deepEqual(await result, { status: "ready", account: generated });
  }
});

test("an account created by another tab is read once more; an unresolved conflict cannot loop", async () => {
  for (const account of [ACCOUNT, null]) {
    let reads = 0;
    let creates = 0;
    const result = await fetchSocialAccount({ getAccessToken: async () => "tok-1", fetch: async (_url, init) => {
      if (init?.method === "POST") {
        creates++;
        return Response.json({ error: { code: "account_exists" } }, { status: 409 });
      }
      return Response.json({ account: ++reads === 1 ? null : account });
    } });
    if (account) assert.deepEqual(result, { status: "ready", account });
    else assertAccountError(result);
    assert.equal(reads, 2);
    assert.equal(creates, 1);
  }
});

test("failed account creation offers account retry; an expired session is signed out", async () => {
  for (const status of [401, 429, 503, 201]) {
    const result = await fetchSocialAccount({ getAccessToken: async () => "tok-1", fetch: async (_url, init) => init?.method === "POST"
      ? Response.json({ error: { code: status === 401 ? "unauthorized" : "service_unavailable" } }, { status })
      : Response.json({ account: null }) });
    if (status === 401) assert.deepEqual(result, SOCIAL_ACCOUNT_SIGNED_OUT);
    else assertAccountError(result);
  }
  assertAccountError(await fetchSocialAccount({ getAccessToken: async () => "tok-1", fetch: async (_url, init) => {
    if (init?.method === "POST") throw new Error("offline");
    return Response.json({ account: null });
  } }));
  assertAccountError(await fetchSocialAccount({ getAccessToken: async () => "tok-1", fetch: async (_url, init) => init?.method === "POST"
    ? Response.json({ account: { account_id: ACCOUNT.account_id, callsign: ACCOUNT.callsign } }, { status: 201 })
    : Response.json({ account: null }) }));
});

test("an aborted account creation rethrows so a cancelled session load drops it", async () => {
  const controller = new AbortController();
  await assert.rejects(fetchSocialAccount({ getAccessToken: async () => "tok-1", signal: controller.signal, fetch: async (_url, init) => {
    if (init?.method !== "POST") return Response.json({ account: null });
    assert.equal(init.signal, controller.signal);
    controller.abort();
    throw new DOMException("aborted", "AbortError");
  } }), { name: "AbortError" });
});

test("an aborted read rethrows so the hook drops it", async () => {
  const controller = new AbortController();
  const fetch = (async () => {
    controller.abort();
    throw new DOMException("aborted", "AbortError");
  }) as unknown as typeof globalThis.fetch;
  await assert.rejects(fetchSocialAccount({ getAccessToken: async () => "tok-1", fetch, signal: controller.signal }), { name: "AbortError" });
});

test("OA-16: before reading me, Privy starting is loading; neither a Privy session nor a wallet hint is signed out", () => {
  assert.deepEqual(socialAccountFromSession({ ready: false, authenticated: false, wallet: true }), SOCIAL_ACCOUNT_LOADING);
  assert.deepEqual(socialAccountFromSession({ ready: true, authenticated: false }), SOCIAL_ACCOUNT_SIGNED_OUT);
  assert.equal(socialAccountFromSession({ ready: true, authenticated: false, wallet: true }), null);
  assert.equal(socialAccountFromSession({ ready: true, authenticated: true }), null);
});

function assertAccountError(state: Awaited<ReturnType<typeof fetchSocialAccount>>) {
  assert.equal(state.status, "error");
  assert.equal(state.account, null);
  assert.match(state.message ?? "", /Code: [a-z0-9_-]+\./);
  assert.doesNotMatch(state.message ?? "", /privy|offline|network$/i);
}
