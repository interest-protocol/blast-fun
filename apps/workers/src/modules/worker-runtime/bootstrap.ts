// What every chain worker process opens once its settings are valid: the redacted log, the
// mainnet Sui client, its database pool and its alerts. Each worker's main passes its process
// name (its row in `src/processes.ts`), which names the pool's `application_name` and the alerts' worker.

import { randomUUID } from "node:crypto";

import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { Pool } from "pg";

import { createRuntimePool } from "@blast/core/modules/database/pool.ts";

import { createWorkerAlerts, type WorkerAlerts } from "./alerts.ts";
import { mainnetClient } from "./client.ts";
import type { WorkerConfig } from "./config.ts";
import { redactingLog, WORKER_METRICS, type WorkerLog } from "./log.ts";

type Environment = Readonly<Record<string, string | undefined>>;

type WorkerBootstrap = Readonly<{
  log: WorkerLog;
  client: SuiGrpcClient;
  pool: Pool;
  alerts: WorkerAlerts;
  holder: string;
}>;

/** A started worker: its job names for the start line, and its loop. */
type StartedWorker = Readonly<{
  jobs: readonly string[];
  run(signal: AbortSignal): Promise<void>;
}>;

/**
 * Opens the process's runtime, starts it, logs the start line and runs it until `signal` aborts;
 * then closes the pool. Validate every setting before calling this: nothing connects before it.
 */
export async function runWorker(
  input: Readonly<{
    name: string;
    environment: Environment;
    config: WorkerConfig;
    secrets: readonly string[];
    webhookUrl: string;
  }>,
  signal: AbortSignal,
  start: (bootstrap: WorkerBootstrap) => Promise<StartedWorker> | StartedWorker,
): Promise<void> {
  const { name, environment, config, secrets, webhookUrl } = input;
  const log = redactingLog(secrets, undefined, environment);
  const client = mainnetClient(config.node.url);
  const holder = randomUUID();
  const pool = createRuntimePool(config.databaseUrl, config.pool, name);
  const network = () => config.selection?.network ?? "unselected";

  try {
    const alerts = createWorkerAlerts({
      pool,
      role: name,
      network,
      webhookUrl,
      timeoutMs: config.timings.providerTimeoutMs,
      log,
      secrets,
    });
    const worker = await start({ log, client, pool, alerts, holder });

    log(WORKER_METRICS.started, {
      jobs: worker.jobs.join(","),
      environment: config.environment,
      network: network(),
      poolMax: config.pool.max,
      holder,
    });
    await worker.run(signal);
  } finally {
    await pool.end();
    log(WORKER_METRICS.stopped, { holder });
  }
}
