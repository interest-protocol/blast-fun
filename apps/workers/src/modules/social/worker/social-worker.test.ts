import assert from "node:assert/strict";
import test from "node:test";


import { WORKER_ALERT_REPEAT_MS } from "#workers/modules/worker-runtime/alerts.ts";
import { createSocialAlerts } from "./alerts.ts";
import { socialWorkerConfigFromEnvironment } from "./config.ts";
import { backoffMs } from "./runtime.ts";
import { sharedVestingExecution } from "#workers/modules/social/claims/vesting.ts";

test("T-025: failed passes back off from 5 s, doubling to 60 s", () => {
  const config = { intervalMs: 5_000, maxBackoffMs: 60_000 };
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 40].map((failures) => backoffMs(config, failures)), [5_000, 5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
});

test("T-025: configuration defaults, bounds and errors that name variables only", () => {
  const config = socialWorkerConfigFromEnvironment({});
  assert.equal(config.intervalMs, 5_000);
  assert.equal(config.leaseTtlMs, 30_000);
  assert.ok(config.leaseTtlMs + config.intervalMs < 60_000, "a standby takes over within 60 s");
  assert.equal(config.retentionDays, 90);
  assert.equal(config.alertWebhookUrl, null);
  // OA-25 Q16: the daily portfolio snapshot's page and retention.
  assert.equal(config.portfolioSnapshotBatch, 100);
  assert.equal(config.portfolioSnapshotRetentionDays, 400);
  assert.equal(socialWorkerConfigFromEnvironment({ SOCIAL_PORTFOLIO_SNAPSHOT_BATCH: "1000" }).portfolioSnapshotBatch, 1_000);
  assert.throws(() => socialWorkerConfigFromEnvironment({ SOCIAL_PORTFOLIO_SNAPSHOT_BATCH: "5000" }), /^Error: SOCIAL_PORTFOLIO_SNAPSHOT_BATCH must be/);
  assert.throws(() => socialWorkerConfigFromEnvironment({ SOCIAL_PORTFOLIO_SNAPSHOT_RETENTION_DAYS: "30" }), /^Error: SOCIAL_PORTFOLIO_SNAPSHOT_RETENTION_DAYS must be/);
  assert.equal(socialWorkerConfigFromEnvironment({ PRESALE_ALERT_WEBHOOK_URL: "https://hooks.example/p" }).alertWebhookUrl, "https://hooks.example/p");
  assert.equal(
    socialWorkerConfigFromEnvironment({ SOCIAL_ALERT_WEBHOOK_URL: "https://hooks.example/s", PRESALE_ALERT_WEBHOOK_URL: "https://hooks.example/p" }).alertWebhookUrl,
    "https://hooks.example/s",
  );
  assert.throws(() => socialWorkerConfigFromEnvironment({ SOCIAL_WORKER_INTERVAL_MS: "10" }), /^Error: SOCIAL_WORKER_INTERVAL_MS must be/);
  assert.throws(() => socialWorkerConfigFromEnvironment({ SOCIAL_ALERT_WEBHOOK_URL: "http://hooks.example/secret-token" }), (error: Error) =>
    error.message === "SOCIAL_ALERT_WEBHOOK_URL must be an https URL.");
  for (const url of ["http://127.5.6.7:3200/hook", "http://[::1]:3200/hook"]) {
    assert.equal(socialWorkerConfigFromEnvironment({ SOCIAL_ALERT_WEBHOOK_URL: url }).alertWebhookUrl, url);
    assert.throws(() => socialWorkerConfigFromEnvironment({ SOCIAL_ALERT_WEBHOOK_URL: url, BLAST_WORKER_ENVIRONMENT: "production" }), (error: Error) =>
      error.message === "SOCIAL_ALERT_WEBHOOK_URL must be an https URL.");
  }
});

test("T-025: an alert waits for its grace, repeats hourly, is redacted, and clears", async () => {
  let clock = 1_000_000;
  const lines: Array<Record<string, unknown>> = [];
  const bodies: string[] = [];
  const alerts = createSocialAlerts({
    webhookUrl: "https://hooks.example/secret-hook-path",
    log: (metric, fields) => void lines.push({ metric, ...fields }),
    now: () => clock,
    secrets: ["super-secret-value"],
    fetcher: async (_url, init) => {
      bodies.push(String(init?.body));
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(await alerts.raise("indexer_lagging", { lag_ms: 61_000 }, { graceMs: 300_000 }), "held");
  clock += 300_000;
  assert.equal(await alerts.raise("indexer_lagging", { lag_ms: 61_000, note: "super-secret-value" }, { graceMs: 300_000 }), "sent");
  clock += 60_000;
  assert.equal(await alerts.raise("indexer_lagging", {}, { graceMs: 300_000 }), "held");
  clock += WORKER_ALERT_REPEAT_MS;
  assert.equal(await alerts.raise("indexer_lagging", {}, { graceMs: 300_000 }), "sent");
  assert.doesNotMatch(bodies.join(""), /super-secret-value|secret-hook-path/);
  alerts.clear("indexer_lagging");
  assert.deepEqual(alerts.active(), []);
  assert.ok(lines.some((line) => line.outcome === "cleared"));
  await assert.rejects(alerts.raise("Bad Key"), TypeError);
  const logged = createSocialAlerts({ webhookUrl: null, log: (metric, fields) => void lines.push({ metric, ...fields }) });
  assert.equal(await logged.raise("defaults_incomplete", { count: 3 }), "logged");
});

test("T-024/T-026, R3-63, T-027/T-029, OA-25 Q16: the worker runs the intent steps, the claim steps, the milestones, the notifications, then the daily portfolio snapshot", async () => {
  const { openSocialWorker } = await import("./main.ts");
  const { worker, close } = openSocialWorker(
    { BLAST_SOCIAL_ENABLED: "true", WATCHER_DATABASE_URL: "postgresql://blast_watcher:unused@127.0.0.1:9/none" },
    { log: () => undefined },
  );
  try {
    // The intent steps come first (T-026): an attribution raises the source
    // post's "through" counts and a why joins the new item, and the
    // notification steps read both. The claim steps (R3-63) settle what a
    // browser left open; nothing later reads them.
    assert.deepEqual(worker.steps, [
      "wallet-registration",
      "intent-resolve", "intent-expiry", "claim-settle", "claim-vesting-settle", "claim-creator-settle", "claim-launch-settle",
      "claim-expiry",
      "milestone-commits", "milestone-holders", "notify-activity", "notify-lifecycle", "notify-clock", "notify-calls", "notify-retention",
      "portfolio-snapshot",
    ]);
  } finally {
    await close();
  }
});

test("team mode: BLAST_SOCIAL_ENABLED=team runs the worker as true (it serves no pages); other spellings stay disabled", async () => {
  const { runSocialWorker } = await import("./main.ts");
  for (const flag of [undefined, "false", "TRUE", "TEAM", "team "]) {
    const environment = flag === undefined ? {} : { BLAST_SOCIAL_ENABLED: flag };
    assert.equal(await runSocialWorker(environment, new AbortController().signal), "disabled", String(flag));
  }
  // Past the flag, the same configuration check as "true".
  for (const flag of ["true", "team"]) {
    await assert.rejects(runSocialWorker({ BLAST_SOCIAL_ENABLED: flag }, new AbortController().signal), /WATCHER_DATABASE_URL/, flag);
  }
});

test("Shared vesting evidence preserves exact failed status and rejects malformed native bytes", () => {
  const row = { digest: "claim-digest", checkpoint: "12", timestamp_ms: "1000", sender: `0x${"1".padStart(64, "0")}`, success: false,
    events: [{ eventType: "p::m::E", bcs: "AQI=" }] };
  const parsed = sharedVestingExecution(row);
  assert.equal(parsed?.success, false);
  assert.equal(parsed?.checkpoint, "12");
  assert.deepEqual([...parsed!.events[0]!.bcs], [1, 2]);
  assert.equal(sharedVestingExecution({ ...row, events: [{ eventType: "p::m::E", bcs: "malformed" }] }), null);
  assert.equal(sharedVestingExecution({ ...row, sender: "bad" }), null);
  assert.equal(sharedVestingExecution({ ...row, events: null }), null);
});

test("Shared vesting evidence accepts PostgreSQL line feeds and rejects other noncanonical bytes", () => {
  const bytes = Buffer.alloc(58, 42);
  const canonical = bytes.toString("base64");
  const wrapped = canonical.slice(0, 76) + "\n" + canonical.slice(76);
  const execution = (bcs: string) => sharedVestingExecution({
    digest: "claim-digest", checkpoint: "12", timestamp_ms: "1000",
    sender: `0x${"1".padStart(64, "0")}`, success: true,
    events: [{ eventType: "p::m::E", bcs }],
  });

  assert.deepEqual(execution(wrapped)?.events[0]?.bcs, bytes);
  assert.equal(execution(wrapped.replace("\n", "\r\n")), null);
  assert.equal(execution(wrapped.replace("\n", " ")), null);
  assert.equal(execution(wrapped.slice(0, -1)), null);
});
