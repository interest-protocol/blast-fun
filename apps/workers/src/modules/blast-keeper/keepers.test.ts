// The keepers' configuration (LP-18, LP-20): every value required, the alert
// webhook and blast-infra over https (loopback http only outside production),
// a delivery batch the signer accepts, and both secrets redacted.

import assert from "node:assert/strict";
import test from "node:test";

import { redactingLog, workerSecrets } from "#workers/modules/worker-runtime/log.ts";
import { keeperConfigFromEnvironment } from "./keepers.ts";

const HOOK = "https://discord.com/api/webhooks/123/fixture-token-not-real";
const KEY = "k".repeat(40);
const ENVIRONMENT = {
  BLAST_WORKER_ALERT_WEBHOOK_URL: HOOK,
  BLAST_INFRA_ORIGIN: "https://infra.blast.example",
  BLAST_INFRA_API_KEY: KEY,
  BLAST_WORKER_DELIVERY_BATCH_SIZE: "20",
  BLAST_WORKER_OPENING_ROUND_ALERT_MS: "600000",
  BLAST_WORKER_FEE_CLAIM_INTERVAL_MS: "86400000",
  BLAST_WORKER_FEE_CLAIM_GAS_MULTIPLE: "5",
};

test("the keepers' configuration reads the owner's values and requires each one", () => {
  const config = keeperConfigFromEnvironment(ENVIRONMENT, "production", 4_000);
  assert.equal(config.alertWebhookUrl, HOOK);
  assert.equal(config.market.origin, "https://infra.blast.example");
  assert.equal(config.market.timeoutMs, 4_000);
  assert.deepEqual(
    [config.deliveryBatchSize, config.openingRoundAlertMs, config.feeClaimIntervalMs, config.feeClaimGasMultiple],
    [20, 600_000, 86_400_000, 5n],
  );
  for (const name of Object.keys(ENVIRONMENT).filter((name) => name !== "BLAST_INFRA_API_KEY")) {
    assert.throws(() => keeperConfigFromEnvironment({ ...ENVIRONMENT, [name]: undefined }, "production", 4_000), new RegExp(`${name} is required`), name);
  }
});

test("the keepers refuse plaintext endpoints in production, a batch above the signer's bound and non-integers, naming only the variable", () => {
  const refused: Array<[Record<string, string>, RegExp]> = [
    [{ BLAST_WORKER_ALERT_WEBHOOK_URL: "http://discord.com/api/webhooks/1/x" }, /BLAST_WORKER_ALERT_WEBHOOK_URL must be an https URL/],
    [{ BLAST_WORKER_ALERT_WEBHOOK_URL: "http://127.0.0.1:3200/hook" }, /BLAST_WORKER_ALERT_WEBHOOK_URL must be an https URL/],
    [{ BLAST_INFRA_ORIGIN: "http://infra.blast.example" }, /BLAST_INFRA_ORIGIN must be an https URL/],
    [{ BLAST_WORKER_DELIVERY_BATCH_SIZE: "101" }, /BLAST_WORKER_DELIVERY_BATCH_SIZE must be an integer from 1 to 100/],
    [{ BLAST_WORKER_FEE_CLAIM_GAS_MULTIPLE: "1.5" }, /BLAST_WORKER_FEE_CLAIM_GAS_MULTIPLE must be an integer of at least 1/],
    [{ BLAST_WORKER_FEE_CLAIM_GAS_MULTIPLE: "0x10" }, /BLAST_WORKER_FEE_CLAIM_GAS_MULTIPLE must be an integer of at least 1/],
    [{ BLAST_WORKER_OPENING_ROUND_ALERT_MS: "1e3" }, /BLAST_WORKER_OPENING_ROUND_ALERT_MS must be an integer of at least 1/],
  ];
  for (const [override, message] of refused) {
    assert.throws(() => keeperConfigFromEnvironment({ ...ENVIRONMENT, ...override }, "production", 4_000), (error: unknown) => {
      assert.match((error as Error).message, message);
      assert.doesNotMatch((error as Error).message, /fixture-token|127\.0\.0\.1|infra\.blast/);
      return true;
    });
  }
  // Loopback http serves local rehearsals outside production.
  const local = keeperConfigFromEnvironment(
    { ...ENVIRONMENT, BLAST_WORKER_ALERT_WEBHOOK_URL: "http://127.0.0.1:3200/hook", BLAST_INFRA_ORIGIN: "http://127.0.0.1:3201" },
    "non-production",
    1_000,
  );
  assert.equal(local.market.origin, "http://127.0.0.1:3201");
});

test("the alert webhook and blast-infra's key are redacted from every worker log line", () => {
  const lines: string[] = [];
  const log = redactingLog(workerSecrets(ENVIRONMENT), (line) => lines.push(line), {});
  log("fixture.line", { hook: HOOK, key: KEY, nested: `posting to ${HOOK}` });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0]!, /fixture-token-not-real|kkkkkkkk/);
});

test("Bluefin creation fee cap defaults closed and accepts only u64 MIST", () => {
  assert.equal(keeperConfigFromEnvironment(ENVIRONMENT, "production", 4000).bluefinCreationFeeCapMist, 0n);
  assert.equal(keeperConfigFromEnvironment({ ...ENVIRONMENT, BLAST_WORKER_BLUEFIN_CREATION_FEE_CAP_MIST: "18446744073709551615" }, "production", 4000).bluefinCreationFeeCapMist, 18446744073709551615n);
  for (const cap of ["-1", "1.5", "18446744073709551616", ""]) {
    assert.throws(() => keeperConfigFromEnvironment({ ...ENVIRONMENT, BLAST_WORKER_BLUEFIN_CREATION_FEE_CAP_MIST: cap }, "production", 4000), /BLAST_WORKER_BLUEFIN_CREATION_FEE_CAP_MIST/);
  }
});
