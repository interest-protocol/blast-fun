import assert from "node:assert/strict";
import test from "node:test";
import { CRON_ROUTES } from "@blast/core/modules/backend-api/cron-routes.ts";
import {
  OPERATOR_COIN_SEGMENT_LIMIT,
  OPERATOR_METHODS,
  OPERATOR_ROUTES,
  type OperatorRouteId,
} from "@blast/core/modules/backend-api/operator-routes.ts";
import { createOperatorRoutes } from "@blast/server/operators/routes.ts";
import { createOperatorHttp } from "../src/app/api/operators.ts";
import { createBackendHttp, createBackendServer } from "../src/app/server.ts";

const ADMIN_TOKEN = "synthetic-operator-admin-token-0123456789";
const CRON_SECRET = "synthetic-cron-secret-token-0123456789ab";
const LOGIN_ADMISSION_TOKEN = "synthetic-login-admission-token-01234567";

type Secrets = Readonly<{ adminToken?: string; cronSecret?: string }>;

function fixture(secrets: Secrets) {
  const reached: string[] = [];
  const http = createBackendHttp({
    gatewaySecret: "synthetic-gateway-secret-0123456789",
    namespace: "route-auth-fixture",
    redis: {
      execute: async () => {
        throw new Error("Route auth must not reach Redis");
      },
    },
    ready: async () => true,
    ...secrets,
    handle: async (request) => {
      reached.push(new URL(request.url).pathname);
      return new Response(null, { status: 204 });
    },
    cronApi: {
      handle: async (request) => {
        reached.push(new URL(request.url).pathname);
        return new Response(null, { status: 204 });
      },
    },
  });
  return { http, reached };
}

const operatorCalls = OPERATOR_ROUTES.flatMap((route) =>
  route.methods.map((method) => ({
    path: route.path.replace(/:\w+/g, "0xabc"),
    method,
    auth: route.auth,
    bearer: ADMIN_TOKEN,
  })),
);
const cronCalls = CRON_ROUTES.flatMap((path) =>
  ["GET", "HEAD"].map((method) => ({ path, method, auth: "cron", bearer: CRON_SECRET })),
);
const guarded = [...operatorCalls.filter((call) => call.auth === "operator"), ...cronCalls];

test("only login admission skips the operator bearer, and every admin console path is an operator row", () => {
  assert.deepEqual(
    OPERATOR_ROUTES.filter((route) => route.auth !== "operator").map((route) => route.id),
    ["login-admission"],
  );
  assert.deepEqual(
    OPERATOR_ROUTES.filter((route) => route.auth === "operator")
      .map((route) => route.path)
      .sort(),
    [
      "/api/admin/bonding-feature",
      "/api/admin/coins/:coin_type/reward-blacklist",
      "/api/admin/gas-pool/health",
      "/api/admin/partner-keys",
      "/api/admin/presales",
      "/api/admin/reward-coins",
      "/api/admin/verified-mark",
    ],
  );
});

async function send(
  http: ReturnType<typeof fixture>["http"],
  call: Readonly<{ path: string; method: string }>,
  headers: Record<string, string>,
) {
  const response = await http.fetch(
    new Request(`http://backend.test${call.path}`, { method: call.method, headers }),
    "127.0.0.1",
  );
  await response.text();
  return response.status;
}

test("every operator and cron route refuses before its owner unless the request carries that route's bearer", async () => {
  const { http, reached } = fixture({ adminToken: ADMIN_TOKEN, cronSecret: CRON_SECRET });
  try {
    for (const call of guarded) {
      const other = call.bearer === ADMIN_TOKEN ? CRON_SECRET : ADMIN_TOKEN;
      const refused: Record<string, string>[] = [
        {},
        { authorization: "Bearer wrong-token-wrong-token-wrong-token" },
        { authorization: `Bearer ${other}` },
        { authorization: `Bearer ${LOGIN_ADMISSION_TOKEN}` },
        {
          authorization: call.bearer,
          cookie: "__Host-blast_session=s",
          "x-blast-partner-key": "partner",
        },
      ];
      for (const headers of refused) {
        assert.equal(
          await send(http, call, headers),
          401,
          `${call.method} ${call.path} ${JSON.stringify(headers)}`,
        );
      }
      assert.deepEqual(
        reached,
        [],
        `${call.method} ${call.path} reached its owner without its bearer`,
      );
      assert.equal(
        await send(http, call, { authorization: `Bearer ${call.bearer}` }),
        204,
        `${call.method} ${call.path}`,
      );
      reached.length = 0;
    }
    for (const call of operatorCalls.filter((entry) => entry.auth === "login-admission")) {
      assert.equal(await send(http, call, {}), 204, "login admission checks its own credential");
    }
    reached.length = 0;
    const operator = { authorization: `Bearer ${ADMIN_TOKEN}` };
    for (const path of ["/api/admin", "/api/admin/x", "/api/admin/partner-keys/x"]) {
      assert.equal(await send(http, { path, method: "GET" }, operator), 404, path);
    }
    assert.equal(
      await send(http, { path: "/api/admin/partner-keys", method: "DELETE" }, operator),
      405,
    );
    assert.deepEqual(reached, [], "unknown operator paths and methods never reach an owner");
  } finally {
    await http.drain();
  }
});

test("a missing or short configured secret refuses even a request bearing it", async () => {
  for (const secret of [undefined, "short-secret"]) {
    const { http, reached } = fixture({ adminToken: secret, cronSecret: secret });
    try {
      for (const call of guarded) {
        assert.equal(
          await send(http, call, { authorization: `Bearer ${secret}` }),
          401,
          `${secret} ${call.path}`,
        );
      }
      assert.deepEqual(reached, []);
    } finally {
      await http.drain();
    }
  }
});

test("Effect dispatch preserves native operator methods, raw coin targets and request bytes", async () => {
  const owners = Object.fromEntries(
    OPERATOR_ROUTES.map(({ id, methods }) => [
      id,
      async (request: Request) => {
        const url = new URL(request.url);
        if (url.searchParams.get("fixture") === "throw") {
          throw new Error("synthetic private diagnostic");
        }
        return Response.json(
          {
            id,
            url: url.pathname + url.search,
            bytes: Buffer.from(await request.arrayBuffer()).toString("hex"),
          },
          {
            status: methods.some((method) => method === request.method) ? 200 : 405,
            headers: [
              ["Cache-Control", "no-store"],
              ["Set-Cookie", "sample=first"],
              ["Set-Cookie", "sample=second"],
            ],
          },
        );
      },
    ]),
  ) as Record<OperatorRouteId, (request: Request) => Promise<Response>>;
  const legacy = createOperatorRoutes(owners);
  const http = createOperatorHttp(owners);
  const native = createBackendServer({
    gatewaySecret: "synthetic-gateway-secret-0123456789",
    namespace: "operator-effect-parity",
    adminToken: ADMIN_TOKEN,
    redis: { execute: async () => assert.fail("Operator fixture must not use Redis.") },
    ready: async () => true,
    handle: http,
  });
  try {
    const paths = OPERATOR_ROUTES.map(({ path }) => path.replace(":coin_type", "0xabc"));
    const rawCases = [
      "%",
      "%ff",
      "%2f",
      "fixture;tag",
      "%aa".repeat(OPERATOR_COIN_SEGMENT_LIMIT / 3),
    ].map((segment) => `/api/admin/coins/${segment}/reward-blacklist`);
    for (const path of [...paths, ...rawCases]) {
      for (const method of OPERATOR_METHODS) {
        const url = `http://127.0.0.1:${native.server.port}${path}?tag=%ff&tag=a+b`;
        const init = {
          method,
          headers: {
            Authorization: `Bearer ${ADMIN_TOKEN}`,
            "Content-Type": "application/octet-stream",
          },
          body: method === "GET" ? undefined : new Uint8Array([0x00, 0xff, 0x41]),
        };
        const expected = await legacy(new Request(url, init));
        assert.ok(expected);
        const actual = await fetch(url, init);
        const label = `${method} ${path.slice(0, 70)}`;
        assert.equal(actual.status, expected.status, label);
        assert.equal(await actual.text(), await expected.text(), label);
        assert.equal(actual.headers.get("cache-control"), "no-store", label);
        assert.deepEqual(actual.headers.getSetCookie(), expected.headers.getSetCookie(), label);
      }
    }
    const failed = await fetch(
      `http://127.0.0.1:${native.server.port}/api/admin/partner-keys?fixture=throw`,
      { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } },
    );
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get("retry-after"), "5");
    assert.deepEqual(await failed.json(), { error: { code: "service_unavailable" } });
  } finally {
    await native.drain();
    await http.dispose();
  }
});
