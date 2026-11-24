import { drizzle } from "drizzle-orm/pg-proxy";
import type { Pool, QueryResultRow } from "pg";

import type { MissionControlModule, OwnedTable } from "@blast/core/modules/database/modules.ts";
import {
  autocommitRead,
  autocommitWrite,
  ownedWriteTarget,
  type ModuleTransaction,
} from "@blast/core/modules/database/transaction.ts";

/** Use inside withTransaction; Drizzle shares its guarded connection and never starts a transaction. */
export function transactionDatabase<M extends MissionControlModule>(transaction: ModuleTransaction<M>) {
  return drizzle(async (text, values, method) => {
    const rowMode = method === "all" ? "array" : undefined;
    const result = /^\s*(SELECT|SHOW)\b/i.test(text)
      ? await transaction.read(text, values, rowMode)
      : await transaction.write(ownedWriteTarget(transaction.moduleName, text), text, values, rowMode);
    return { rows: result.rows };
  });
}

export function workerDatabase<M extends MissionControlModule>(pool: Pool, moduleName: M) {
  return transactionDatabase({
    moduleName,
    read: (text, values, rowMode) => autocommitRead(pool, moduleName, text, values, { rowMode }),
    write: <Row extends QueryResultRow>(table: OwnedTable<M>, text: string, values?: readonly unknown[], rowMode?: "array") => autocommitWrite<M, Row>(pool, moduleName, table, text, values, rowMode),
  });
}
