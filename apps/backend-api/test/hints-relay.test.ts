import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { quotaNamespace } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { verifyPrivateEnvelope } from "@blast/core/modules/backend-api/private-gateway.ts";
import { privateBackendRelay } from "@blast/server/private/relay.ts";
import { parseRelayConfig } from "@blast/server/private/relay-config.ts";

const site = "https://frontend.test";
const environment = {
  NEXT_PUBLIC_SITE_URL: site,
  BLAST_REDIS_NAMESPACE: "isolated-hints-relay",
  BLAST_BACKEND_API_ORIGIN: "https://api.test",
  BLAST_BACKEND_GATEWAY_SECRET: "a".repeat(32),
  BLAST_BACKEND_HINTS_ORIGIN: "https://hints.test",
  BLAST_BACKEND_HINTS_GATEWAY_SECRET: "h".repeat(32),
};
const proofContext = {
  namespace: quotaNamespace(environment.BLAST_REDIS_NAMESPACE, deploymentIdentity(environment)),
  siteOrigin: site,
};

test("only exact GET/HEAD hint contracts use the isolated origin and secret", async () => {
  const calls: Request[] = [];
  const relay = privateBackendRelay(parseRelayConfig(environment), {
    clientAddress: () => "192.0.2.7",
    async fetch(input, init) {
      assert.equal(init?.redirect, "manual");
      assert.equal(init?.cache, "no-store");
      const request = new Request(input, init);
      calls.push(request);
      const hints = new URL(request.url).origin === environment.BLAST_BACKEND_HINTS_ORIGIN;
      const expected = hints
        ? environment.BLAST_BACKEND_HINTS_GATEWAY_SECRET
        : environment.BLAST_BACKEND_GATEWAY_SECRET;
      const other = hints
        ? environment.BLAST_BACKEND_GATEWAY_SECRET
        : environment.BLAST_BACKEND_HINTS_GATEWAY_SECRET;
      const proof = verifyPrivateEnvelope(request, expected, proofContext);
      assert.ok(proof);
      assert.equal(proof.ip, "192.0.2.7");
      assert.equal(proof.route.id === "social.activity.hints", hints);
      assert.equal(verifyPrivateEnvelope(request, other, proofContext), null);
      return new Response(null, {
        headers: { "Cache-Control": "private, no-store", "Content-Type": "text/event-stream" },
      });
    },
  });
  for (const method of ["GET", "HEAD"]) {
    assert.equal(
      (await relay(new Request(site + "/api/social/activity/hints?cursor=fixture", { method })))
        .status,
      200,
    );
    assert.equal((await relay(new Request(site + "/api/social/activity", { method }))).status, 200);
  }
  assert.deepEqual(
    calls.map((call) => new URL(call.url).origin),
    ["https://hints.test", "https://api.test", "https://hints.test", "https://api.test"],
  );
  assert.equal(new URL(calls[0]!.url).search, "?cursor=fixture");
  for (const path of ["/api/social/activity/hints/", "/api/social/activity/hints-elsewhere"]) {
    assert.equal((await relay(new Request(site + path))).status, 404);
  }
  assert.equal(
    (await relay(new Request(site + "/api/social/activity/hints"), "ssr-read")).status,
    404,
  );
  assert.equal(calls.length, 4);
});

// This fails if an incomplete, unsafe or reused isolated hints pair parses (and
// so could fall back to the API secret), or if the refusal echoes a value.
test("incomplete or invalid isolated routing is refused at parse, naming only the variable", () => {
  const origin = "BLAST_BACKEND_HINTS_ORIGIN must be a bare HTTPS origin (HTTP only on loopback).";
  const noOrigin =
    "BLAST_BACKEND_HINTS_ORIGIN must be set with BLAST_BACKEND_HINTS_GATEWAY_SECRET.";
  const cases: ReadonlyArray<readonly [Record<string, string | undefined>, string]> = [
    [{ BLAST_BACKEND_HINTS_ORIGIN: "" }, noOrigin],
    [{ BLAST_BACKEND_HINTS_ORIGIN: undefined }, noOrigin],
    [{ BLAST_BACKEND_HINTS_ORIGIN: "https://hints.test/path" }, origin],
    [{ BLAST_BACKEND_HINTS_ORIGIN: "http://hints.test" }, origin],
    [{ BLAST_BACKEND_HINTS_ORIGIN: "https://user:secret@hints.test" }, origin],
    [
      { BLAST_BACKEND_HINTS_GATEWAY_SECRET: undefined },
      "BLAST_BACKEND_HINTS_GATEWAY_SECRET must be set with BLAST_BACKEND_HINTS_ORIGIN.",
    ],
    [
      { BLAST_BACKEND_HINTS_GATEWAY_SECRET: "too-short" },
      "BLAST_BACKEND_HINTS_GATEWAY_SECRET must be at least 32 characters.",
    ],
    [
      { BLAST_BACKEND_HINTS_GATEWAY_SECRET: environment.BLAST_BACKEND_GATEWAY_SECRET },
      "BLAST_BACKEND_HINTS_GATEWAY_SECRET must differ from BLAST_BACKEND_GATEWAY_SECRET.",
    ],
  ];
  for (const [override, message] of cases) {
    assert.throws(
      () => parseRelayConfig({ ...environment, ...override }),
      { message },
      JSON.stringify(override),
    );
  }
});

test("without the isolated configuration, hint streams fail closed and never reach the API", async () => {
  let calls = 0;
  const relay = privateBackendRelay(
    parseRelayConfig({
      ...environment,
      BLAST_BACKEND_HINTS_ORIGIN: undefined,
      BLAST_BACKEND_HINTS_GATEWAY_SECRET: undefined,
    }),
    {
      clientAddress: () => "192.0.2.7",
      async fetch() {
        calls++;
        return new Response(null);
      },
    },
  );
  const response = await relay(new Request(site + "/api/social/activity/hints"));
  assert.equal(response.status, 503);
  assert.equal(calls, 0);
  assert.equal(
    (await relay(new Request(site + "/api/social/activity"))).status,
    200,
    "ordinary reads still reach the API",
  );
  assert.equal(calls, 1);
});

test("a trailing slash on a backend origin is accepted and the signed site origin stays normalized text", async () => {
  const targets: string[] = [];
  const relay = privateBackendRelay(
    parseRelayConfig({
      ...environment,
      NEXT_PUBLIC_SITE_URL: `${site}/`,
      BLAST_BACKEND_API_ORIGIN: "https://api.test/",
    }),
    {
      clientAddress: () => "192.0.2.7",
      async fetch(input, init) {
        const request = new Request(input, init);
        targets.push(request.url);
        assert.ok(
          verifyPrivateEnvelope(request, environment.BLAST_BACKEND_GATEWAY_SECRET, proofContext),
        );
        return new Response(null, { headers: { "Cache-Control": "private, no-store" } });
      },
    },
  );

  assert.equal((await relay(new Request(`${site}/api/social/activity`))).status, 200);
  assert.deepEqual(targets, ["https://api.test/api/social/activity"]);
});

// This fails if a plain-HTTP hosted site origin parses and gets signed.
test("a plain http site origin off loopback is refused at parse", () => {
  assert.throws(
    () => parseRelayConfig({ ...environment, NEXT_PUBLIC_SITE_URL: "http://hosted.test" }),
    { message: "NEXT_PUBLIC_SITE_URL must be a bare HTTPS origin (HTTP only on loopback)." },
  );
});

test("a backend origin on any 127.0.0.0/8 loopback is accepted", async () => {
  const targets: string[] = [];
  const relay = privateBackendRelay(
    parseRelayConfig({ ...environment, BLAST_BACKEND_API_ORIGIN: "http://127.5.6.7:8080" }),
    {
      clientAddress: () => "192.0.2.7",
      async fetch(input, init) {
        targets.push(new Request(input, init).url);
        return new Response(null, { headers: { "Cache-Control": "private, no-store" } });
      },
    },
  );

  assert.equal((await relay(new Request(`${site}/api/social/activity`))).status, 200);
  assert.deepEqual(targets, ["http://127.5.6.7:8080/api/social/activity"]);
});
