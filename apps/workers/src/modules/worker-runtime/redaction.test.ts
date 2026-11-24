import assert from "node:assert/strict";
import test from "node:test";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { redactingLog, workerSecrets } from "./log.ts";

test("new worker credentials and unexpected signer keys are redacted before logging", () => {
  const environment = {
    VAULT_REWARDS_SIGNER_KEY: "fixture-rewards-private-key",
    FUTURE_SIGNER_KEY: "fixture-unexpected-private-key",
    REWARDS_BLOB_TOKEN: "fixture-manifest-token",
    REWARDS_PLANNER_DATABASE_URL: "postgres://reader:fixture-db-password@127.0.0.1/test",
    BLAST_BUYBACK_ALERT_WEBHOOK_URL: "https://example.invalid/fixture-webhook-token",
  };
  const lines: string[] = [];
  const log = redactingLog(workerSecrets(environment), (line) => lines.push(line), {});
  log("test", { evidence: Object.values(environment).join(" ") + " fixture-db-password" });
  for (const value of Object.values(environment)) assert.ok(!lines[0]?.includes(value));
  assert.ok(!lines[0]?.includes("fixture-db-password"));
  assert.match(lines[0]!, /redacted/);
});

// This fails if a signer key's raw encodings, a webhook's token path, or the verify-full spelling
// of a require-mode database URL can reach a log line, or if a malformed URL escape stops a worker.
test("every spelling of a worker secret is redacted", () => {
  const key = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(9));
  const secretKey = Buffer.from(decodeSuiPrivateKey(key.getSecretKey()).secretKey);
  const environment = {
    VAULT_REWARDS_SIGNER_KEY: key.getSecretKey(),
    BLAST_WORKER_ALERT_WEBHOOK_URL: "https://discord.example/api/webhooks/1/fixture-hook-token",
    WATCHER_DATABASE_URL: "postgres://db-fixture-host.example/blast?sslmode=require",
    BLAST_BUYBACK_ALERT_WEBHOOK_URL: "https://hook:pa%ss@hook.example/x",
  };
  const leaks = [
    secretKey.toString("hex"),
    secretKey.toString("base64"),
    Buffer.concat([Buffer.of(0), secretKey]).toString("base64"),
    "/api/webhooks/1/fixture-hook-token",
    "postgres://db-fixture-host.example/blast?sslmode=verify-full",
  ];
  const lines: string[] = [];
  const log = redactingLog(workerSecrets(environment), (line) => lines.push(line), {});
  for (const leak of leaks) log("test", { evidence: leak });
  assert.equal(lines.length, leaks.length);
  lines.forEach((line, index) => assert.ok(!line.includes(leaks[index]!), leaks[index]));
});

test("MISSION_CONTROL_METRICS=off silences worker logging", () => {
  const lines: string[] = [];
  const environment = { MISSION_CONTROL_METRICS: "off" };
  const log = redactingLog([], (line) => lines.push(line), environment);
  log("worker.started");
  assert.deepEqual(lines, []);
  environment.MISSION_CONTROL_METRICS = "on";
  log("worker.started");
  assert.equal(lines.length, 1);
});
