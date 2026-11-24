import assert from "node:assert/strict";
import test from "node:test";
import type { PartnerV1Handlers } from "@blast/server/modules/partner-api/v1/route.ts";
import { verifyGatewayRequest } from "@blast/core/modules/backend-api/gateway.ts";
import { frontendClientAddress } from "@blast/core/modules/backend-api/frontend-ingress.ts";
import { createBackendRelay } from "../../web/src/modules/partner-api/v1/relay.ts";
import { createBackendApi } from "../src/app/api/routing.ts";
import type { Admitted } from "../src/app/api/admission/contract.ts";
import { createReadHttp } from "../src/app/api/read-http.ts";
import { createReadHandlers } from "../src/app/api/reads.ts";
import { testClient } from "../../../packages/core/test/fixtures/lib/web-security/client-address.ts";

const namespace = "a".repeat(64);
const secret = "s".repeat(32);

test("public relay rejects explicit partner credentials before stripping and signs anonymous reads", async () => {
  let forwarded = 0;
  const relay = createBackendRelay("https://backend.test", secret, {
    firstParty: true,
    namespace,
    clientAddress: (request) => frontendClientAddress(request, { vercel: true, localRun: false }),
    async fetch(input, init) {
      forwarded++;
      const request = new Request(input, init);
      for (const name of [
        "authorization",
        "cookie",
        "x-blast-partner-key",
        "x-blast-api-key",
        "x-blast-internal-user",
      ]) {
        assert.equal(request.headers.has(name), false, name);
      }
      assert.equal(verifyGatewayRequest(request, secret, namespace)?.ip, "198.51.100.7");
      return Response.json({ public: true });
    },
  });
  const headers = {
    authorization: "Bearer stale-privy-token",
    cookie: "__Host-blast_wallet=" + "w".repeat(43),
    "x-blast-api-key": "private",
    "x-blast-internal-user": "spoofed",
    "x-vercel-forwarded-for": "198.51.100.7",
    "x-forwarded-for": "203.0.113.99",
  };
  const response = await relay(new Request("https://frontend.test/api/social/prices", { headers }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
  const partner = await relay(
    new Request("https://frontend.test/api/social/prices", {
      headers: { ...headers, "x-blast-partner-key": "blast_pk_" + "a".repeat(43) },
    }),
  );
  assert.equal(partner.status, 403);
  assert.equal(forwarded, 1);
});

test("stale wallet and Privy credentials cause no session work or Set-Cookie on public backend reads", async () => {
  let charges = 0;
  let reads = 0;
  const read = async (request: Request) => {
    reads++;
    assert.equal(request.headers.has("cookie"), false);
    assert.equal(request.headers.has("authorization"), false);
    return Response.json({ public: true });
  };
  const handlers: PartnerV1Handlers = {
    market: read,
    prices: read,
    presales: read,
    featured: read,
    presale: read,
    discovery: read,
    search: read,
    defillama: read,
    daily_stats: read,
    wallet_launches: read,
    presale_proof: read,
    coin_metadata: read,
  };
  const api = createBackendApi({
    namespace,
    subjectPepper: "p".repeat(32),
    redis: {
      async execute() {
        charges++;
        return [1, 0, 0];
      },
    },
    keys: {
      async verify() {
        assert.fail("No partner SQL on anonymous reads");
      },
      async allowsOrigin() {
        assert.fail("No preflight SQL on anonymous reads");
      },
    },
    handlers: () => handlers,
  });
  const request = new Request("https://backend.test/internal/public-read/api/v1/prices", {
    headers: {
      cookie: "__Host-blast_wallet=" + "e".repeat(43),
      authorization: "Bearer expired",
      "x-vercel-forwarded-for": "198.51.100.7",
      "x-forwarded-for": "203.0.113.99",
    },
  });
  const response = await api(request, testClient("203.0.113.99"), true);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(reads, 1);
  assert.equal(charges, 1, "Endpoint budget is charged exactly once.");
});

test("admitted reads preserve the owner request and the public, partner and HEAD response shapes", async () => {
  const query = "?coin=0x2%3a%3Asui%3A%3ASUI&coin=0x3&cursor=a%2fb%2B%26";
  const path = `/api/v1/prices${query}`;
  const failure = new Error("Synthetic read failure");
  let ownerFailure = false;
  let cancelled = 0;
  const fullPrice = { value: 10, price_as_of_ms: 1 };
  const unused = async () => assert.fail("Only the prices owner may run");
  const prices = async (request: Request) => {
    assert.equal(request.url, `https://backend.test/api/social/prices${query}`);
    assert.equal(request.method, "GET");
    for (const name of ["cookie", "authorization", "origin", "x-blast-internal-user"]) {
      assert.equal(request.headers.has(name), false, name);
    }
    if (ownerFailure) {
      throw failure;
    }
    if (request.headers.has("if-none-match")) {
      return new Response(
        new ReadableStream({
          cancel: () => {
            cancelled++;
          },
        }),
        {
          status: 429,
          headers: { "retry-after": "3" },
        },
      );
    }
    return Response.json(
      { prices: [fullPrice] },
      { headers: { "cache-control": "public, max-age=10" } },
    );
  };
  const prepaid = { consume: async () => assert.fail("The fixture owner does not charge quota") };
  const reads = createReadHandlers((port) => {
    assert.equal(port, prepaid);
    return {
      prices,
      coin_metadata: unused,
      daily_stats: unused,
      defillama: unused,
      discovery: unused,
      featured: unused,
      market: unused,
      presale: unused,
      presale_proof: unused,
      presales: unused,
      search: unused,
      wallet_launches: unused,
    };
  });
  const request = new Request(`https://backend.test${path}`, {
    headers: {
      cookie: "stale=fixture",
      authorization: "Bearer fixture",
      origin: "https://partner.test",
      "x-blast-internal-user": "fixture",
    },
  });
  const admission: Admitted = {
    kind: "admitted",
    request,
    client: testClient("198.51.100.7"),
    endpoint: "social_read_prices",
    prepaid,
    headers: new Headers({ "access-control-allow-origin": "https://partner.test" }),
  };
  try {
    const firstParty = await reads.readFirstParty(admission);
    assert.equal(firstParty.headers.get("cache-control"), "public, max-age=10");
    assert.equal(firstParty.headers.get("x-blast-api-version"), null);
    assert.deepEqual(await firstParty.json(), { prices: [fullPrice] });

    const partner = await reads.readPartner(admission);
    assert.equal(partner.headers.get("cache-control"), "private, no-store");
    assert.equal(partner.headers.get("x-blast-api-version"), "1");
    assert.equal(partner.headers.get("access-control-allow-origin"), "https://partner.test");
    assert.deepEqual(await partner.json(), { prices: [{ value: 10 }] });

    const head = await reads.readPartner({
      ...admission,
      request: new Request(request, { method: "HEAD", headers: { "if-none-match": '"fixture"' } }),
    });
    assert.equal(head.status, 429);
    assert.equal(head.headers.get("retry-after"), "3");
    assert.equal(head.body, null);
    assert.equal(cancelled, 1);

    ownerFailure = true;
    await assert.rejects(
      () => reads.readFirstParty(admission),
      (cause) => cause === failure,
    );
    const unavailable = await reads.readPartner(admission);
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).error.code, "partner_api_unavailable");
  } finally {
    await reads.dispose();
  }
});

test("an aborted read waits for the owner and hands its late body to the transport", async () => {
  const http = createReadHttp();
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const controller = new AbortController();
  let settled = false;
  let cancelled = false;
  const pending = http
    .handle(
      new Request("https://backend.test/api/v1/prices", { signal: controller.signal }),
      async () => {
        started.resolve();
        await finish.promise;
        return new Response(
          new ReadableStream({
            cancel: () => {
              cancelled = true;
            },
          }),
        );
      },
    )
    .finally(() => {
      settled = true;
    });
  try {
    await started.promise;
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    finish.resolve();
    const response = await pending;
    assert.equal(response.status, 200);
    await response.body?.cancel();
    assert.equal(cancelled, true);
  } finally {
    finish.resolve();
    await http.dispose();
  }
});
