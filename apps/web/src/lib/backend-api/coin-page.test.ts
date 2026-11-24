import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { COIN_WIRE_MAX_BYTES, encodeCoinWire } from "@blast/core/modules/launchpad-coin/wire.ts";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
    return next(specifier, context);
  },
});
const { coinObjectBackendPageRead } = await import("./coin-page.ts");

const ID = "0x" + "ab".repeat(32);
const transfer = { read: { kind: "not-found" }, browserMarket: null, explorer: null };

test("SSR coin reader forwards the current headers and reads one lossless response", async () => {
  let calls = 0;
  const read = coinObjectBackendPageRead({
    origin: "https://frontend.test",
    headers: async () => new Headers({ cookie: "synthetic-session=retained", "x-request-id": "synthetic-request" }),
    relay: async (request) => {
      calls++;
      assert.equal(request.method, "GET");
      assert.equal(request.url, `https://frontend.test/api/launchpad/coin-page/${ID}?resolvePresale=1`);
      assert.equal(request.headers.get("cookie"), "synthetic-session=retained");
      assert.equal(request.headers.get("x-request-id"), "synthetic-request");
      return new Response(encodeCoinWire(transfer));
    },
  });
  assert.deepEqual(await read(ID), { kind: "launch", launchId: ID, transfer });
  assert.equal(calls, 1);
});

test("SSR coin reader cancels an unavailable response without exposing its body", async () => {
  let cancelled = false;
  const read = coinObjectBackendPageRead({
    origin: "https://frontend.test", headers: async () => new Headers(),
    relay: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 }),
  });
  await assert.rejects(read(ID), { message: "Coin read unavailable" });
  assert.equal(cancelled, true);
});

test("SSR coin reader bounds actual streamed bytes and cancels the oversized body", async () => {
  let cancelled = false;
  const read = coinObjectBackendPageRead({
    origin: "https://frontend.test", headers: async () => new Headers(),
    relay: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(COIN_WIRE_MAX_BYTES + 1)); },
      cancel() { cancelled = true; },
    })),
  });
  await assert.rejects(read(ID), { message: "Coin read unavailable" });
  assert.equal(cancelled, true);
});

test("SSR coin reader refuses a successful response with the wrong launch identity", async () => {
  const read = coinObjectBackendPageRead({
    origin: "https://frontend.test", headers: async () => new Headers(),
    relay: async () => new Response(encodeCoinWire({
      ...transfer, read: { kind: "coin", page: { launchId: "0x" + "cd".repeat(32), confirmed: true, tradable: true } },
    })),
  });
  await assert.rejects(read(ID), { message: "Invalid coin read response" });
});

test("SSR coin reader accepts a presale redirect only to the requested object ID", async () => {
  let presaleId = "0x" + "cd".repeat(32);
  const read = coinObjectBackendPageRead({
    origin: "https://frontend.test", headers: async () => new Headers(),
    relay: async () => new Response(encodeCoinWire({ kind: "presale", presaleId })),
  });
  await assert.rejects(read(ID), { message: "Invalid presale alias response" });
  presaleId = ID;
  assert.deepEqual(await read(ID), { kind: "presale", presaleId: ID });
});
