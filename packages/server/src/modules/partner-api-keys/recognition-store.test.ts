import { createHmac } from "node:crypto";
import {
  DEFAULT_RATE_POLICIES,
  rateLimitSubjectKey,
} from "@blast/core/lib/web-security/rate-limits.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { RedisBusy, type RedisCommands } from "@blast/core/lib/redis.ts";
import { GatewayReplayError } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { partnerCapacity } from "./capacity.ts";
import { syntheticCapacity } from "./capacity.test.ts";
import {
  PartnerRecognitionStore,
  RecognitionIntegrityError,
  RecognitionRequestInvalid,
} from "./recognition-store.ts";

function storeWithReply(reply: unknown) {
  const redis: RedisCommands = {
    execute: async () => reply,
    executeAtEpoch: async () => reply,
    connectionEpoch: () => 1,
  };
  return new PartnerRecognitionStore(
    redis,
    "test:recognition-decisions",
    "synthetic-pepper-at-least-thirty-two-characters",
    partnerCapacity(JSON.stringify(syntheticCapacity)),
  );
}

test("fixed integrity decision and malformed classifier replies are typed refusals", async () => {
  for (const reply of [
    [5],
    null,
    "invalid",
    [],
    [1, "quiet", "not-a-uuid"],
    [5, "unexpected"],
    [4, 61, 1, 0],
  ]) {
    await assert.rejects(
      storeWithReply(reply).classify(
        { digest: "f".repeat(64), ip: "198.18.0.1" },
        1,
      ),
      RecognitionIntegrityError,
    );
  }
});

test("fixed replay and ordinary membership decisions retain their semantics", async () => {
  await assert.rejects(
    storeWithReply([2]).classify({ ip: "198.18.0.1" }, 1),
    GatewayReplayError,
  );
  assert.deepEqual(
    await storeWithReply([0]).classify({ ip: "198.18.0.1" }, 1),
    { kind: "unknown" },
  );
});

test("RedisBusy passes through without becoming an integrity repair request", async () => {
  const busy = new RedisBusy();
  const store = storeWithReply(null);
  store.redis.executeAtEpoch = async () => {
    throw busy;
  };
  await assert.rejects(
    store.classify({ ip: "198.18.0.1" }, 1),
    (error) => error === busy,
  );
});

test("limited replies carry exactly one admission scope", async () => {
  for (const [reply, limit] of [
    [[4, 30, 0, 0], "unknown"],
    [[4, 30, 1, 1], "key"],
    [[4, 30, 1, 2], "preflight"],
    [[4, 30, 1, 3], "preflight-ip"],
  ] as const)
    assert.deepEqual(
      await storeWithReply(reply).classify({ ip: "198.18.0.1" }, 1),
      { kind: "limited", retryAfter: 30, recognized: reply[2] === 1, limit },
    );
  for (const reply of [
    [4, 30, 1],
    [4, 30, 1, 4],
    [4, 30, 1, 1, 0],
  ])
    await assert.rejects(
      storeWithReply(reply).classify({ ip: "198.18.0.1" }, 1),
      RecognitionIntegrityError,
    );
});

test("per-network preflight identity: IPv4 per address, IPv6 per /64, invalid input is request-scoped", async () => {
  const seen: string[][] = [];
  const store = storeWithReply([3]);
  store.redis.executeAtEpoch = async (args) => {
    seen.push(args);
    return [3];
  };
  const network = async (ip: string) => {
    await store.classify({ origin: "https://quiet.example", ip }, 1);
    const args = seen.at(-1)!;
    const numkeys = Number(args[2]);
    assert.equal(numkeys, 8);
    assert.equal(args.length, 3 + numkeys + 7);
    assert.equal(
      args[3 + numkeys + 6],
      "25",
      "default sub-limit is a quarter of reserves.preflight",
    );
    const key = args[3 + 6]!;
    assert.match(
      key,
      /^test:recognition-decisions:\{partner-quota\}:recognition-admission:preflight-ip:[0-9a-f]{64}$/,
    );
    return key.slice(key.lastIndexOf(":") + 1);
  };
  assert.match(await network("198.18.0.1"), /^[0-9a-f]{64}$/);
  assert.notEqual(await network("198.18.0.1"), await network("198.18.0.2"));
  assert.equal(
    await network("2001:db8:1:2::1"),
    await network("2001:db8:1:2:ffff::9"),
  );
  assert.notEqual(
    await network("2001:db8:1:2::1"),
    await network("2001:db8:1:3::1"),
  );
  for (const ip of ["", "198.18.0.1, 10.0.0.1", "fe80::1%eth0", "not-an-ip"])
    await assert.rejects(store.classify({ ip }, 1), RecognitionRequestInvalid);
  for (const nonce of ["short", "x".repeat(33)])
    await assert.rejects(
      store.classify({ ip: "198.18.0.1", nonce }, 1),
      RecognitionRequestInvalid,
    );
});

test("classifier declares the exact existing Redis keys, including optional replay, in one hash slot", async () => {
  const store = storeWithReply([0]);
  let command: string[] = [];
  store.redis.executeAtEpoch = async (args) => {
    command = args;
    return [0];
  };
  const namespace = "test:recognition-decisions";
  const pepper = "synthetic-pepper-at-least-thirty-two-characters";
  const hash = (value: string) =>
    createHmac("sha256", pepper).update(value).digest("hex");
  const ip = "198.18.0.1";
  const digest = "f".repeat(64);
  const prefix = `${namespace}:{partner-quota}:recognition-admission`;
  const nonce = "a".repeat(32);
  for (const replay of [undefined, nonce]) {
    await store.classify({ ip, digest, nonce: replay }, 1);
    const numkeys = Number(command[2]);
    assert.equal(numkeys, replay ? 9 : 8);
    const keys = command.slice(3, 3 + numkeys);
    assert.deepEqual(keys, [
      ...["metadata", "keys", "origins"].map(
        (name) => `${namespace}:{partner-quota}:recognition:${name}`,
      ),
      ...(["partner_auth_ip", "partner_auth_global"] as const).map((bucket) => {
        const policy = DEFAULT_RATE_POLICIES[bucket];
        return `${namespace}:{partner-quota}:${bucket}:v${policy.version}:${hash(rateLimitSubjectKey(policy, { ip }))}:60`;
      }),
      `${prefix}:preflight`,
      `${prefix}:preflight-ip:${hash(`recognition.preflight-ip:${ip}`)}`,
      `${prefix}:key:${digest}`,
      ...(replay
        ? [`${namespace}:{partner-quota}:gateway-replay:${replay}`]
        : []),
    ]);
    assert.ok(
      keys.every((key) => key.includes("{partner-quota}")),
      "all actual Redis keys share the existing cluster slot",
    );
    assert.equal(command.length, 3 + numkeys + 7);
    assert.ok(
      command
        .slice(3 + numkeys)
        .every((arg) => !arg.includes("{partner-quota}")),
      "key names are not hidden in ARGV",
    );
  }
});
