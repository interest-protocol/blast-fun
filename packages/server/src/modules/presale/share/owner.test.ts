import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { readSharePresale, createPresaleShareHandler } from "@blast/server/modules/presale/share/runtime.ts";
import { createPresaleShareImageRoute } from "@blast/server/modules/presale/share/route.ts";
import { fixtureDetail } from "../../../../../core/test/fixtures/presale-pages/presale-fixtures.ts";

const detail = fixtureDetail("mrdn");
const path = `/presale/${detail.presale.presale_id}/share-image`;
const absent = async () => ({ logo: null, transient: false });

test("share data invokes the canonical anonymous GET once with trusted IP and sanitized headers", async () => {
  const controller = new AbortController();
  const outer = new Request("https://frontend.test" + path, { method: "HEAD", signal: controller.signal, headers: {
    cookie: "retained-session=synthetic", authorization: "synthetic", origin: "https://foreign.test",
    "x-blast-partner-key": "synthetic", "x-blast-api-key": "synthetic", "x-forwarded-for": "::ffff:192.0.2.31",
  } });
  let calls = 0;
  const client = testClient("192.0.2.31");
  const actual = await readSharePresale(outer, detail.presale.presale_id, async (inner, innerClient) => {
    assert.equal(innerClient, client);
    calls++;
    assert.equal(inner.method, "GET"); assert.equal(new URL(inner.url).pathname, "/api/social/presales/" + detail.presale.presale_id);
    assert.equal(inner.headers.get("x-forwarded-for"), "::ffff:192.0.2.31");
    for (const name of ["cookie", "authorization", "origin", "x-blast-partner-key", "x-blast-api-key"]) assert.equal(inner.headers.get(name), null);
    controller.abort(); assert.equal(inner.signal.aborted, true);
    return Response.json(detail);
  }, client);
  assert.deepEqual(actual, detail.presale); assert.equal(calls, 1);
});

test("image cache hits retain the original data admission and outer failure response", async (t) => {
  t.mock.method(console, "error", () => undefined);
  let reads = 0; let renders = 0; let status = 200;
  const owner = createPresaleShareImageRoute({
    readSale: (id, request, client) => readSharePresale(request, id, async () => { reads++; return status === 200 ? Response.json(detail) : new Response(null, { status }); }, client),
    logo: absent, cover: absent, render: async () => { renders++; return Buffer.from("png"); },
  });
  const request = new Request("https://frontend.test" + path);
  assert.equal((await owner(request, detail.presale.presale_id, testClient())).status, 200);
  assert.equal((await owner(request, detail.presale.presale_id, testClient())).status, 200);
  assert.equal(reads, 2); assert.equal(renders, 1);
  for (const innerStatus of [429, 503]) {
    status = innerStatus;
    const response = await owner(request, detail.presale.presale_id, testClient());
    assert.equal(response.status, 503); assert.equal(response.headers.get("retry-after"), "5");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  status = 404;
  assert.equal((await owner(request, detail.presale.presale_id, testClient())).status, 404); assert.equal(renders, 1);
});

test("social visibility is checked before every cached image or data read", async () => {
  let enabled = false; let reads = 0;
  const handler = createPresaleShareHandler({
    socialEnabled: () => enabled,
    image: async (_request, id) => { reads++; assert.equal(id, detail.presale.presale_id); return new Response("png"); },
  });
  const request = new Request("https://frontend.test" + path);
  assert.equal((await handler(request, testClient())).status, 404); assert.equal(reads, 0);
  enabled = true; assert.equal((await handler(request, testClient())).status, 200); assert.equal(reads, 1);
  enabled = false; assert.equal((await handler(request, testClient())).status, 404); assert.equal(reads, 1);
});

test("a failed artwork sibling cannot release its render slot before the other actual operation settles", async (t) => {
  t.mock.method(console, "error", () => undefined);
  let finish!: () => void;
  const pending = new Promise<{ logo: null; transient: boolean }>((resolve) => { finish = () => resolve({ logo: null, transient: false }); });
  let complete = false;
  const owner = createPresaleShareImageRoute({ readSale: async () => detail.presale, logo: async () => { throw new Error("synthetic"); }, cover: () => pending, render: async () => { throw new Error("must not render"); } });
  const result = owner(new Request("https://frontend.test" + path), detail.presale.presale_id, testClient()).then((response) => { complete = true; return response; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(complete, false);
    finish(); assert.equal((await result).status, 503);
  } finally { finish(); await result; }
});
