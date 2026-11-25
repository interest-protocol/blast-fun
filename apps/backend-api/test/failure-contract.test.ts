import assert from "node:assert/strict";
import test from "node:test";
import type { RateBucket, RateLimitPort } from "@blast/core/lib/web-security/rate-limits.ts";
import { partnerCapacity } from "@blast/server/modules/partner-api-keys/capacity.ts";
import { PartnerRecognitionStore } from "@blast/server/modules/partner-api-keys/recognition-store.ts";
import type { PartnerRecognition } from "@blast/server/modules/partner-api-keys/recognition.ts";
import { createPartnerV1Handlers } from "@blast/server/modules/partner-api/v1/handlers.ts";
import {
  firstPartyCanonicalPath,
  createBackendRelay,
} from "../../web/src/modules/partner-api/v1/relay.ts";
import {
  partnerEndpointBucket,
  partnerV1Route,
} from "@blast/server/modules/partner-api/v1/paths.ts";
import { createBackendApi, type BackendApiDependencies } from "../src/app/api/routing.ts";
import { createBackendServer } from "../src/app/server.ts";
import { capacityFixture } from "./capacity-fixture.ts";
import { installRuntimeConfig } from "../../../packages/server/test/fixtures/config/runtime-config.ts";
import { testClient } from "../../../packages/core/test/fixtures/lib/web-security/client-address.ts";

// Partner handlers build the social route kit, which reads runtime config, at construction.
installRuntimeConfig();

test("physical first-party relays preserve local route-family quota and outage contracts", async (t) => {
  let down = false;
  const secret = "synthetic-gateway-secret-01234567890123456789";
  const namespace = "a".repeat(64);
  const redis = {
    async execute(command: string[]) {
      if (down) {
        throw new Error("Synthetic quota storage outage.");
      }
      return command[0] === "SET" ? "OK" : [0, 17, 1];
    },
  };
  const handle = createBackendApi({
    redis,
    namespace,
    subjectPepper: "p".repeat(32),
    keys: {
      async verify() {
        throw new Error("First-party reads cannot query partner keys.");
      },
      async allowsOrigin() {
        return false;
      },
    },
    handlers: createPartnerV1Handlers,
  });
  const runtime = createBackendServer({
    redis,
    namespace,
    gatewaySecret: secret,
    handle,
    ready: async () => true,
  });

  t.after(() => runtime.drain());
  const relay = createBackendRelay(`http://127.0.0.1:${runtime.server.port}`, secret, {
    namespace,
    firstParty: true,
    clientAddress: () => "192.0.2.1",
  });
  const limiter: RateLimitPort = {
    async consume(bucket) {
      if (down) {
        throw new Error("Synthetic quota storage outage.");
      }
      return { allowed: false, bucket, policyVersion: 1, retryAfterSeconds: 17 };
    },
  };
  const local = createPartnerV1Handlers(limiter);
  const paths = [
    "/api/launchpad/market/status",
    "/api/launchpad/discovery",
    "/api/launchpad/search",
    "/api/social/prices",
    "/api/social/presales",
    "/api/social/presales/featured",
  ];
  for (const failed of [false, true]) {
    down = failed;
    for (const path of paths) {
      const canonical = firstPartyCanonicalPath(path)!;
      const route = partnerV1Route(canonical)!;
      const request = new Request("https://frontend.test" + path, {
        headers: { "x-forwarded-for": "198.51.100.10" },
      });
      const original = await local[route.name](request, testClient());
      const moved = await relay(request);
      assert.equal(moved.status, original.status, path);
      assert.equal((await moved.json()).error.code, (await original.json()).error.code, path);
      assert.equal(moved.headers.get("retry-after"), original.headers.get("retry-after"), path);
    }
  }
});

test("every published route consumes exactly its pre-admitted endpoint bucket", async () => {
  const consumed: RateBucket[] = [];
  const handlers = createPartnerV1Handlers({
    async consume(bucket) {
      consumed.push(bucket);
      return { allowed: false, bucket, policyVersion: 1, retryAfterSeconds: 1 };
    },
  });
  const id = "0x" + "a".repeat(64);
  const paths = [
    "presales",
    "presales/featured",
    `presales/${id}`,
    `presales/${id}/proof`,
    `presales/${id}/allowlist.csv`,
    "prices",
    "discovery",
    "search",
    `wallets/${id}/launches`,
    "market/status",
    "market/coins/0x2%3A%3Asui%3A%3ASUI",
    "market/coins/0x2%3A%3Asui%3A%3ASUI/candles",
    `market/coins/0x2%3A%3Asui%3A%3ASUI/holders`,
    `market/launches/${id}/activity`,
    `market/pools/blast_curve/${id}`,
    ...["blast_curve", "cetus", "bluefin"].map((venue) => `market/pools/${venue}/${id}/candles`),
    ...["blast_curve", "cetus", "bluefin"].map((venue) => `market/pools/${venue}/${id}/trades`),
    ...["metadata", "metrics", "contracts"].map((read) => `defillama/${read}`),
    ...["rewards", "reward-rounds"].map((read) => `market/launches/${id}/${read}`),
    ...["launches", "launch-rewards", "launch-holder-rewards"].map(
      (read) => `market/wallets/${id}/${read}`,
    ),
    "market/partners",
    `market/partners/${id}`,
    `market/partners/${id}/launches`,
    "market/launchpad/policy",
    "market/launchpad/daily-stats",
  ];
  assert.equal(paths.length, 34);
  for (const suffix of paths) {
    const path = "/api/v1/" + suffix;
    const route = partnerV1Route(path)!;
    consumed.length = 0;
    const response = await handlers[route.name](
      new Request("http://local.test" + route.sourcePath),
      testClient(),
    );
    assert.equal(response.status, 429, path);
    assert.deepEqual(consumed, [partnerEndpointBucket(path)], path);
  }
});

test("one API instance reuses handlers per admitted bucket without sharing authorization or spending twice", async () => {
  const commands: string[][] = [];
  const factories: RateLimitPort[] = [];
  let verified = 0;
  const keyId = "37ec55b3-5b5b-4d71-b7f1-0238a98eef5a";
  const redis = {
    async execute(command: string[]) {
      commands.push(command);
      return [1, 0, 0];
    },
    connectionEpoch: () => 0,
    executeAtEpoch(command: string[]) {
      return this.execute(command);
    },
  };
  const namespace = "a".repeat(64);
  const pepper = "p".repeat(32);
  const store = new PartnerRecognitionStore(
    redis,
    namespace,
    pepper,
    partnerCapacity(capacityFixture(["fixture"])),
  );
  const recognition = {
    store,
    async classify() {
      return { kind: "known", identity: { tenant: "fixture", keyId } };
    },
    responseWindow: (input: { tenant: string; internal: boolean }) =>
      store.responseWindow(input, 0),
    invalidate() {},
  } as unknown as PartnerRecognition;
  const dependencies: BackendApiDependencies = {
    redis,
    namespace,
    subjectPepper: pepper,
    recognition,
    keys: {
      async verify() {
        verified++;
        return {
          id: "fixture",
          keyId,
          origins: [],
          policy: { tier: "standard" as const },
        };
      },
      async allowsOrigin() {
        return false;
      },
    },
    handlers(limiter) {
      factories.push(limiter);
      const read = async (request: Request) => {
        const source = new URL(request.url);
        const bucket =
          source.pathname === "/api/social/prices"
            ? "social_read_prices"
            : "launchpad_market_status";
        await limiter.consume(
          source.searchParams.has("wrong_bucket") ? "launchpad_search" : bucket,
          { ip: "198.51.100.10" },
        );
        return Response.json({ source: source.pathname });
      };
      return {
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
        async presale_allowlist_csv() {
          await limiter.consume("presale_allowlist_csv", { ip: "198.51.100.10" });
          return new Response("wallet,cap\r\n", {
            headers: { "Content-Type": "text/csv; charset=utf-8" },
          });
        },
        coin_metadata: read,
      };
    },
  };
  const headers = { "x-blast-partner-key": "blast_pk_" + "a".repeat(43) };

  // Partner reads enter through preparePartner, as the transport routes them.
  async function partnerRead(api: ReturnType<typeof createBackendApi>, path: string, init = {}) {
    const prepared = await api.preparePartner(
      new Request("https://backend.test/api/v1/" + path, init),
      testClient(),
    );
    assert.ok(prepared);
    try {
      return prepared.response ?? (await prepared.handle());
    } finally {
      prepared.release?.();
    }
  }

  const handle = createBackendApi(dependencies);
  assert.equal((await partnerRead(handle, "market/status")).status, 401);
  const csvPath = `presales/0x${"f".repeat(64)}/allowlist.csv`;
  assert.equal((await partnerRead(handle, csvPath)).status, 401);
  assert.equal(
    factories.length,
    0,
    "Denied callers cannot construct the shared handler dependencies.",
  );
  for (const path of ["market/status", "prices", "market/status", "prices"]) {
    assert.equal((await partnerRead(handle, path, { headers })).status, 200);
  }
  assert.equal(factories.length, 2, "Construct once for each endpoint budget, not once per read.");
  assert.notEqual(
    factories[0],
    factories[1],
    "Each cached handler retains its own prepaid endpoint boundary.",
  );
  assert.equal(verified, 4, "Handler reuse cannot cache fresh key authorization.");
  const charges = commands.filter((command) =>
    command.some((part) => part.includes(":partner_read:")),
  );
  assert.equal(
    charges.length,
    4,
    "Every partner request has exactly one atomic commercial/endpoint decision.",
  );
  for (const command of charges) {
    assert.ok(command.some((part) => part.includes(":partner_read_global:")));
    assert.ok(command.some((part) => /:launchpad_market_status:|:social_read_prices:/.test(part)));
  }
  for (const path of ["market/status", "prices"]) {
    const response = await handle(
      new Request("https://backend.test/internal/public-read/api/v1/" + path),
      testClient(),
      true,
    );
    assert.equal(response.status, 200);
  }
  assert.equal(
    factories.length,
    2,
    "First-party reads reuse the same bucket handler after their own admission.",
  );
  assert.equal(verified, 4);
  assert.equal(
    commands.filter((command) => command.some((part) => part.includes(":partner_read:"))).length,
    4,
  );
  const mismatch = await partnerRead(handle, "market/status?wrong_bucket=1", { headers });
  assert.equal(mismatch.status, 503, "Reused prepaid handlers still reject an unadmitted bucket.");
  const second = createBackendApi(dependencies);
  assert.equal((await partnerRead(second, "market/status", { headers })).status, 200);
  assert.equal(
    factories.length,
    3,
    "A separate API instance must construct its own handler dependency scope.",
  );
  assert.notEqual(factories[2], factories[0]);

  const csv = await partnerRead(handle, csvPath, { headers });
  assert.equal(csv.status, 200);
  assert.equal(csv.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(await csv.text(), "wallet,cap\r\n");
  assert.equal(
    commands.filter((command) => command.some((part) => part.includes(":presale_allowlist_csv:")))
      .length,
    1,
  );
});
