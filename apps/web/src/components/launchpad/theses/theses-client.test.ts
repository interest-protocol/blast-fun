import assert from "node:assert/strict";
import test from "node:test";

import { FIXTURE_ALPHA_THESES, FIXTURE_LAUNCH_ALPHA } from "../../../../../../packages/server/test/fixtures/modules/launchpad-social/fixtures.ts";
import type { PostInput } from "@blast/core/modules/launchpad-social/post-contract.ts";
import { publishThesis, readTheses, thesesUrl, type PostCredential } from "./theses-client.ts";

const PROVENANCE = {
  source: "replica", network: "mainnet", deployment: "5".repeat(64), checkpoint: 9, timestampMs: 1, observedAt: 2, lagMs: 1,
} as const;
const [UPDATE, , COMMUNITY] = FIXTURE_ALPHA_THESES.theses;
const WALLET = `0x${"a3".repeat(32)}`;

function recorder(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const response = responses.shift();
    if (!response || response instanceof Error) throw response ?? new Error("offline");
    return response;
  }) as typeof fetch;
  return { calls, fetcher };
}

function body(call: { init?: RequestInit }) {
  return JSON.parse(String(call.init?.body));
}

function headers(call: { init?: RequestInit }) {
  return new Headers(call.init?.headers);
}

const INPUT: PostInput = {
  launchId: FIXTURE_LAUNCH_ALPHA,
  kind: "community_thesis",
  stance: "bullish",
  body: "Graduation looks near for Alpha.",
  evidenceLinks: ["https://example.com/alpha-thread"],
  disclosure: { text: "Small holder.", walletAddress: WALLET },
  revisionOf: null,
};

const privy: PostCredential = { kind: "privy", accessToken: "privy-token" };

test("a launch's theses are read privately, page by page; refusals and outages are told apart", async () => {
  assert.equal(thesesUrl(FIXTURE_LAUNCH_ALPHA), `/api/launchpad/theses?launchId=${FIXTURE_LAUNCH_ALPHA}`);
  assert.equal(thesesUrl(FIXTURE_LAUNCH_ALPHA, "a+b/c"), `/api/launchpad/theses?launchId=${FIXTURE_LAUNCH_ALPHA}&cursor=a%2Bb%2Fc`);
  const served = { launchId: FIXTURE_LAUNCH_ALPHA, theses: { state: "available", data: { items: FIXTURE_ALPHA_THESES.theses, nextCursor: null }, provenance: PROVENANCE } };
  const { calls, fetcher } = recorder([
    Response.json(served),
    Response.json({ launchId: FIXTURE_LAUNCH_ALPHA, theses: { state: "unavailable", reason: "social-unavailable" } }, { status: 503 }),
    Response.json({ error: { code: "LAUNCHPAD_CURSOR_INVALID", message: "x" } }, { status: 400 }),
    new Response("oops", { status: 500 }),
    new Error("offline"),
    Response.json({ launchId: "0x1", theses: served.theses }),
  ]);
  assert.deepEqual(await readTheses(FIXTURE_LAUNCH_ALPHA, null, { fetcher }), served);
  assert.equal(calls[0].init?.cache, "no-store");
  assert.deepEqual(await readTheses(FIXTURE_LAUNCH_ALPHA, null, { fetcher }), {
    launchId: FIXTURE_LAUNCH_ALPHA, theses: { state: "unavailable", reason: "social-unavailable" },
  });
  assert.equal(await readTheses(FIXTURE_LAUNCH_ALPHA, "bad", { fetcher }), "invalid");
  assert.equal(await readTheses(FIXTURE_LAUNCH_ALPHA, null, { fetcher }), null);
  assert.equal(await readTheses(FIXTURE_LAUNCH_ALPHA, null, { fetcher }), null);
  assert.equal(await readTheses(FIXTURE_LAUNCH_ALPHA, null, { fetcher }), null, "an answer for another launch breaks the contract");
});

test("a Privy author posts the exact input with the session token and the CSRF cookie, fetched when missing", async () => {
  let cookie: string | null = null;
  const { calls, fetcher } = recorder([
    new Response(null, { status: 204 }),
    Response.json({ requestId: "r", post: COMMUNITY }, { status: 201 }),
  ]);
  const outcome = await publishThesis({
    input: INPUT,
    credential: privy,
    fetcher,
    csrf: () => {
      const value = cookie;
      cookie = "csrf-token";
      return value;
    },
  });
  assert.deepEqual(outcome, { status: "published", post: COMMUNITY });
  assert.equal(calls[0].url, "/api/launchpad/csrf");
  assert.equal(calls[1].url, "/api/launchpad/theses");
  assert.equal(calls[1].init?.method, "POST");
  assert.equal(calls[1].init?.credentials, "same-origin");
  assert.equal(headers(calls[1]).get("authorization"), "Bearer privy-token");
  assert.equal(headers(calls[1]).get("x-blast-csrf"), "csrf-token");
  assert.deepEqual(body(calls[1]), { input: INPUT });
});

test("a wallet author signs exactly the Wallet Proof challenge for social_post and sends it with the input", async () => {
  const challenge = { challengeId: "00000000-0000-4000-8000-00000000c0de", action: "social_post", address: WALLET, message: "Blast wallet proof\nnot a transaction", expiresAt: "2026-10-01T12:05:00.000Z" };
  const signed: string[] = [];
  const wallet: PostCredential = {
    kind: "wallet",
    address: WALLET,
    signPersonalMessage: async (message) => {
      signed.push(new TextDecoder().decode(message));
      return "wallet-signature";
    },
  };
  const { calls, fetcher } = recorder([
    Response.json({ requestId: "r", challenge }, { status: 201 }),
    Response.json({ requestId: "r", post: UPDATE }, { status: 201 }),
  ]);
  const outcome = await publishThesis({ input: { ...INPUT, kind: "creator_update", stance: null }, credential: wallet, fetcher, csrf: () => "csrf-token" });
  assert.deepEqual(outcome, { status: "published", post: UPDATE });
  assert.equal(calls[0].url, "/api/launchpad/wallet-proofs");
  assert.deepEqual(body(calls[0]), { action: "social_post", address: WALLET });
  assert.equal(headers(calls[0]).get("x-blast-csrf"), "csrf-token");
  assert.deepEqual(signed, [challenge.message]);
  assert.equal(headers(calls[1]).get("authorization"), null, "no session token with a proof");
  assert.deepEqual(body(calls[1]), {
    input: { ...INPUT, kind: "creator_update", stance: null },
    proof: { challengeId: challenge.challengeId, address: WALLET, message: challenge.message, signature: "wallet-signature" },
  });
});

test("each refusal says what happened, that nothing was posted, and how to recover", async () => {
  const refusal = (status: number, code: string, extra: HeadersInit = {}) =>
    Response.json({ requestId: "r", error: { code, message: "server words" } }, { status, headers: extra });
  const cases: Array<[Response | Error, string, RegExp]> = [
    [refusal(400, "LAUNCHPAD_STANCE_REQUIRED"), "refused", /stance.*community thesis.*Nothing was posted/s],
    [refusal(400, "LAUNCHPAD_REQUEST_INVALID"), "refused", /text.*links.*https.*Nothing was posted/s],
    [refusal(413, "LAUNCHPAD_PAYLOAD_TOO_LARGE"), "refused", /too large.*Nothing was posted/s],
    [refusal(401, "LAUNCHPAD_AUTH_INVALID"), "unauthorized", /Sign in or prove.*again.*Nothing was posted/s],
    [refusal(403, "LAUNCHPAD_FORBIDDEN"), "refused", /wallet you post with.*Nothing was posted/s],
    [refusal(404, "LAUNCHPAD_NOT_FOUND"), "refused", /not indexed.*Nothing was posted/s],
    [refusal(409, "LAUNCHPAD_CONFLICT"), "refused", /Reload.*Nothing was posted/s],
    [refusal(429, "LAUNCHPAD_RATE_LIMITED", { "Retry-After": "120" }), "unavailable", /Too many posts.*120 s.*Nothing was posted/s],
    [refusal(503, "LAUNCHPAD_UNAVAILABLE"), "unavailable", /unavailable.*Nothing was posted/s],
    [new Error("offline"), "unavailable", /did not complete.*Nothing was posted/s],
    [Response.json({ requestId: "r", post: { ...COMMUNITY, body: "x\u202Ey" } }, { status: 201 }), "unavailable", /could not be confirmed/],
  ];
  for (const [response, status, message] of cases) {
    const { fetcher } = recorder([response]);
    const outcome = await publishThesis({ input: INPUT, credential: privy, fetcher, csrf: () => "c" });
    assert.equal(outcome.status, status, message.source);
    assert.ok("message" in outcome);
    assert.match(outcome.message, message);
    assert.doesNotMatch(outcome.message, /server words/, "the server's message is not echoed");
  }
});

test("a declined proof signature or a refused challenge posts nothing", async () => {
  const declined: PostCredential = {
    kind: "wallet",
    address: WALLET,
    signPersonalMessage: async () => {
      throw new Error("User rejected the request");
    },
  };
  const challenge = { challengeId: "00000000-0000-4000-8000-00000000c0de", action: "social_post", address: WALLET, message: "m", expiresAt: "2026-10-01T12:05:00.000Z" };
  const first = recorder([Response.json({ requestId: "r", challenge }, { status: 201 })]);
  const cancelled = await publishThesis({ input: INPUT, credential: declined, fetcher: first.fetcher, csrf: () => "c" });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(first.calls.length, 1, "no post after a declined signature");

  const second = recorder([Response.json({ requestId: "r", error: { code: "LAUNCHPAD_RATE_LIMITED", message: "x" } }, { status: 429, headers: { "Retry-After": "60" } })]);
  const limited = await publishThesis({ input: INPUT, credential: declined, fetcher: second.fetcher, csrf: () => "c" });
  assert.equal(limited.status, "unavailable");
  assert.ok("message" in limited);
  assert.match(limited.message, /60 s/);
  assert.equal(second.calls.length, 1);
});
