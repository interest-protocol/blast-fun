import { testClient } from "../../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import sharp from "sharp";
import { fixtureDetail } from "../../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import { createPresaleShareHandler } from "@blast/server/modules/presale/share/runtime.ts";
import { createPresaleShareImageRoute } from "@blast/server/modules/presale/share/route.ts";
import { renderPresaleSharePng } from "@blast/server/modules/presale/share/image.ts";
import { presaleShareMetadata } from "./metadata.ts";

const key = "blast.test.presaleShare";
const state = { enabled: true, status: "ok", detail: fixtureDetail("mrdn"), reads: 0, relays: 0 };
const noArtwork = async () => ({ logo: null, transient: false });
const image = createPresaleShareImageRoute({
  readSale: async () => {
    state.reads++;
    if (state.status === "error") throw new Error("synthetic unavailable read");
    return state.status === "missing" ? null : state.detail.presale;
  },
  logo: noArtwork, cover: noArtwork, render: renderPresaleSharePng,
});
const canonical = createPresaleShareHandler({ image, flags: () => ({ presale: state.enabled, social: state.enabled }) });
const bridge = { state, async relay(request: Request) { state.relays++; return canonical(request, testClient()); } };
(globalThis as Record<symbol, unknown>)[Symbol.for(key)] = bridge;
const source = `const bridge = globalThis[Symbol.for(${JSON.stringify(key)})];
const state = bridge.state;
export async function requestLaunchFlags() { return { presale: state.enabled, social: state.enabled }; }
export async function saleOf() { state.reads++; return state.status === "ok" ? { status: "ok", detail: state.detail } : { status: state.status }; }
export const backendPrivateRequest = (request) => bridge.relay(request);`;
registerHooks({ resolve(specifier, context, next) {
  if (["#web/lib/launch-flags.server.ts", "#web/components/presale-pages/server-reads.ts", "@blast/server/private/relay.ts"].includes(specifier)) {
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { generateMetadata } = await import("../../../app/(app)/presale/(sales)/[presaleId]/page.tsx");
const { GET, HEAD } = await import("../../../app/presale/(tools)/[presaleId]/share-image/route.ts");
const params = Promise.resolve({ presaleId: state.detail.presale.presale_id });
const request = (id = state.detail.presale.presale_id) => new Request(`https://www.blast.fun/presale/${id}/share-image`);

test("page metadata and thin image transport reach the canonical PNG owner and preserve launch visibility", async (t) => {
  assert.deepEqual(await generateMetadata({ params }), presaleShareMetadata(state.detail.presale));
  assert.equal(GET, HEAD);
  const response = await GET(request());
  assert.equal(state.relays, 1); assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  const image = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
  assert.deepEqual([image.width, image.height], [1200, 675]);
  state.enabled = false;
  const reads = state.reads;
  assert.deepEqual(await generateMetadata({ params }), {});
  const hidden = await GET(request());
  assert.equal(hidden.status, 404); assert.equal(hidden.headers.get("cache-control"), "private, no-store");
  assert.equal(state.reads, reads, "disabled releases do not read data even after a cached image");
  state.enabled = true; state.status = "missing";
  await assert.rejects(generateMetadata({ params }), /NEXT_HTTP_ERROR_FALLBACK;404/);
  assert.equal((await GET(request())).status, 404);
  await assert.rejects(generateMetadata({ params: Promise.resolve({ presaleId: "bad" }) }), /NEXT_HTTP_ERROR_FALLBACK;404/);
  assert.equal((await GET(request("bad"))).status, 404);
  state.status = "error"; t.mock.method(console, "error", () => undefined);
  assert.equal((await GET(request())).status, 503);
});
