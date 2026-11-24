import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { CREATE_CONTEXT_MAX_BYTES, encodeCreateContext, type CreatePageContext } from "@blast/core/modules/social/create/context.ts";

registerHooks({ resolve(specifier, context, next) {
  return specifier === "server-only" ? { url: "data:text/javascript,export {}", shortCircuit: true } : next(specifier, context);
} });
const { createBackendPageContext } = await import("./create-context.ts");
const context: CreatePageContext = {
  fees: { raise_bps: 200, token_bps: 100, lp_fee_meme_bps: 1000, lp_fee_quote_bps: 1000, source: "config" },
  publish: { available: false, reasons: ["presale_not_deployed"] }, quotes: [], suiPrice: null, cetusTiers: null, bluefinOptions: { status: "unavailable" },
};

test("create SSR forwards the existing session and reads context exactly once", async () => {
  let calls = 0;
  const read = createBackendPageContext({
    origin: "https://frontend.test", headers: async () => new Headers({ cookie: "synthetic-session=retained", "x-request-id": "synthetic-id" }),
    relay: async (request) => {
      calls++;
      assert.equal(request.method, "GET"); assert.equal(request.url, "https://frontend.test/api/social/create-context");
      assert.equal(request.headers.get("cookie"), "synthetic-session=retained");
      assert.equal(request.headers.get("x-request-id"), "synthetic-id");
      return new Response(encodeCreateContext(context));
    },
  });
  assert.deepEqual(await read(), context); assert.equal(calls, 1);
});

test("create SSR cancels unavailable and oversized bodies before returning an error", async () => {
  for (const oversized of [false, true]) {
    let cancelled = false;
    const read = createBackendPageContext({ origin: "https://frontend.test", headers: async () => new Headers(), relay: async () => new Response(new ReadableStream({
      start(controller) { if (oversized) controller.enqueue(new Uint8Array(CREATE_CONTEXT_MAX_BYTES + 1)); },
      cancel() { cancelled = true; },
    }), { status: oversized ? 200 : 503 }) });
    await assert.rejects(read(), { message: "Create context unavailable" }); assert.equal(cancelled, true);
  }
});

test("create SSR refuses a successful backend reply with an invalid context", async () => {
  const read = createBackendPageContext({ origin: "https://frontend.test", headers: async () => new Headers(), relay: async () => Response.json({ account: null }) });
  await assert.rejects(read(), { message: "Invalid create context" });
});
