import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import test from "node:test";
import { signPrivateRequest } from "@blast/core/modules/backend-api/private-gateway.ts";
import { quotaNamespace } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { fleetFixture } from "./fleet-fixture.ts";
import { hintsConfig } from "../src/app/hints/config.ts";
import { createHintsServer } from "../src/app/hints/server.ts";
import { createBackendServer } from "../src/app/server.ts";

const environment = {
  NODE_ENV: "production",
  BLAST_DEPLOYMENT_TARGET: "production",
  BLAST_REDIS_NAMESPACE: "mainnet:hints:test",
  BLAST_BACKEND_INGRESS_MODE: "direct",
  BLAST_QUOTA_REDIS_URL: "redis://127.0.0.1:6379",
  RATE_LIMIT_SUBJECT_PEPPER: "p".repeat(32),
  BLAST_BACKEND_HINTS_GATEWAY_SECRET: "h".repeat(32),
  BLAST_INFRA_ORIGIN: "https://infra.test",
  BLAST_INFRA_READ_MODE: "committed-markets",
  BLAST_INFRA_READ_ORIGIN: "https://reader.test",
  BLAST_INFRA_API_KEY: "i".repeat(32),
  BLAST_BACKEND_FLEET_CONFIG: JSON.stringify({
    ...fleetFixture(),
    visibleSubscribedTabs: 100,
    hints: { replicas: 2, maxHintStreams: 200 },
    utilizationPercent: 100,
  }),
  NEXT_PUBLIC_SITE_URL: "https://frontend.test",
};
const configured = {
  ...environment,
  BLAST_BACKEND_EXPECTED_QUOTA_NAMESPACE: quotaNamespace(
    environment.BLAST_REDIS_NAMESPACE,
    deploymentIdentity(environment),
  ),
};

test("both native services serve the liveness response without calling dependencies", async () => {
  const config = hintsConfig(configured);
  let dependencyCalls = 0;
  const unused = async () => {
    dependencyCalls++;
    assert.fail("Liveness must not reach readiness, Redis or a feature handler.");
  };
  const redis = { execute: unused, close() {} };
  const services = {
    api: () => createBackendServer({ ...config, redis, handle: unused, ready: unused }),
    hints: () => createHintsServer(config, redis, redis),
  };
  for (const [service, start] of Object.entries(services)) {
    const runtime = start();
    const liveUrl = `http://127.0.0.1:${runtime.server.port}/v1/live`;
    try {
      for (const [method, query, body, contentType] of [
        ["GET", "", "live", "application/octet-stream"],
        ["HEAD", "", "", null],
        ["OPTIONS", "?probe=1", "live", "application/octet-stream"],
      ] as const) {
        const response = await fetch(liveUrl + query, { method });
        assert.equal(response.status, 200, `${service} ${method}`);
        assert.equal(response.headers.get("content-length"), "4");
        assert.equal(response.headers.get("content-type"), contentType);
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        assert.match(response.headers.get("x-request-id") ?? "", /^[\da-f-]{36}$/);
        assert.equal(await response.text(), body);
      }

      const write = await fetch(liveUrl, { method: "POST" });
      assert.equal(write.status, 405);
      assert.deepEqual(await write.json(), { error: { code: "read_only" } });
      const privateProof = await fetch(liveUrl, { headers: { "x-blast-private-proof": "test" } });
      assert.equal(privateProof.status, 403);
      assert.deepEqual(await privateProof.json(), { error: { code: "private_gateway_forbidden" } });
      assert.equal(dependencyCalls, 0, service);
    } finally {
      await runtime.drain();
    }
  }
});

test("hints profile needs no SQL or partner settings and retains identity and credential isolation", () => {
  const config = hintsConfig(configured);
  assert.equal(
    config.namespace,
    quotaNamespace(configured.BLAST_REDIS_NAMESPACE, deploymentIdentity(configured)),
  );
  assert.equal(config.gatewaySecret, environment.BLAST_BACKEND_HINTS_GATEWAY_SECRET);
  assert.equal(config.maxHintStreams, 200);
  assert.equal(config.siteOrigin, "https://frontend.test");
  assert.throws(() => hintsConfig(environment), /quota identity/);
  assert.throws(
    () =>
      hintsConfig({
        ...configured,
        BLAST_BACKEND_HINTS_GATEWAY_SECRET: "h".repeat(31),
      }),
    /^Error: BLAST_BACKEND_HINTS_GATEWAY_SECRET must be at least 32 characters\.$/,
  );
  for (const name of [
    "BLAST_BACKEND_GATEWAY_SECRET",
    "DATABASE_URL",
    "DATABASE_REPLICA_URL",
    "PARTNER_VERIFIER_DATABASE_URL",
    "DEFILLAMA_READ_DATABASE_URL",
    "WATCHER_DATABASE_URL",
    "PRESALE_ADMIN_TOKEN",
    "ADMIN_LOGIN_ADMISSION_TOKEN",
    "BLAST_PARTNER_CAPACITY_CONFIG",
  ]) {
    assert.throws(
      () => hintsConfig({ ...configured, [name]: "synthetic-private-value" }),
      /must be absent from a hints backend/,
      name,
    );
    assert.equal(hintsConfig({ ...configured, [name]: "  " }).namespace, config.namespace);
  }
  assert.throws(
    () => hintsConfig({ ...configured, PRESALE_SIGNER_KEY: "synthetic" }),
    /must be absent/,
  );
  assert.throws(
    () => hintsConfig({ ...configured, CREATOR_CLAIM_SIGNER_KEY: "synthetic" }),
    /must be absent/,
  );
  assert.throws(
    () => hintsConfig({ ...configured, BLAST_BACKEND_MAX_HINT_STREAMS: "1025" }),
    /stream capacity/,
  );
});

test("hints startup requires an explicit matching fleet and usable infra configuration", () => {
  assert.throws(
    () => hintsConfig({ ...configured, BLAST_BACKEND_FLEET_CONFIG: undefined }),
    /fleet envelope/,
  );
  assert.throws(
    () => hintsConfig({ ...configured, BLAST_BACKEND_MAX_HINT_STREAMS: "512" }),
    /hint settings differ/,
  );
  assert.throws(
    () => hintsConfig({ ...configured, BLAST_INFRA_API_KEY: undefined }),
    /infra API key/,
  );
  assert.throws(() => hintsConfig({ ...configured, BLAST_INFRA_API_KEY: "bad" }), /32 to 512/);
  assert.throws(
    () => hintsConfig({ ...configured, BLAST_INFRA_READ_MODE: "" }),
    /BLAST_INFRA_READ_MODE=committed-markets/,
  );
  assert.throws(
    () => hintsConfig({ ...configured, BLAST_INFRA_READ_ORIGIN: undefined }),
    /BLAST_INFRA_READ_ORIGIN/,
  );
  assert.throws(
    () => hintsConfig({ ...configured, BLAST_INFRA_READ_ORIGIN: "http://reader.test" }),
    /HTTPS/,
  );
});

test("fresh hints import constructs no SQL pools or broad private owners or partner recovery", () => {
  const directory = mkdtempSync(join(tmpdir(), "blast-hints-import-"));
  try {
    const hook = join(directory, "guard.mjs");
    writeFileSync(
      hook,
      `
      import { registerHooks, createRequire } from 'node:module';
      const pg = createRequire(${JSON.stringify(new URL("../../../package.json", import.meta.url).href)})('pg');
      pg.Pool = class { constructor() { throw new Error('Hints must never construct a SQL pool'); } };
      registerHooks({ load(url, context, nextLoad) {
        if (/(?:\\/private\\/api\\.ts|\\/partner-api-keys\\/|\\/social\\/trades\\/|\\/maintenance\\/|\\/operators\\/)/.test(url))
          throw new Error('Forbidden hints dependency: ' + url);
        return nextLoad(url, context);
      }});
      await import(${JSON.stringify(new URL("../src/app/hints/start.ts", import.meta.url).href)});
      console.log('narrow-hints-import-ok');
    `,
    );
    const child = spawnSync(
      "node",
      ["--no-warnings", "--experimental-strip-types", "--import", hook, "--eval", ""],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: { PATH: process.env.PATH },
      },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /narrow-hints-import-ok/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("standalone hints serves readiness, refuses every HTTP route and drains once", async () => {
  const commands: string[][] = [];
  let redisClosed = 0;
  let replayClosed = 0;
  const redis = (onClose: () => void) => ({
    async execute(args: string[]) {
      commands.push(args);
      assert.deepEqual(args, ["PING"]);
      return "PONG";
    },
    close: onClose,
  });
  const runtime = createHintsServer(
    { ...hintsConfig(configured), port: 0, hostname: "127.0.0.1" },
    redis(() => redisClosed++),
    redis(() => replayClosed++),
  );
  const origin = `http://127.0.0.1:${runtime.server.port}`;
  try {
    assert.deepEqual(runtime.readinessDependencies, ["quota-redis", "private-replay-redis"]);
    const health = await fetch(origin + "/v1/health");
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ready");
    assert.deepEqual(commands, [["PING"], ["PING"]]);
    const path = "/api/social/me";
    const signed = signPrivateRequest(
      new Request(origin + path),
      new Uint8Array(),
      configured.BLAST_BACKEND_HINTS_GATEWAY_SECRET,
      {
        namespace: quotaNamespace(configured.BLAST_REDIS_NAMESPACE, deploymentIdentity(configured)),
        siteOrigin: configured.NEXT_PUBLIC_SITE_URL,
        ip: "192.0.2.91",
        purpose: "browser",
      },
    );
    for (const [target, headers, status] of [
      [path, signed, 403],
      [path, undefined, 403],
      ["/api/v1/prices", undefined, 403],
      ["/api/admin/partner-keys", undefined, 401],
    ] as const) {
      const refused = await fetch(origin + target, { headers });
      assert.equal(refused.status, status, target);
      await refused.text();
    }
    assert.equal(commands.length, 2, "refused requests never burn a nonce");
    await runtime.drain();
    await runtime.drain();
    assert.equal(redisClosed, 1);
    assert.equal(replayClosed, 1);
  } finally {
    await runtime.drain();
  }
});

test(
  "native hints entrypoint starts without DB/partner configuration and exits on SIGTERM",
  { timeout: 10_000 },
  async () => {
    const listener = createServer().listen(0, "127.0.0.1");
    await once(listener, "listening");
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    const child = spawn("bun", [fileURLToPath(new URL("../src/hints-main.ts", import.meta.url))], {
      env: {
        ...configured,
        PORT: String(port),
        BLAST_BACKEND_LISTEN_HOST: "127.0.0.1",
        MISSION_CONTROL_METRICS: "off",
        PATH: process.env.PATH,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exited = once(child, "close");
    try {
      let live = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        assert.equal(child.exitCode, null, stdout + stderr);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/v1/live`, {
            signal: AbortSignal.timeout(200),
          });
          live = response.status === 200 && (await response.text()) === "live";
        } catch {
          /* Startup has not opened the native listener yet. */
        }
        if (live) {
          break;
        }
        await pause(20);
      }
      assert.equal(live, true, stdout + stderr);
      child.kill("SIGTERM");
      const [code, signal] = await exited;
      assert.equal(code, 0, stdout + stderr);
      assert.equal(signal, null);
      const { at, ...event } = JSON.parse(stdout.trim());
      assert.ok(Number.isFinite(Date.parse(at)));
      assert.deepEqual(event, { level: 30, role: "hints", metric: "backend.listening" });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    }
  },
);

test("hints readiness fails closed when either Redis purpose is unavailable", async () => {
  for (const unavailable of ["quota", "private-replay"]) {
    const redis = (purpose: string) => ({
      async execute(args: string[]) {
        assert.deepEqual(args, ["PING"]);
        if (purpose === unavailable) {
          throw new Error("Synthetic Redis refusal");
        }
        return "PONG";
      },
      close() {},
    });
    const runtime = createHintsServer(
      { ...hintsConfig(configured), port: 0, hostname: "127.0.0.1" },
      redis("quota"),
      redis("private-replay"),
    );
    try {
      const response = await fetch(`http://127.0.0.1:${runtime.server.port}/v1/health`);
      assert.equal(response.status, 503, unavailable);
      assert.equal(await response.text(), "unavailable");
    } finally {
      await runtime.drain();
    }
  }
});
