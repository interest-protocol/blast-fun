import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createRedisConnection } from "@blast/core/lib/redis.ts";
import { DEFAULT_RATE_POLICIES } from "@blast/core/lib/web-security/rate-limits.ts";
import { signGatewayRequest } from "@blast/core/modules/backend-api/gateway.ts";
import { partnerCapacity } from "@blast/server/modules/partner-api-keys/capacity.ts";
import type { PartnerRecognition } from "@blast/server/modules/partner-api-keys/recognition.ts";
import type { PartnerV1Handlers } from "@blast/server/modules/partner-api/v1/route.ts";
import { createBackendApi } from "../src/app/api/routing.ts";
import { createBackendServer } from "../src/app/server.ts";
import { capacityFixture } from "./capacity-fixture.ts";

const redisUrl = process.env.BLAST_TEST_REDIS_URL;
test(
  "real gateway admission executes a public handler once and fails closed on uncertain Redis outcomes",
  { skip: !redisUrl },
  async (t) => {
    assert.ok(redisUrl);
    assert.equal(new URL(redisUrl).hostname, "127.0.0.1");
    const redis = createRedisConnection(redisUrl, "quota");
    const namespace = "a".repeat(64);
    const secret = "s".repeat(32);
    let reads = 0;
    let verifications = 0;
    let commands = 0;
    let uncertain = false;
    let lastCommand: string[] = [];
    const instrumented = {
      async execute(command: string[]) {
        commands++;
        lastCommand = command;
        const result = await redis.execute(command);
        if (uncertain && ["EVAL", "EVALSHA"].includes(command[0]!)) {
          uncertain = false;
          throw new Error("Synthetic lost Redis acknowledgement.");
        }
        return result;
      },
    };
    const read = async () => {
      reads++;
      return Response.json({ ok: true });
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
      presale_allowlist_csv: read,
      coin_metadata: read,
    };
    const handle = createBackendApi({
      redis: instrumented,
      namespace,
      subjectPepper: "p".repeat(32),
      handlers: () => handlers,
      // A malformed key is refused before classification; only the capacity is read.
      recognition: {
        store: { capacity: partnerCapacity(capacityFixture(["fixture"])) },
      } as unknown as PartnerRecognition,
      keys: {
        async verify() {
          verifications++;
          return null;
        },
        async allowsOrigin() {
          verifications++;
          return false;
        },
      },
      policies: {
        ...DEFAULT_RATE_POLICIES,
        defillama_public_global: {
          ...DEFAULT_RATE_POLICIES.defillama_public_global,
          windows: [{ limit: 1, windowSeconds: 60 }],
        },
        social_read_prices: {
          ...DEFAULT_RATE_POLICIES.social_read_prices,
          windows: [{ limit: 1, windowSeconds: 60 }],
        },
      },
    });
    const runtime = createBackendServer({
      handle,
      preparePartner: handle.preparePartner,
      redis: instrumented,
      namespace,
      gatewaySecret: secret,
      ready: async () => true,
    });
    t.after(async () => {
      await runtime.drain();
      redis.close();
    });
    const target = new Request(
      `http://127.0.0.1:${runtime.server.port}/internal/public-read/api/v1/prices`,
    );
    const ip = "198.51.100.7";
    const headers = signGatewayRequest(target, secret, ip, namespace);
    const answers = await Promise.all(
      Array.from({ length: 20 }, () => fetch(target.url, { headers })),
    );
    assert.equal(answers.filter((answer) => answer.status === 200).length, 1);
    assert.equal(answers.filter((answer) => answer.status === 403).length, 19);
    await Promise.all(answers.map((answer) => answer.body?.cancel()));
    assert.equal(reads, 1);
    assert.equal(verifications, 0);
    const beforeWarm = commands;
    const refusedHeaders = signGatewayRequest(target, secret, ip, namespace);
    const refusal = await fetch(target.url, { headers: refusedHeaders });
    assert.equal(refusal.status, 429);
    await refusal.body?.cancel();
    assert.equal(commands - beforeWarm, 1, "A warm first-party admission makes one Redis call.");
    const replay = await fetch(target.url, { headers: refusedHeaders });
    assert.equal(replay.status, 403);
    await replay.body?.cancel();
    assert.equal(reads, 1);

    uncertain = true;
    const lostHeaders = signGatewayRequest(target, secret, "203.0.113.17", namespace);
    const lost = await fetch(target.url, { headers: lostHeaders });
    assert.equal(lost.status, 503);
    await lost.body?.cancel();
    assert.equal(reads, 1, "An unknown admission outcome cannot run the handler.");
    const lostReplay = await fetch(target.url, { headers: lostHeaders });
    assert.equal(lostReplay.status, 403);
    await lostReplay.body?.cancel();
    assert.equal(reads, 1);

    const malformed = new Request(`http://127.0.0.1:${runtime.server.port}/api/v1/prices`, {
      headers: { "x-blast-partner-key": "malformed-" + randomUUID() },
    });
    const malformedHeaders = signGatewayRequest(malformed, secret, ip, namespace);
    const invalidKey = await fetch(malformed.url, { headers: malformedHeaders });
    assert.equal(invalidKey.status, 401);
    await invalidKey.body?.cancel();
    const invalidReplay = await fetch(malformed.url, { headers: malformedHeaders });
    assert.equal(invalidReplay.status, 403);
    await invalidReplay.body?.cancel();
    assert.equal(verifications, 0, "Malformed keys still never reach SQL.");

    const reportingUrl = `http://127.0.0.1:${runtime.server.port}/internal/public-read/api/v1/defillama`;
    const metadata = new Request(`${reportingUrl}/metadata`);
    const unsigned = await fetch(metadata.url);
    assert.equal(unsigned.status, 403);
    await unsigned.body?.cancel();

    const beforeReporting = commands;
    const report = await fetch(metadata.url, {
      headers: signGatewayRequest(metadata, secret, ip, namespace),
    });
    assert.equal(report.status, 200);
    await report.body?.cancel();
    assert.equal(commands - beforeReporting, 1, "Reporting spends all quotas in one Redis call.");
    for (const bucket of ["defillama_read", "defillama_public_global", "partner_read_global"]) {
      assert.ok(
        lastCommand.some((part) => part.includes(`:${bucket}:`)),
        bucket,
      );
    }
    const metrics = new Request(`${reportingUrl}/metrics?date=2026-11-07`);
    const throttled = await fetch(metrics.url, {
      headers: signGatewayRequest(metrics, secret, "198.51.100.8", namespace),
    });
    assert.equal(throttled.status, 429);
    await throttled.body?.cancel();
    assert.equal(reads, 2, "The anonymous cap spans different clients and reporting endpoints.");
    assert.equal(verifications, 0, "Public reporting does not consult the partner key store.");
  },
);

test(
  "an extra site's first-party reads spend their own namespace; partner proofs stay primary-only",
  { skip: !redisUrl },
  async (t) => {
    assert.ok(redisUrl);
    assert.equal(new URL(redisUrl).hostname, "127.0.0.1");
    const redis = createRedisConnection(redisUrl, "quota");
    // Fresh namespaces, so counters from other runs on this Redis cannot interfere.
    const [namespace, dev, unknown] = Array.from({ length: 3 }, () =>
      randomUUID().replaceAll("-", "").repeat(2),
    ) as [string, string, string];
    const secret = "s".repeat(32);
    const keys: string[] = [];
    const recording = {
      async execute(command: string[]) {
        keys.push(...command.filter((part) => part.includes(":")));
        return redis.execute(command);
      },
    };
    let reads = 0;
    const read = async () => {
      reads++;
      return Response.json({ ok: true });
    };
    const handlers = Object.fromEntries(
      [
        "market",
        "prices",
        "presales",
        "featured",
        "presale",
        "discovery",
        "search",
        "defillama",
        "daily_stats",
        "wallet_launches",
        "presale_proof",
        "presale_allowlist_csv",
        "coin_metadata",
      ].map((name) => [name, read]),
    ) as unknown as PartnerV1Handlers;
    const handle = createBackendApi({
      redis: recording,
      namespace,
      extraNamespaces: [dev],
      subjectPepper: "p".repeat(32),
      handlers: () => handlers,
      keys: {
        verify: async () => assert.fail("no partner key reaches the store"),
        allowsOrigin: async () => false,
      },
      policies: {
        ...DEFAULT_RATE_POLICIES,
        social_read_prices: {
          ...DEFAULT_RATE_POLICIES.social_read_prices,
          windows: [{ limit: 1, windowSeconds: 60 }],
        },
      },
    });
    const runtime = createBackendServer({
      handle,
      preparePartner: handle.preparePartner,
      redis: recording,
      namespace,
      extraSites: [{ siteOrigin: "https://dev.frontend.test", namespace: dev }],
      gatewaySecret: secret,
      ready: async () => true,
    });
    t.after(async () => {
      await runtime.drain();
      redis.close();
    });
    const target = new Request(
      `http://127.0.0.1:${runtime.server.port}/internal/public-read/api/v1/prices`,
    );
    const ip = "198.51.100.9";
    const status = async (request: Request, headers: Headers) => {
      const answer = await fetch(request.url, { headers });
      await answer.body?.cancel();
      return answer.status;
    };

    assert.equal(await status(target, signGatewayRequest(target, secret, ip, namespace)), 200);
    const devHeaders = signGatewayRequest(target, secret, ip, dev);
    const before = keys.length;
    assert.equal(await status(target, devHeaders), 200, "prod's spent quota does not limit dev");
    const devKeys = keys.slice(before);
    assert.ok(devKeys.some((key) => key.startsWith(`${dev}:`)));
    assert.ok(!devKeys.some((key) => key.includes(namespace)), "a dev read writes no primary key");
    assert.equal(await status(target, devHeaders), 403, "a dev proof is single use");
    assert.equal(
      await status(target, signGatewayRequest(target, secret, ip, dev)),
      429,
      "dev's own quota is spent",
    );
    assert.equal(await status(target, signGatewayRequest(target, secret, ip, unknown)), 403);

    const partner = new Request(`http://127.0.0.1:${runtime.server.port}/api/v1/prices`, {
      headers: { "x-blast-partner-key": "malformed-" + randomUUID() },
    });
    assert.equal(
      await status(partner, signGatewayRequest(partner, secret, ip, dev)),
      403,
      "an extra site never signs partner reads",
    );
    assert.equal(reads, 2);
  },
);
