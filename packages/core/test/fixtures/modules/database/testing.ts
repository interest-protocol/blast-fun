import type { Pool, PoolClient } from "pg";

import { takeProcessSingleton } from "@blast/core/lib/process-singleton.ts";

/** Records the text of every statement any client of `pool` sends. */
export function recordStatements(pool: Pool): string[] {
  const statements: string[] = [];
  pool.on("connect", (client: PoolClient) => {
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    client.query = ((...args: unknown[]) => {
      const [text] = args;
      statements.push(
        typeof text === "string"
          ? text
          : String((text as { text?: unknown } | undefined)?.text ?? ""),
      );
      return query(...args);
    }) as unknown as PoolClient["query"];
  });
  return statements;
}

/** The process-wide pools (`primaryPool`, `replicaPool`) a test may have created. */
const PROCESS_POOL_SLOTS = ["mission-control.database.pool", "database.replica-pool", "database.partner-verifier-pool"];

/** Ends and forgets the process-wide pools, so the next test builds them from its own environment. */
export async function endProcessPools(): Promise<void> {
  // The durable Mission Control limiter holds the primary pool, so it goes with it.
  takeProcessSingleton("mission-control.rate-limiter");
  for (const name of PROCESS_POOL_SLOTS) {
    await takeProcessSingleton<Pool>(name)?.end();
  }
}
