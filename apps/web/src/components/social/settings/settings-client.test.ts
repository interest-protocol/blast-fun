import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_NOTIFICATION_PREFERENCES } from "@blast/core/modules/social/contracts/settings.ts";

import {
  fetchSettings,
  linkWallet,
  requestWalletChallenge,
  saveFailureMessage,
  saveSettings,
} from "./settings-client.ts";

const SETTINGS = {
  privacy: "public",
  sharing_since_ms: 1,
  commit_too_coin_type: null, blast_mode_confirm_actions: false,
  public_portfolio: false,
  explorer: "suiscan",
  sound: true,
  notifications: DEFAULT_NOTIFICATION_PREFERENCES,
};

type Sent = { url: string; init: RequestInit };

function stub(status: number, body: unknown, headers: Record<string, string> = {}) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}

const token = async () => "tok";

test("UI-07: the settings read and write carry the bearer token, never cached, same-origin (OA-16)", async () => {
  const read = stub(200, SETTINGS);
  assert.deepEqual(await fetchSettings({ getAccessToken: token, fetch: read.fetch }), { status: "ok", body: SETTINGS, httpStatus: 200 });
  assert.equal(read.sent[0]!.url, "/api/social/me/settings");
  assert.equal(read.sent[0]!.init.method, "GET");
  assert.equal(read.sent[0]!.init.cache, "no-store");
  assert.equal(read.sent[0]!.init.credentials, "same-origin");
  assert.deepEqual(read.sent[0]!.init.headers, { authorization: "Bearer tok" });
  assert.equal(read.sent[0]!.init.body, undefined);

  const write = stub(200, { ...SETTINGS, explorer: "suivision" });
  const saved = await saveSettings({ getAccessToken: token, fetch: write.fetch }, { explorer: "suivision", notifications: { funded: false } });
  assert.equal(saved.status, "ok");
  assert.equal(write.sent[0]!.init.method, "PUT");
  assert.deepEqual(write.sent[0]!.init.headers, { authorization: "Bearer tok", "content-type": "application/json" });
  assert.deepEqual(JSON.parse(String(write.sent[0]!.init.body)), { explorer: "suivision", notifications: { funded: false } });
});

test("UI-07: no token (the wallet session cookie goes instead), a refusal (with Retry-After), a malformed answer and a network failure", async () => {
  const none = stub(401, { error: { code: "unauthorized", message: "x" } });
  assert.deepEqual(await fetchSettings({ getAccessToken: async () => null, fetch: none.fetch }), {
    status: "refused",
    code: "unauthorized",
    httpStatus: 401,
    retryAfterSeconds: null,
  });
  assert.equal(none.sent.length, 1);
  assert.deepEqual(none.sent[0]!.init.headers, {});
  assert.equal(none.sent[0]!.init.credentials, "same-origin");
  const limited = stub(429, { error: { code: "rate_limited", message: "x" } }, { "retry-after": "42" });
  assert.deepEqual(await saveSettings({ getAccessToken: token, fetch: limited.fetch }, { private: true }), {
    status: "refused",
    code: "rate_limited",
    httpStatus: 429,
    retryAfterSeconds: 42,
  });
  const soundless = Object.fromEntries(Object.entries(SETTINGS).filter(([key]) => key !== "sound"));
  for (const body of [
    { ...SETTINGS, explorer: "etherscan" },
    { ...SETTINGS, commit_too_amount_usd: "50" },
    { ...SETTINGS, notifications: { funded: true } },
    { ...SETTINGS, sound: "on" },
    soundless,
    "nope",
    null,
  ]) {
    assert.deepEqual(await fetchSettings({ getAccessToken: token, fetch: stub(200, body).fetch }), { status: "error", code: "invalid_response", httpStatus: 200 });
  }
  const offline = (async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof globalThis.fetch;
  assert.deepEqual(await fetchSettings({ getAccessToken: token, fetch: offline }), { status: "error", code: "network_unavailable" });
  assert.deepEqual(await fetchSettings({ getAccessToken: async () => Promise.reject(new Error("x")), fetch: none.fetch }), { status: "error", code: "authentication_unavailable" });
  // OA-33: an account that has not chosen a sound setting answers null — a well-formed answer, not "on".
  assert.deepEqual(await fetchSettings({ getAccessToken: token, fetch: stub(200, { ...SETTINGS, sound: null }).fetch }), {
    status: "ok",
    body: { ...SETTINGS, sound: null },
    httpStatus: 200,
  });
});

test("shared social failures retain the server reference without returning its message", async () => {
  const server = stub(503, { error: { code: "service_unavailable", message: "private upstream details" } }, { "X-Request-ID": "req-17" });
  assert.deepEqual(await fetchSettings({ getAccessToken: token, fetch: server.fetch }), {
    status: "refused", code: "service_unavailable", retryAfterSeconds: null, httpStatus: 503, requestId: "req-17",
  });
  const malformed = stub(503, "not json", { "X-Request-ID": "req-18" });
  assert.deepEqual(await fetchSettings({ getAccessToken: token, fetch: malformed.fetch }), { status: "error", code: "invalid_response", httpStatus: 503, requestId: "req-18" });
  const invalidSuccess = stub(200, {}, { "X-Request-ID": "req-19" });
  assert.deepEqual(await fetchSettings({ getAccessToken: token, fetch: invalidSuccess.fetch }), { status: "error", code: "invalid_response", httpStatus: 200, requestId: "req-19" });
});

test("UI-07: the wallet-link calls send the challenge back with the signature and the wallet that signed", async () => {
  const challenge = { challenge_id: "11111111-1111-4111-8111-111111111111", address: `0x${"a".repeat(64)}`, message: "Sign me", expires_at_ms: 9 };
  const issued = stub(201, challenge);
  const asked = await requestWalletChallenge({ getAccessToken: token, fetch: issued.fetch }, `0x${"A".repeat(64)}`);
  assert.deepEqual(asked, { status: "ok", body: challenge, httpStatus: 201 });
  assert.equal(issued.sent[0]!.url, "/api/social/me/wallets/challenge");
  assert.deepEqual(JSON.parse(String(issued.sent[0]!.init.body)), { address: `0x${"A".repeat(64)}` });

  const wallet = { address: challenge.address, kind: "slush", linked_at_ms: 5 };
  const linked = stub(201, { wallet });
  assert.deepEqual(await linkWallet({ getAccessToken: token, fetch: linked.fetch }, challenge, "sig", "slush"), {
    status: "ok",
    body: { wallet },
    httpStatus: 201,
  });
  assert.equal(linked.sent[0]!.url, "/api/social/me/wallets");
  assert.deepEqual(JSON.parse(String(linked.sent[0]!.init.body)), {
    challenge_id: challenge.challenge_id,
    address: challenge.address,
    message: "Sign me",
    signature: "sig",
    wallet: "slush",
  });
  assert.deepEqual(await requestWalletChallenge({ getAccessToken: token, fetch: stub(201, { ...challenge, address: "0x1" }).fetch }, "0x1"), {
    status: "error", code: "invalid_response", httpStatus: 201,
  });
});

test("UI-07: a failed save says nothing changed and how to recover", () => {
  assert.equal(saveFailureMessage({ status: "error" }), "Couldn't save that. Nothing was changed. Try again. Code: request_failed.");
  assert.equal(saveFailureMessage({ status: "refused", code: "rate_limited", retryAfterSeconds: 60 }), "Too many changes. Try again in 60 s. Nothing was saved. Code: rate_limited.");
  assert.equal(saveFailureMessage({ status: "refused", code: "onboarding_required", retryAfterSeconds: null }), "Finish setting up your account first. Nothing was saved. Code: onboarding_required.");
  assert.equal(saveFailureMessage({ status: "refused", code: "unauthorized", retryAfterSeconds: null, requestId: "settings-ref-1" }), "Your session ended. Sign in again. Nothing was saved. Code: unauthorized. Reference: settings-ref-1.");
  assert.equal(saveFailureMessage({ status: "refused", code: "teapot", retryAfterSeconds: null }), "Couldn't save that. Nothing was changed. Try again. Code: request_failed.");
});

test("a social request cancelled while authentication is pending sends neither a token nor a wallet cookie", async () => {
  for (const accessToken of ["next-account-token", null]) {
    const controller = new AbortController();
    let finishToken!: (token: string | null) => void;
    const token = new Promise<string | null>((resolve) => { finishToken = resolve; });
    const server = stub(200, SETTINGS);
    const saving = saveSettings({ getAccessToken: () => token, signal: controller.signal, fetch: server.fetch }, { private: true });
    controller.abort();
    finishToken(accessToken);
    assert.deepEqual(await saving, { status: "error", code: "request_cancelled" });
    assert.deepEqual(server.sent, [], "nothing is dispatched after cancellation");
  }
});
