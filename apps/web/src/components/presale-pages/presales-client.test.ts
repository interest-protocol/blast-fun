import assert from "node:assert/strict";
import test from "node:test";

import { NO_ACCESS_TOKEN, fetchPresaleViewer, saleReadEveryMs } from "./presales-client.ts";

type Sent = { url: string; init: RequestInit };

function stub(status: number, body: unknown) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  return { sent, fetch };
}

const PRESALE_ID = `0x${"1".repeat(64)}`;
const ANSWER = { presales: { [PRESALE_ID]: { following: [], following_total_usd: null, following_total_atoms: "0", mine: null } }, rows: null };

test("OA-16: the viewer read goes through callSocialApi: a Privy session's token, never cached, same-origin", async () => {
  const privy = stub(200, ANSWER);
  assert.deepEqual(await fetchPresaleViewer({ getAccessToken: async () => "tok", fetch: privy.fetch }, { presale_ids: [PRESALE_ID] }), ANSWER);
  assert.equal(privy.sent.length, 1);
  assert.equal(privy.sent[0]!.url, "/api/social/presales/viewer");
  assert.equal(privy.sent[0]!.init.method, "POST");
  assert.equal(privy.sent[0]!.init.cache, "no-store");
  assert.equal(privy.sent[0]!.init.credentials, "same-origin");
  assert.deepEqual(privy.sent[0]!.init.headers, { authorization: "Bearer tok", "content-type": "application/json" });
  assert.equal(privy.sent[0]!.init.body, JSON.stringify({ presale_ids: [PRESALE_ID] }));
});

test("OA-16: a Slush wallet session (no Privy token) still reads, on its cookie alone with no Authorization header", async () => {
  const wallet = stub(200, { presales: {}, rows: [] });
  assert.deepEqual(await fetchPresaleViewer({ getAccessToken: NO_ACCESS_TOKEN, fetch: wallet.fetch }, { mine: true }), { presales: {}, rows: [] });
  assert.equal(wallet.sent.length, 1, "the read is sent, not skipped for want of a token");
  assert.equal(wallet.sent[0]!.init.credentials, "same-origin");
  assert.deepEqual(wallet.sent[0]!.init.headers, { "content-type": "application/json" });
});

test("the viewer read is null for a refusal, a malformed answer, a failing token source or a network failure", async () => {
  const token = async () => "tok";
  assert.equal(await fetchPresaleViewer({ getAccessToken: token, fetch: stub(401, { error: { code: "unauthorized" } }).fetch }, { mine: true }), null);
  assert.equal(await fetchPresaleViewer({ getAccessToken: token, fetch: stub(200, { presales: [] }).fetch }, { mine: true }), null);
  assert.equal(await fetchPresaleViewer({ getAccessToken: token, fetch: stub(200, { presales: {} }).fetch }, { mine: true }), null, "rows is required");
  assert.equal(await fetchPresaleViewer({ getAccessToken: token, fetch: stub(200, { ...ANSWER, presales: { [PRESALE_ID]: { following: [], mine: null } } }).fetch }, { mine: true }), null, "nested viewer fields are required");
  const unsent = stub(200, ANSWER);
  assert.equal(await fetchPresaleViewer({ getAccessToken: async () => Promise.reject(new Error("privy down")), fetch: unsent.fetch }, { mine: true }), null);
  assert.equal(unsent.sent.length, 0);
  const offline = (async () => Promise.reject(new TypeError("offline"))) as unknown as typeof globalThis.fetch;
  assert.equal(await fetchPresaleViewer({ getAccessToken: token, fetch: offline }, { mine: true }), null);
});

test("sale reads use infra while connected, deadlines in either mode, and a fallback for unfinished stages", () => {
  const now = 1_000_000;
  const open = { phase: "open" as const, start_ms: 0, end_ms: now + 3_600_000 };
  assert.equal(saleReadEveryMs(open, now), 30_000);
  assert.equal(saleReadEveryMs(open, now, true), 3_600_000, "no recurring poll with a live stream");
  for (const connected of [true, false]) {
    assert.equal(saleReadEveryMs({ ...open, end_ms: now + 4_000 }, now, connected), 4_000);
    assert.equal(saleReadEveryMs({ ...open, end_ms: now - 500 }, now, connected), 2_000);
  }
  const pending = { phase: "pending" as const, start_ms: now + 86_400_000, end_ms: now + 172_800_000 };
  assert.equal(saleReadEveryMs(pending, now), 30_000);
  assert.equal(saleReadEveryMs(pending, now, true), 86_400_000);
  assert.equal(saleReadEveryMs({ ...pending, start_ms: now + 9_000_000_000 }, now, true), 2_147_483_647, "no timer overflow");
  assert.equal(saleReadEveryMs({ ...pending, start_ms: 0 }, now, true), false);
  for (const phase of ["closed", "funded"] as const) {
    assert.equal(saleReadEveryMs({ ...open, phase }, now), 30_000, "a later funding or migration still arrives without hints");
    assert.equal(saleReadEveryMs({ ...open, phase }, now, true), false);
  }
  for (const phase of ["trading", "cancelled"] as const) assert.equal(saleReadEveryMs({ ...open, phase }, now), false);
});
