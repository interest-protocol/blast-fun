import { parseArgs } from "node:util";
import { once } from "node:events";
import type { Pool } from "pg";
import { SuiGrpcClient } from "@mysten/sui/grpc";

import { SUI_MAINNET_GRPC_URL } from "@blast/core/lib/sui-mainnet.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { autocommitReader, withTransaction, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { fullnodeTradeLookup } from "@blast/server/modules/social/trades/swap.ts";
import { collectSwapReceipts, EXPORT_SWAP_RECEIPTS_SQL, type SwapTrackingCursor } from "@blast/server/modules/social/trades/tracking.ts";

// This CLI uses the primary's blast_web credentials. Stdout is JSONL; diagnostics go to stderr.
console.info = (...lines: unknown[]) => console.error(...lines);

function timestamp(value: string | undefined): number {
  if (!value || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error("Use an ISO timestamp with an explicit timezone.");
  }
  const result = Date.parse(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error("Invalid timestamp.");
  }
  return result;
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { from: { type: "string" }, to: { type: "string" } } });
  if (positionals.length !== 1 || !["collect", "export"].includes(positionals[0])) {
    throw new Error("Usage: swaps:track collect | export --from <ISO> --to <ISO>");
  }
  const command = positionals[0];
  const from = command === "export" ? timestamp(values.from) : 0;
  const to = command === "export" ? timestamp(values.to) : 0;
  if (command === "export" && from >= to) {
    throw new Error("The export end must be after its start.");
  }
  const pool = createPool(undefined, { max: 1, statement_timeout: 5_000, connectionTimeoutMillis: 5_000 });
  try {
    const database = autocommitReader(pool, "social", { label: "social.swap-tracking" });
    if (command === "collect") {
      await collectAll(pool, database);
    } else {
      await withTransaction(pool, (tx) => exportReceipts(tx, from, to), { isolationLevel: "REPEATABLE READ", label: "social.swap-export" });
    }
  } finally {
    await pool.end();
  }
}

async function collectAll(pool: Pool, database: ReadableDatabase): Promise<void> {
  const node = new SuiGrpcClient({ network: "mainnet", baseUrl: SUI_MAINNET_GRPC_URL });
  let after: SwapTrackingCursor | undefined;
  let unavailable = 0;
  do {
    const page = await collectSwapReceipts({
      database,
      transactions: fullnodeTradeLookup(() => node),
      transaction: (operation) => withTransaction(pool, (tx) => operation(tx.forModule("social")), { label: "social.swap-tracking" }),
    }, after);
    await writeJsonLine(page);
    unavailable += page.unavailable;
    after = page.next ?? undefined;
  } while (after);
  if (unavailable > 0) {
    throw new Error("Some chain lookups were unavailable. Rerun collection before using the export.");
  }
}

async function exportReceipts(database: ReadableDatabase, from: number, to: number): Promise<void> {
  let cursorTime = "0";
  let cursorId = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const { rows } = await database.read(EXPORT_SWAP_RECEIPTS_SQL, [from, to, cursorTime, cursorId]);
    for (const row of rows) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Await stdout backpressure for each JSONL row before buffering another row.
      await writeJsonLine(row);
    }
    if (rows.length < 100) {
      break;
    }
    cursorTime = rows.at(-1)!.timestamp_ms;
    cursorId = rows.at(-1)!.trade_id;
  }
}

async function writeJsonLine(value: unknown): Promise<void> {
  if (!process.stdout.write(`${JSON.stringify(value)}\n`)) {
    await once(process.stdout, "drain");
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error && !('code' in error) ? error.message : "Swap tracking failed; check database access and migration 0125.");
  process.exitCode = 1;
}
