import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loopbackOrigin, readRealReaderFixture } from "./real-reader-fixture.ts";

test("real-reader handoff refuses hosted targets, missing identity and empty fixtures", (t) => {
  for (const origin of [
    "https://api.blast.fun",
    "http://localhost:8080",
    "https://127.0.0.1:8080",
    "http://127.0.0.1",
    "http://user:secret@127.0.0.1:8080",
    "http://127.0.0.1:8080/path",
    "http://127.0.0.1:8080/?redirect=hosted",
  ]) {
    assert.throws(() => loopbackOrigin(origin));
  }
  assert.equal(loopbackOrigin("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.equal(loopbackOrigin("http://[::1]:8080"), "http://[::1]:8080");
  assert.throws(() => readRealReaderFixture(undefined));
  const directory = mkdtempSync(join(tmpdir(), "blast-reader-guard-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "ready.json");
  const fixture = {
    schema_version: 1,
    nonce: "test-local-nonce",
    reader_origin: "http://127.0.0.1:8080",
    writer_origin: "http://127.0.0.1:8081",
    network: "localnet",
    deployment_fingerprint: "a".repeat(64),
    binary_sha256: "b".repeat(64),
    pool_keys: ["blast_curve:0x" + "c".repeat(64)],
  };
  writeFileSync(path, JSON.stringify(fixture));
  assert.deepEqual(readRealReaderFixture(path), fixture);
  for (const changed of [
    { ...fixture, network: "mainnet" },
    { ...fixture, pool_keys: [] },
    { ...fixture, binary_sha256: "missing" },
    { ...fixture, reader_origin: fixture.writer_origin },
  ]) {
    writeFileSync(path, JSON.stringify(changed));
    assert.throws(() => readRealReaderFixture(path));
  }
  writeFileSync(path, JSON.stringify(fixture));
  const runner = new URL("../../../scripts/verify-backend-real-reader.mjs", import.meta.url)
    .pathname;
  const refused = spawnSync(process.execPath, [runner], {
    encoding: "utf8",
    timeout: 5_000,
    env: { PATH: process.env.PATH, BLAST_BACKEND_READER_HANDOFF: path },
  });
  assert.equal(
    refused.status,
    1,
    "Absent explicit reader key must fail before any container or network operation.",
  );
  assert.deepEqual(JSON.parse(readFileSync(join(directory, "continue.json"), "utf8")), {
    nonce: fixture.nonce,
    passed: false,
  });
});

function launcherProbe(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "blast-reader-launch-contract-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const handoff = join(directory, "ready.json");
  const fixture = {
    schema_version: 1,
    nonce: "native-runtime-contract",
    reader_origin: "http://127.0.0.1:8080",
    writer_origin: "http://127.0.0.1:8081",
    network: "localnet",
    deployment_fingerprint: "a".repeat(64),
    binary_sha256: "b".repeat(64),
    pool_keys: ["blast_curve:0x" + "c".repeat(64)],
  };
  writeFileSync(handoff, JSON.stringify(fixture));
  return {
    directory,
    handoff,
    environment: {
      PATH: process.env.PATH!,
      HOME: process.env.HOME!,
      BLAST_BACKEND_READER_HANDOFF: handoff,
      BLAST_BACKEND_READER_TEST_API_KEY: "synthetic-explicit-reader-key-01234567890123456789",
      MISSION_CONTROL_TEST_DATABASE_URL:
        "postgres://fixture:private@127.0.0.1:54329/backend_test?connect_timeout=5",
      BLAST_TEST_REDIS_URL: "redis://127.0.0.1:63799",
    },
  };
}

const launcher = () =>
  import(new URL("../../../scripts/verify-backend-real-reader.mjs", import.meta.url).href);

test("native reader launch uses explicit local dependencies, clean environment and an empty private cwd", async (t) => {
  const { runReaderBridge } = await launcher();
  const probe = launcherProbe(t);
  let privateDirectory = "";
  let calls = 0;
  runReaderBridge(
    {
      ...probe.environment,
      DATABASE_URL: "postgres://production-secret@hosted.invalid/production",
      NODE_OPTIONS: "--require=untrusted",
      PRIVY_APP_SECRET: "must-not-forward",
    },
    (
      command: string,
      args: string[],
      options: { cwd: string; env: Record<string, string>; timeout: number; stdio: string },
    ) => {
      calls++;
      assert.equal(command, process.execPath);
      assert.deepEqual(args, [
        "--no-env-file",
        "test",
        "--max-concurrency",
        "1",
        "--timeout",
        "165000",
        new URL("./real-reader.integration.test.ts", import.meta.url).pathname,
      ]);
      assert.equal(options.timeout, 180_000);
      assert.equal(options.stdio, "inherit");
      assert.deepEqual(options.env, { ...probe.environment, TZ: "UTC" });
      privateDirectory = options.cwd;
      assert.notEqual(privateDirectory, probe.directory);
      assert.deepEqual(readdirSync(privateDirectory), []);
      assert.equal(statSync(privateDirectory).mode & 0o077, 0);
      return { status: 0 };
    },
  );
  assert.equal(calls, 1);
  assert.equal(existsSync(privateDirectory), false);
  assert.deepEqual(JSON.parse(readFileSync(join(probe.directory, "continue.json"), "utf8")), {
    nonce: "native-runtime-contract",
    passed: true,
  });
});

test("native reader launcher refuses missing or unsafe explicit dependencies without spawning", async (t) => {
  const { runReaderBridge } = await launcher();
  const cases = [
    ["database absent", "MISSION_CONTROL_TEST_DATABASE_URL", undefined],
    ["Redis absent", "BLAST_TEST_REDIS_URL", undefined],
    ["database malformed", "MISSION_CONTROL_TEST_DATABASE_URL", "not a URL"],
    [
      "database hosted",
      "MISSION_CONTROL_TEST_DATABASE_URL",
      "postgres://fixture:private@hosted.invalid:5432/backend_test",
    ],
    [
      "database protocol",
      "MISSION_CONTROL_TEST_DATABASE_URL",
      "https://127.0.0.1:5432/backend_test",
    ],
    [
      "database no port",
      "MISSION_CONTROL_TEST_DATABASE_URL",
      "postgres://fixture:private@127.0.0.1/backend_test",
    ],
    [
      "database host override",
      "MISSION_CONTROL_TEST_DATABASE_URL",
      "postgres://fixture:private@127.0.0.1:5432/backend_test?host=hosted.invalid",
    ],
    [
      "database fragment",
      "MISSION_CONTROL_TEST_DATABASE_URL",
      "postgres://fixture:private@127.0.0.1:5432/backend_test#fragment",
    ],
    ["Redis hosted", "BLAST_TEST_REDIS_URL", "redis://hosted.invalid:6379"],
    ["Redis protocol", "BLAST_TEST_REDIS_URL", "https://127.0.0.1:6379"],
    ["Redis override", "BLAST_TEST_REDIS_URL", "redis://127.0.0.1:6379?host=hosted.invalid"],
  ] as const;
  for (const [name, key, value] of cases) {
    await t.test(name, (child) => {
      const probe = launcherProbe(child);
      let calls = 0;
      assert.throws(
        () =>
          runReaderBridge(
            {
              ...probe.environment,
              [key]: value,
              DATABASE_URL: "postgres://must-not-fallback@hosted.invalid/production",
            },
            () => {
              calls++;
              return { status: 0 };
            },
          ),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.message.includes("private"), false);
          return true;
        },
      );
      assert.equal(calls, 0);
      assert.deepEqual(JSON.parse(readFileSync(join(probe.directory, "continue.json"), "utf8")), {
        nonce: "native-runtime-contract",
        passed: false,
      });
    });
  }
});

test("native reader launch failure retains a failed nonce and removes its private cwd", async (t) => {
  const { runReaderBridge } = await launcher();
  for (const result of [
    { status: 1 },
    { status: null, error: new Error("synthetic child timeout") },
  ]) {
    await t.test(String(result.status), (child) => {
      const probe = launcherProbe(child);
      let privateDirectory = "";
      assert.throws(() =>
        runReaderBridge(
          probe.environment,
          (_command: string, _args: string[], options: { cwd: string }) => {
            privateDirectory = options.cwd;
            return result;
          },
        ),
      );
      assert.equal(existsSync(privateDirectory), false);
      assert.deepEqual(JSON.parse(readFileSync(join(probe.directory, "continue.json"), "utf8")), {
        nonce: "native-runtime-contract",
        passed: false,
      });
    });
  }
});

test("native reader launcher never overwrites an existing continuation", async (t) => {
  const { runReaderBridge } = await launcher();
  const probe = launcherProbe(t);
  const continuation = join(probe.directory, "continue.json");
  const existing = '{"nonce":"original","passed":false}\n';
  writeFileSync(continuation, existing);
  let calls = 0;
  assert.throws(
    () =>
      runReaderBridge(probe.environment, () => {
        calls++;
        return { status: 0 };
      }),
    /refuse to reuse/,
  );
  assert.equal(calls, 0);
  assert.equal(readFileSync(continuation, "utf8"), existing);
});

test("Node invocation is refused before spawning and releases its failed handoff", (t) => {
  const probe = launcherProbe(t);
  const node = spawnSync("node", ["-p", "process.execPath"], {
    encoding: "utf8",
    timeout: 5_000,
    env: { PATH: process.env.PATH },
  });
  assert.equal(node.status, 0, "Node 24 is required for this fixture-only refusal probe.");
  const runner = new URL("../../../scripts/verify-backend-real-reader.mjs", import.meta.url)
    .pathname;
  const refused = spawnSync(node.stdout.trim(), [runner], {
    encoding: "utf8",
    timeout: 5_000,
    env: { ...probe.environment, PATH: probe.directory },
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /pinned native Bun 1\.4\.2/);
  assert.deepEqual(JSON.parse(readFileSync(join(probe.directory, "continue.json"), "utf8")), {
    nonce: "native-runtime-contract",
    passed: false,
  });
});
