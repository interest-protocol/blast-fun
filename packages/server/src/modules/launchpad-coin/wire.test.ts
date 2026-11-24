import assert from "node:assert/strict";
import test from "node:test";
import { launchBcs } from "@interest-protocol/blast-sdk/launchpad";
import { encodeCoinWire, decodeCoinWire, COIN_WIRE_MAX_BYTES } from "@blast/core/modules/launchpad-coin/wire.ts";
import { parseCoinPageTransfer } from "@blast/core/modules/launchpad-coin/transfer.ts";
import { privateRoute } from "@blast/core/modules/backend-api/private-routes.ts";
import { signPrivateRequest, verifyPrivateEnvelope } from "@blast/core/modules/backend-api/private-gateway.ts";
import { createFreshLaunchReader } from "./fresh.ts";
import { createLastGood, readCoinPage } from "./read.ts";
import { COIN_FIXTURE, fixtureCoreClient, launchObjectFixture } from "../../../../core/test/fixtures/modules/launchpad-coin/fixtures.ts";
import { NON_PRODUCTION_MANIFEST } from "../../../../core/test/fixtures/modules/launchpad-coin/manifest-fixtures.ts";

const path = "/api/launchpad/coin-page/" + COIN_FIXTURE.launchId;

test("a real SDK account-created launch roundtrips every bigint and Uint8Array without coercion", async () => {
  const original = launchObjectFixture("live");
  const commitment = Uint8Array.from({ length: 32 }, (_, index) => index * 7);
  const content = launchBcs.serialize({ ...launchBcs.parse(original.content), creator: { Account: Array.from(commitment) } }).toBytes();
  const fresh = createFreshLaunchReader({ manifest: NON_PRODUCTION_MANIFEST, client: fixtureCoreClient(() => ({ ...original, content })) });
  const read = await readCoinPage(COIN_FIXTURE.launchId, { market: null, readFresh: fresh, lastGood: createLastGood() });
  assert.equal(read.kind, "coin");
  if (read.kind !== "coin" || read.page.fresh.status !== "read") assert.fail("SDK launch must be read");
  assert.deepEqual(read.page.fresh.launch.creatorRecipient, { kind: "account", accountCommitment: commitment });
  const transfer = { read, browserMarket: null, explorer: null };
  const decoded = parseCoinPageTransfer(encodeCoinWire(transfer), COIN_FIXTURE.launchId);
  assert.deepEqual(decoded, transfer);
  assert.equal(decoded.read.kind, "coin");
  assert.throws(() => parseCoinPageTransfer(encodeCoinWire(transfer), COIN_FIXTURE.unknownLaunchId));
});

test("wire tags preserve strings, arrays, binary and decimal extremes without tag collisions", () => {
  const value = { text: '["bigint","12"]', nested: [0n, -12n, null, true, 0.125, ["bytes", "AA=="]], bytes: new Uint8Array() };
  assert.deepEqual(decodeCoinWire(encodeCoinWire(value)), value);
  for (const bad of [undefined, NaN, Infinity, -0, Number.MAX_SAFE_INTEGER + 1, new Date(), new Map(), new Array(2)]) assert.throws(() => encodeCoinWire(bad));
  const cyclic: unknown[] = []; cyclic.push(cyclic);
  assert.throws(() => encodeCoinWire(cyclic));
});

test("decoder rejects malformed, duplicate and prototype keys and noncanonical scalar encodings", () => {
  const values = [
    ["object", [["x", ["null"]], ["x", ["null"]]]],
    ["object", [["__proto__", ["null"]]]],
    ["object", [["constructor", ["null"]]]],
    ["bytes", "AB=="], ["bytes", "AA"], ["bigint", "01"], ["bigint", "-0"],
    ["string", 42], ["null", false], ["unknown"], ["number", "1"],
  ];
  for (const value of values) assert.throws(() => decodeCoinWire(JSON.stringify(["blast.coin-read.v1", value])));
  assert.throws(() => decodeCoinWire('["blast.coin-read.v1",["number",-0]]'));
});

test("producer and decoder enforce raw bytes, depth and node budgets before returning", () => {
  assert.throws(() => decodeCoinWire("x".repeat(COIN_WIRE_MAX_BYTES + 1)), /Invalid coin read wire/);
  assert.throws(() => encodeCoinWire("x".repeat(COIN_WIRE_MAX_BYTES + 1)));
  let deep: unknown = null;
  for (let index = 0; index < 70; index++) deep = [deep];
  assert.throws(() => encodeCoinWire(deep));
  let encoded: unknown = ["null"];
  for (let index = 0; index < 70; index++) encoded = ["array", [encoded]];
  assert.throws(() => decodeCoinWire(JSON.stringify(["blast.coin-read.v1", encoded])));
  assert.throws(() => encodeCoinWire(Array.from({ length: 100_001 }, () => null)));
});

test("SSR-only capability rejects browser, HEAD and malformed proofs before dispatch", () => {
  assert.equal(privateRoute("GET", path, "browser"), null);
  assert.equal(privateRoute("HEAD", path, "ssr-read"), null);
  assert.equal(privateRoute("GET", path, "ssr-read")?.id, "launchpad.coin-page.read");
  const secret = "synthetic-coin-ssr-only-secret-01234567890123456789";
  const namespace = "a".repeat(64);
  const input = new Request("https://frontend.test" + path);
  assert.throws(() => signPrivateRequest(input, new Uint8Array(), secret,
    { namespace, purpose: "browser", siteOrigin: "https://frontend.test", ip: "192.0.2.1" }));
  const headers = signPrivateRequest(input, new Uint8Array(), secret,
    { namespace, purpose: "ssr-read", siteOrigin: "https://frontend.test", ip: "192.0.2.1" });
  assert.ok(verifyPrivateEnvelope(new Request(input, { headers }), secret, { namespace, siteOrigin: "https://frontend.test" }));
  headers.set("x-blast-private-purpose", "browser");
  assert.equal(verifyPrivateEnvelope(new Request(input, { headers }), secret, { namespace, siteOrigin: "https://frontend.test" }), null);
});
