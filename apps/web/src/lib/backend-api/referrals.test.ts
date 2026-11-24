import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { encodeReferralContext, REFERRAL_CONTEXT_MAX_BYTES } from "@blast/core/modules/social/referrals/share-context.ts";
registerHooks({ resolve(specifier, context, next) { return specifier === "server-only" ? { url: "data:text/javascript,export {}", shortCircuit: true } : next(specifier, context); } });
const { referralBackendPageRead } = await import("./referrals.ts");
const inviter = { callsign: "new_friend", crew: null, title: null, avatarUrl: null };

test("referral SSR keeps the existing request headers and performs one bounded context read", async () => {
  let calls = 0;
  const read = referralBackendPageRead({ origin: "https://frontend.test", headers: async () => new Headers({ cookie: "retained-session=synthetic" }), relay: async (request) => {
    calls++; assert.equal(request.method, "GET"); assert.equal(request.url, "https://frontend.test/api/social/referral-inviter/new_friend");
    assert.equal(request.headers.get("cookie"), "retained-session=synthetic"); return new Response(encodeReferralContext(inviter, inviter.callsign));
  } });
  assert.deepEqual(await read("NEW_FRIEND"), inviter); assert.equal(calls, 1);
  assert.equal(await read("<script>"), null); assert.equal(calls, 1);
});

test("referral SSR awaits cancellation of unavailable and oversized response bodies", async () => {
  for (const oversized of [false, true]) {
    let canceled = false;
    const read = referralBackendPageRead({ origin: "https://frontend.test", headers: async () => new Headers(), relay: async () => new Response(new ReadableStream({
      start(controller) { if (oversized) controller.enqueue(new Uint8Array(REFERRAL_CONTEXT_MAX_BYTES + 1)); }, cancel() { canceled = true; },
    }), { status: oversized ? 200 : 503 }) });
    await assert.rejects(read("new_friend"), /Referral context unavailable/); assert.equal(canceled, true);
  }
});

test("referral SSR rejects mismatched identity and unexpected private response fields", async () => {
  for (const inviter of [{ callsign: "other_friend", crew: null, title: null, avatarUrl: null }, { callsign: "new_friend", crew: null, title: null, avatarUrl: null, session: "private" }]) {
    const read = referralBackendPageRead({ origin: "https://frontend.test", headers: async () => new Headers(), relay: async () => Response.json({ version: "blast.referral-inviter.v1", inviter }) });
    await assert.rejects(read("new_friend"), /Referral context unavailable/);
  }
});
