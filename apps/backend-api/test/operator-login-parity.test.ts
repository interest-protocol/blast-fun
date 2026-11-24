import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { RateLimitPort } from "@blast/core/lib/web-security/rate-limits.ts";
import { signGatewayRequest } from "@blast/core/modules/backend-api/gateway.ts";
import type { PartnerV1Handlers } from "@blast/server/modules/partner-api/v1/route.ts";
import { createBackendApi } from "../src/app/api/routing.ts";
import { createBackendOperators } from "../src/app/api/operators.ts";
import { createBackendServer } from "../src/app/server.ts";

/**
 * #452 PR C fixture: what operator login admission sends to the quota Redis and answers, through
 * the real transport and the production operator wiring (`createBackendOperators` behind
 * `createBackendApi`). A change to how login admission is composed must reproduce
 * `fixtures/operator-login-parity.json` exactly: the same keys, windows, limits and scopes in one
 * quota call per counted attempt, and the same statuses, bodies and `Retry-After`. Record it again
 * only for an intended change, with `UPDATE_OPERATOR_LOGIN_PARITY=1`, and review the diff.
 */
const FIXTURE = new URL("./fixtures/operator-login-parity.json", import.meta.url);
const NAMESPACE = "a".repeat(64);
const GATEWAY_SECRET = "s".repeat(32);
const PEPPER = "p".repeat(32);
const ADMISSION_TOKEN = "synthetic-login-admission-token-0123456789";
const OPERATOR_TOKEN = "synthetic-operator-token-0123456789-abcdefgh";
const PATH = "/api/admin/login-admission";

/** A scripted quota reply: allow, refuse the IP or the global scope, or lose the answer. */
type Reply = "allow" | "refuse-ip" | "refuse-global" | "lost";

class ScriptedRedis {
  calls: string[][] = [];
  replies: Reply[] = [];
  async execute(command: string[]): Promise<unknown> {
    this.calls.push(command);
    if (command[0] !== "EVALSHA") {
      return null;
    }
    const reply = this.replies.shift() ?? "allow";
    if (reply === "lost") {
      throw new Error("Synthetic lost Redis acknowledgement.");
    }
    return reply === "allow" ? [1, 0, 0] : reply === "refuse-ip" ? [0, 30, 1] : [0, 7, 2];
  }
}

type Scenario = Readonly<{
  name: string;
  method?: string;
  path?: string;
  token?: string | null;
  contentType?: string;
  body?: string;
  headers?: Readonly<Record<string, string>>;
  /** Carry a gateway proof: the transport refuses admin requests that do. */
  signed?: boolean;
  replies?: readonly Reply[];
}>;

const address = (clientAddress: string) => JSON.stringify({ clientAddress });
const SCENARIOS: readonly Scenario[] = [
  { name: "admitted IPv4", body: address("192.0.2.1") },
  { name: "admitted IPv6 counts its /64", body: address("2001:db8:1:2::7") },
  { name: "IPv4-mapped IPv6 is not canonical", body: address("::ffff:c000:201") },
  { name: "compatible dotted IPv6 is not canonical", body: address("::192.0.2.1") },
  { name: "compatible hex IPv6 retains its network", body: address("::c000:201") },
  { name: "loopback IPv6 retains its network", body: address("::1") },
  { name: "uppercase IPv6 is not canonical", body: address("2001:DB8::1") },
  { name: "zone identifier refused", body: address("fe80::1%eth0") },
  { name: "forwarded chain refused", body: address("192.0.2.1,198.51.100.1") },
  { name: "IP budget refused", body: address("192.0.2.2"), replies: ["refuse-ip"] },
  { name: "global budget refused", body: address("192.0.2.3"), replies: ["refuse-global"] },
  { name: "lost quota answer", body: address("192.0.2.4"), replies: ["lost"] },
  {
    name: "operator token is not the admission token",
    token: OPERATOR_TOKEN,
    body: address("192.0.2.5"),
  },
  { name: "no credential", token: null, body: address("192.0.2.5") },
  { name: "GET refused", method: "GET", body: undefined },
  { name: "query string refused", path: `${PATH}?x=1`, body: address("192.0.2.6") },
  {
    name: "origin refused",
    headers: { origin: "https://admin.example" },
    body: address("192.0.2.6"),
  },
  {
    name: "partner key refused",
    headers: { "x-blast-partner-key": "blast_pk_" + "a".repeat(43) },
    body: address("192.0.2.6"),
  },
  { name: "gateway proof refused", signed: true, body: address("192.0.2.6") },
  { name: "wrong content type", contentType: "text/plain", body: address("192.0.2.6") },
  { name: "invalid body", body: '{"clientAddress":"192.0.2.6","extra":1}' },
  { name: "not an address", body: address("not-an-address") },
];

type Recorded = Readonly<{
  name: string;
  status: number;
  body: string;
  retryAfter: string | null;
  redis: readonly Readonly<
    { keys: readonly string[]; arguments: readonly string[] } | { other: readonly string[] }
  >[];
}>;

function request(scenario: Scenario, port: number) {
  const method = scenario.method ?? "POST";
  const headers = new Headers({
    ...(scenario.token === null
      ? {}
      : { authorization: `Bearer ${scenario.token ?? ADMISSION_TOKEN}` }),
    ...(scenario.body === undefined
      ? {}
      : { "content-type": scenario.contentType ?? "application/json" }),
    ...scenario.headers,
  });
  const target = new Request(`http://127.0.0.1:${port}${scenario.path ?? PATH}`, {
    method,
    headers,
  });
  if (scenario.signed) {
    for (const [name, value] of signGatewayRequest(
      target,
      GATEWAY_SECRET,
      "192.0.2.9",
      NAMESPACE,
    )) {
      headers.set(name, value);
    }
  }
  return { url: target.url, init: { method, headers, body: scenario.body } };
}

function recordedCall(command: string[]): Recorded["redis"][number] {
  if (command[0] !== "EVALSHA") {
    return { other: command };
  }
  const keyCount = Number(command[2]);
  return { keys: command.slice(3, 3 + keyCount), arguments: command.slice(3 + keyCount) };
}

const handlers = (): PartnerV1Handlers => {
  const read = async () => assert.fail("Login admission never runs a read handler.");
  return {
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
  };
};

async function record(): Promise<Recorded[]> {
  const redis = new ScriptedRedis();
  const handle = createBackendApi({
    redis,
    namespace: NAMESPACE,
    subjectPepper: PEPPER,
    handlers,
    keys: {
      verify: async () => assert.fail("Login admission never verifies partner keys."),
      allowsOrigin: async () => false,
    },
    operators: ({ login }) =>
      createBackendOperators(
        { loginAdmissionToken: ADMISSION_TOKEN, gasPool: null, localRun: false },
        login,
      ),
  });
  const runtime = createBackendServer({
    handle,
    redis,
    namespace: NAMESPACE,
    gatewaySecret: GATEWAY_SECRET,
    ready: async () => true,
  });
  try {
    const recorded: Recorded[] = [];
    for (const scenario of SCENARIOS) {
      redis.calls = [];
      redis.replies = [...(scenario.replies ?? [])];
      const { url, init } = request(scenario, runtime.server.port!);
      const answer = await fetch(url, init);
      recorded.push({
        name: scenario.name,
        status: answer.status,
        body: (await answer.text()).replace(/"requestId":"[^"]+"/, '"requestId":"<id>"'),
        retryAfter: answer.headers.get("retry-after"),
        redis: redis.calls.map(recordedCall),
      });
    }
    return recorded;
  } finally {
    await runtime.drain();
    await handle.dispose();
  }
}

test("#452: operator login admission sends the recorded quota calls and answers", async () => {
  const first = await record();
  assert.deepEqual(await record(), first, "login admission is reproducible");
  for (const scenario of first) {
    const quotaCalls = scenario.redis.filter((call) => "keys" in call).length;
    assert.ok(quotaCalls <= 1, `${scenario.name}: at most one quota call per attempt`);
  }
  if (process.env.UPDATE_OPERATOR_LOGIN_PARITY === "1") {
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

test("the operator login quota spends only the login budgets", async () => {
  const redis = new ScriptedRedis();
  let login: RateLimitPort | undefined;
  createBackendApi({
    redis,
    namespace: NAMESPACE,
    subjectPepper: PEPPER,
    handlers,
    keys: { verify: async () => null, allowsOrigin: async () => false },
    operators: (quota) => {
      login = quota.login;
      return async () => null;
    },
  });
  await assert.rejects(
    login!.consumeAll!(["admin_login_ip", "partner_read"], { ip: "192.0.2.1" }),
    TypeError,
  );
  assert.deepEqual(redis.calls, [], "A refused bucket set reaches no Redis.");
  assert.equal(
    (await login!.consumeAll!(["admin_login_ip", "admin_login_global"], { ip: "192.0.2.1" }))
      .allowed,
    true,
  );
  assert.equal(redis.calls.length, 1);
});
