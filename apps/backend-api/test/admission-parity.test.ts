import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GatewayReplayError } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import {
  INTERNAL_READ_PREFIX,
  signGatewayRequest,
} from "@blast/core/modules/backend-api/gateway.ts";
import { partnerCapacity } from "@blast/server/modules/partner-api-keys/capacity.ts";
import type {
  PartnerGrant,
  PartnerKeyPolicy,
} from "@blast/server/modules/partner-api-keys/contracts.ts";
import {
  PartnerRecognitionStore,
  type RecognitionDecision,
} from "@blast/server/modules/partner-api-keys/recognition-store.ts";
import type { PartnerRecognition } from "@blast/server/modules/partner-api-keys/recognition.ts";
import type { PartnerV1Handlers } from "@blast/server/modules/partner-api/v1/route.ts";
import { createBackendApi } from "../src/app/api/routing.ts";
import { createBackendServer } from "../src/app/server.ts";
import { capacityFixture } from "./capacity-fixture.ts";

/**
 * #452 parity fixture: what today's admission sends to the quota Redis and answers, for every
 * route family, tier and refusal, through the real transport. A change to admission must
 * reproduce `fixtures/admission-parity.json` exactly: the same keys, windows, limits and scopes
 * in the same order, one quota call per admitted request, the same statuses and codes, and no
 * handler run for a refusal. Record it again only for an intended change, with
 * `UPDATE_ADMISSION_PARITY=1`, and review the diff.
 *
 * Redis owns the clock, so quota keys and arguments are deterministic; only the gateway nonce is
 * random and is normalized. Partner classification is scripted: its own Redis traffic (where a
 * partner read claims its nonce) belongs to the recognition store, so what admission hands to
 * `classify` is recorded instead. Limits such as 8015900 and 4000000 come from `capacityFixture`,
 * not production capacity.
 */
const FIXTURE = new URL("./fixtures/admission-parity.json", import.meta.url);
const NAMESPACE = "a".repeat(64);
const SECRET = "s".repeat(32);
const PEPPER = "p".repeat(32);
const PRESALE = `0x${"1".repeat(64)}`;
const COIN = `0x${"3".repeat(64)}::froggy::FROGGY`;
const key = (letter: string) => `blast_pk_${letter.repeat(43)}`;
const KEYS = {
  standard: key("a"),
  custom: key("b"),
  internal: key("c"),
  revoked: key("d"),
  unknown: key("e"),
};
const GRANTS: Record<string, PartnerGrant> = {
  standard: grant("acme", "11111111-1111-4111-8111-111111111111", { tier: "standard" }),
  custom: grant("acme", "22222222-2222-4222-8222-222222222222", {
    tier: "custom",
    requestsPerMinute: 10,
    requestsPerDay: 40,
  }),
  internal: grant("blast", "33333333-3333-4333-8333-333333333333", { tier: "internal" }),
};

function grant(id: string, keyId: string, policy: PartnerKeyPolicy): PartnerGrant {
  return { id, keyId, origins: ["https://partner.example"], policy };
}

/** A scripted quota reply: allow, refuse the first or the last (operational) scope, replay, or lose the answer. */
type Reply = "allow" | "refuse-first" | "refuse-last" | "replay" | "lost";

class ScriptedRedis {
  calls: string[][] = [];
  replies: Reply[] = [];
  connectionEpoch() {
    return 0;
  }
  async executeAtEpoch(command: string[]) {
    return this.execute(command);
  }
  async execute(command: string[]): Promise<unknown> {
    this.calls.push(command);
    // Anything but the quota script is recorded for the fixture to show, never answered.
    if (command[0] !== "EVALSHA") {
      return null;
    }
    const reply = this.replies.shift() ?? "allow";
    if (reply === "lost") {
      throw new Error("Synthetic lost Redis acknowledgement.");
    }
    if (reply === "replay") {
      return [2, 0, 0];
    }
    if (reply === "allow") {
      return [1, 0, 0];
    }
    // Arguments after the keys: the nonce flag, then (windowSeconds, limit, scope) per window.
    const keyCount = Number(command[2]);
    const windows = command.slice(3 + keyCount + 1);
    const scopes = windows.filter((_, index) => index % 3 === 2).map(Number);
    return reply === "refuse-first" ? [0, 30, 1] : [0, 5, Math.max(...scopes)];
  }
}

type Scenario = Readonly<{
  name: string;
  path: string;
  method?: string;
  partnerKey?: string;
  origin?: string;
  unsigned?: boolean;
  ip: string;
  replies?: readonly Reply[];
  /** Send the same signed request again: the second must be refused as a replay. */
  repeat?: boolean;
  classify?: RecognitionDecision;
  /** `classify` fails: the gateway proof was already used, or recognition is unavailable. */
  classifyFails?: "replay" | "unavailable";
  grant?: PartnerGrant | null;
}>;

const known = (tenant: string, keyId: string): RecognitionDecision => ({
  kind: "known",
  identity: { tenant, keyId },
});
const READ = `${INTERNAL_READ_PREFIX}/api/v1`;
/** One read per endpoint bucket (`partnerEndpointBucket`), for both callers. */
const BUCKET_READS = [
  "/presales",
  "/presales/featured",
  `/presales/${PRESALE}`,
  "/prices",
  "/discovery",
  "/search",
  `/wallets/${PRESALE}/launches`,
  "/market/status",
  `/market/coins/${COIN}`,
  `/market/coins/${COIN}/holders`,
  `/market/coins/${COIN}/candles`,
  `/market/launches/${PRESALE}/activity`,
  `/market/pools/blast_curve/${PRESALE}`,
  `/market/pools/cetus/${PRESALE}/trades`,
  "/defillama/metrics",
];
const STANDARD = {
  partnerKey: KEYS.standard,
  classify: known("acme", GRANTS.standard!.keyId),
  grant: GRANTS.standard,
};
const SCENARIOS: readonly Scenario[] = [
  ...BUCKET_READS.map(
    (path): Scenario => ({
      name: `first-party ${path}`,
      path: `${READ}${path}`,
      ip: "198.51.100.1",
    }),
  ),
  { name: "first-party HEAD", path: `${READ}/presales`, method: "HEAD", ip: "198.51.100.2" },
  {
    name: "first-party OPTIONS refused",
    path: `${READ}/presales`,
    method: "OPTIONS",
    ip: "198.51.100.2",
  },
  {
    name: "first-party POST refused",
    path: `${READ}/presales`,
    method: "POST",
    ip: "198.51.100.2",
  },
  { name: "first-party unknown path refused", path: `${READ}/nothing`, ip: "198.51.100.2" },
  {
    name: "first-party allowlist proof refused",
    path: `${READ}/presales/${PRESALE}/proof?wallet=${PRESALE}`,
    ip: "198.51.100.2",
  },
  {
    name: "first-party partner key refused",
    path: `${READ}/presales`,
    partnerKey: KEYS.standard,
    ip: "198.51.100.2",
  },
  {
    name: "first-party quota refused",
    path: `${READ}/prices`,
    ip: "198.51.100.3",
    replies: ["refuse-first"],
  },
  {
    name: "first-party replayed proof",
    path: `${READ}/prices`,
    ip: "198.51.100.4",
    repeat: true,
    replies: ["allow", "replay"],
  },
  {
    name: "first-party lost quota answer",
    path: `${READ}/prices`,
    ip: "198.51.100.5",
    replies: ["lost"],
  },
  {
    name: "first-party unsigned refused",
    path: `${READ}/prices`,
    ip: "198.51.100.6",
    unsigned: true,
  },
  ...BUCKET_READS.map(
    (path): Scenario => ({
      name: `partner ${path}`,
      path: `/api/v1${path}`,
      ip: "203.0.113.1",
      ...STANDARD,
    }),
  ),
  {
    name: "partner allowlist proof",
    path: `/api/v1/presales/${PRESALE}/proof?wallet=${PRESALE}`,
    ip: "203.0.113.1",
    ...STANDARD,
  },
  {
    name: "partner custom 40/day",
    path: "/api/v1/presales",
    partnerKey: KEYS.custom,
    ip: "203.0.113.1",
    classify: known("acme", GRANTS.custom!.keyId),
    grant: GRANTS.custom,
  },
  {
    name: "partner internal",
    path: "/api/v1/presales",
    partnerKey: KEYS.internal,
    ip: "203.0.113.1",
    classify: known("blast", GRANTS.internal!.keyId),
    grant: GRANTS.internal,
  },
  {
    name: "partner HEAD",
    path: "/api/v1/presales",
    method: "HEAD",
    ip: "203.0.113.1",
    ...STANDARD,
  },
  {
    name: "partner GET from an enabled origin",
    path: "/api/v1/presales",
    origin: "https://partner.example",
    ip: "203.0.113.1",
    ...STANDARD,
  },
  {
    name: "partner GET from another origin",
    path: "/api/v1/presales",
    origin: "https://other.example",
    ip: "203.0.113.1",
    ...STANDARD,
  },
  {
    name: "partner malformed key",
    path: "/api/v1/presales",
    partnerKey: "malformed",
    ip: "203.0.113.2",
  },
  {
    name: "partner unknown key",
    path: "/api/v1/presales",
    partnerKey: KEYS.unknown,
    ip: "203.0.113.2",
    classify: { kind: "unknown" },
  },
  {
    name: "partner over its key limit",
    path: "/api/v1/presales",
    partnerKey: KEYS.standard,
    ip: "203.0.113.2",
    classify: { kind: "limited", limit: "key", retryAfter: 7 },
  },
  {
    name: "partner preflight reserve full",
    path: "/api/v1/presales",
    method: "OPTIONS",
    origin: "https://partner.example",
    ip: "203.0.113.2",
    classify: { kind: "limited", limit: "preflight", retryAfter: 3 },
  },
  {
    name: "partner revoked key",
    path: "/api/v1/presales",
    partnerKey: KEYS.revoked,
    ip: "203.0.113.2",
    classify: known("acme", "44444444-4444-4444-8444-444444444444"),
    grant: null,
  },
  {
    name: "partner grant disagrees with recognition",
    path: "/api/v1/presales",
    partnerKey: KEYS.standard,
    ip: "203.0.113.2",
    classify: known("acme", GRANTS.custom!.keyId),
    grant: GRANTS.standard,
  },
  {
    name: "partner proof already used",
    path: "/api/v1/presales",
    partnerKey: KEYS.standard,
    ip: "203.0.113.2",
    classifyFails: "replay",
  },
  {
    name: "partner recognition unavailable",
    path: "/api/v1/presales",
    partnerKey: KEYS.standard,
    ip: "203.0.113.2",
    classifyFails: "unavailable",
  },
  {
    name: "partner commercial quota refused",
    path: "/api/v1/prices",
    partnerKey: KEYS.custom,
    ip: "203.0.113.3",
    classify: known("acme", GRANTS.custom!.keyId),
    grant: GRANTS.custom,
    replies: ["refuse-first"],
  },
  {
    name: "partner operational window refused",
    path: "/api/v1/prices",
    ip: "203.0.113.3",
    ...STANDARD,
    replies: ["refuse-last"],
  },
  {
    name: "partner internal operational window refused",
    path: "/api/v1/prices",
    partnerKey: KEYS.internal,
    ip: "203.0.113.3",
    classify: known("blast", GRANTS.internal!.keyId),
    grant: GRANTS.internal,
    replies: ["refuse-last"],
  },
  {
    name: "partner lost quota answer",
    path: "/api/v1/prices",
    ip: "203.0.113.4",
    ...STANDARD,
    replies: ["lost"],
  },
  {
    name: "partner preflight",
    path: "/api/v1/presales",
    method: "OPTIONS",
    origin: "https://partner.example",
    ip: "203.0.113.5",
    classify: { kind: "origin" },
  },
  {
    name: "partner unknown path",
    path: "/api/v1/nothing",
    partnerKey: KEYS.standard,
    ip: "203.0.113.5",
  },
  {
    name: "partner POST",
    path: "/api/v1/presales",
    method: "POST",
    partnerKey: KEYS.standard,
    ip: "203.0.113.5",
  },
];

type Recorded = Readonly<{
  name: string;
  responses: readonly Readonly<{
    status: number;
    code: string | null;
    message?: string;
    retryAfter: string | null;
  }>[];
  handlerRuns: number;
  /** What admission handed to recognition: the seam where a partner read claims its nonce. */
  recognition: readonly Readonly<Record<string, string>>[];
  invalidated: number;
  redis: readonly Readonly<
    { keys: readonly string[]; arguments: readonly string[] } | { other: readonly string[] }
  >[];
}>;

/** The scenario's request through the transport, signed by the gateway unless it is direct. */
function signedRequest(current: Scenario, port: number) {
  const target = new Request(`http://127.0.0.1:${port}${current.path}`, {
    method: current.method ?? "GET",
    headers: {
      ...(current.partnerKey ? { "x-blast-partner-key": current.partnerKey } : {}),
      ...(current.origin ? { origin: current.origin } : {}),
      ...(current.origin && current.method === "OPTIONS"
        ? {
            "access-control-request-method": "GET",
            "access-control-request-headers": "x-blast-partner-key",
          }
        : {}),
    },
  });
  const headers = new Headers(target.headers);
  if (!current.unsigned) {
    for (const [name, value] of signGatewayRequest(target, SECRET, current.ip, NAMESPACE)) {
      headers.set(name, value);
    }
  }
  return { url: target.url, init: { method: target.method, headers } };
}

async function recordedAnswer(answer: Response): Promise<Recorded["responses"][number]> {
  const text = await answer.text();
  let error: { code?: string; message?: string } | undefined;
  try {
    error = (JSON.parse(text) as { error?: typeof error }).error;
  } catch {}
  return {
    status: answer.status,
    code: error?.code ?? null,
    ...(error?.message ? { message: error.message } : {}),
    retryAfter: answer.headers.get("retry-after"),
  };
}

/** A quota script call's ordered KEYS and ARGV, with the random gateway nonce normalized. */
function recordedCall(command: string[]): Recorded["redis"][number] {
  if (command[0] !== "EVALSHA") {
    return { other: command };
  }
  const keyCount = Number(command[2]);
  return {
    keys: command
      .slice(3, 3 + keyCount)
      .map((value) => value.replace(/gateway-replay:[A-Za-z0-9_-]{32}$/, "gateway-replay:<nonce>")),
    arguments: command.slice(3 + keyCount),
  };
}

async function record(): Promise<Recorded[]> {
  const redis = new ScriptedRedis();
  const capacity = partnerCapacity(capacityFixture(["acme", "blast"]));
  const store = new PartnerRecognitionStore(redis, NAMESPACE, PEPPER, capacity);
  let scenario: Scenario = SCENARIOS[0]!;
  let classified: Record<string, string>[] = [];
  let invalidated = 0;
  const recognition = {
    store,
    async classify(
      input: Readonly<{ digest: string; origin?: string; ip: string; nonce?: string }>,
    ) {
      classified.push({
        digest: input.digest,
        ...(input.origin === undefined ? {} : { origin: input.origin }),
        ip: input.ip,
        nonce: input.nonce === undefined ? "absent" : "<nonce>",
      });
      if (scenario.classifyFails === "replay") {
        throw new GatewayReplayError();
      }
      if (scenario.classifyFails === "unavailable") {
        throw new Error("Synthetic recognition failure.");
      }
      return scenario.classify ?? { kind: "unknown" };
    },
    responseWindow: (input: { tenant: string; internal: boolean }) =>
      store.responseWindow(input, 0),
    invalidate() {
      invalidated++;
    },
  } as unknown as PartnerRecognition;
  let handlerRuns = 0;
  const read = async () => {
    handlerRuns++;
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
    wallet_launches: read,
    presale_proof: read,
    coin_metadata: read,
  };
  const handle = createBackendApi({
    redis,
    namespace: NAMESPACE,
    subjectPepper: PEPPER,
    handlers: () => handlers,
    recognition,
    keys: {
      async verify() {
        return scenario.grant ?? null;
      },
      async allowsOrigin() {
        return false;
      },
    },
  });
  const runtime = createBackendServer({
    handle,
    preparePartner: handle.preparePartner,
    redis,
    namespace: NAMESPACE,
    gatewaySecret: SECRET,
    ready: async () => true,
  });
  try {
    const recorded: Recorded[] = [];
    for (const current of SCENARIOS) {
      scenario = current;
      redis.calls = [];
      redis.replies = [...(current.replies ?? [])];
      handlerRuns = 0;
      classified = [];
      invalidated = 0;
      const { url, init } = signedRequest(current, runtime.server.port!);
      const responses = [];
      for (let attempt = 0; attempt < (current.repeat ? 2 : 1); attempt++) {
        responses.push(await recordedAnswer(await fetch(url, init)));
      }
      recorded.push({
        name: current.name,
        responses,
        handlerRuns,
        recognition: classified,
        invalidated,
        redis: redis.calls.map(recordedCall),
      });
    }
    return recorded;
  } finally {
    await runtime.drain();
  }
}

test("#452: admission sends the recorded quota calls and answers for every route family, tier and refusal", async () => {
  const first = await record();
  assert.deepEqual(await record(), first, "admission is reproducible");
  for (const scenario of first) {
    const admitted = scenario.responses.filter(({ status }) => status < 400).length;
    assert.ok(scenario.handlerRuns <= admitted, `${scenario.name}: a refusal never runs a handler`);
  }
  if (process.env.UPDATE_ADMISSION_PARITY === "1") {
    // Written as the style check expects, so a re-recording diff shows only recorded changes.
    const prettier = await import("prettier");
    const path = fileURLToPath(FIXTURE);
    const options = await prettier.resolveConfig(path);
    writeFileSync(
      path,
      await prettier.format(JSON.stringify(first), { ...options, filepath: path }),
    );
  }
  assert.deepEqual(first, JSON.parse(readFileSync(FIXTURE, "utf8")));
});
