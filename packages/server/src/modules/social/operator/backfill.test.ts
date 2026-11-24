import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { QueryResult } from "pg";

import type { TransactionContext } from "@blast/core/modules/database/transaction.ts";
import { OperatorAuthenticator } from "@blast/server/modules/mission-control/operator/auth.ts";
import { OperatorError } from "@blast/server/modules/mission-control/operator/errors.ts";
import { parseBackfillArgs, SOCIAL_BACKFILL_BATCH_SIZE } from "./backfill.ts";
import { SOCIAL_OPERATOR_COMMANDS } from "./commands.ts";
import {
  parseSocialOperatorInvocation,
  runSocialOperatorInvocation,
  SOCIAL_OPERATOR_BATCH_TRANSACTION,
  socialOperatorCommand,
  type RunInTransaction,
} from "./framework.ts";

/** Social-feed T-015: the `backfill` arguments and the framework's batched runner mode. */

const TOKEN = "social-backfill-unit-token-of-32-characters";
const operator = new OperatorAuthenticator({
  operatorId: "ops.jose",
  tokenHash: createHash("sha256").update(TOKEN).digest("hex"),
}).authenticate("ops.jose", TOKEN);

const code = (error: unknown) => (error instanceof OperatorError ? error.code : undefined);

test("T-015 backfill takes no argument or a bounded --batch-size", () => {
  const parse = (...argv: string[]) => parseSocialOperatorInvocation(argv, SOCIAL_OPERATOR_COMMANDS);
  assert.deepEqual(parse("backfill").input, { batchSize: SOCIAL_BACKFILL_BATCH_SIZE });
  assert.deepEqual(parse("backfill", "--batch-size", "25", "--reason", "release").input, { batchSize: 25 });
  assert.equal(parse("backfill", "--reason", "release").reason, "release");
  assert.deepEqual(parseBackfillArgs(["--batch-size", "5000"]), { batchSize: 5000 });
  for (const argv of [
    ["backfill", "now"],
    ["backfill", "--batch-size"],
    ["backfill", "--batch-size", "0"],
    ["backfill", "--batch-size", "5001"],
    ["backfill", "--batch-size", "-1"],
    ["backfill", "--batch-size", "1.5"],
    ["backfill", "--batch-size", "010"],
    ["backfill", "--batch-size", "10", "--batch-size", "10"],
  ]) {
    assert.throws(() => parse(...argv), (error) => code(error) === "OPERATOR_INPUT_INVALID", argv.join(" "));
  }
});

type Transaction = { options: unknown; writes: { table: string; values: readonly unknown[] }[]; committed: boolean };

/** A runner that records each transaction, its options and whether it committed. */
function recordingRunner(transactions: Transaction[]): RunInTransaction {
  return async (operation, options) => {
    const record: Transaction = { options, writes: [], committed: false };
    transactions.push(record);
    const result = (rows: unknown[] = []) =>
      Promise.resolve({ rows, rowCount: rows.length, command: "", oid: 0, fields: [] } as unknown as QueryResult);
    const context = {
      read: () => result(),
      forModule: (moduleName: string) => ({
        moduleName,
        read: () => result(),
        write: (table: string, _text: string, values: readonly unknown[] = []) => {
          record.writes.push({ table, values });
          return result(table === "social_operator_log" ? [{ log_id: `log-${transactions.length}` }] : []);
        },
      }),
    } as unknown as TransactionContext;
    const value = await operation(context);
    record.committed = true;
    return value;
  };
}

function batched(batches: number, failAt: number | null) {
  return socialOperatorCommand<null>({
    path: ["batched"],
    usage: "batched",
    parse: () => null,
    runBatches: async (_input, { batch, progress }) => {
      for (let index = 1; index <= batches; index += 1) {
        await batch(async (social) => {
          if (index === failAt) throw new OperatorError("OPERATOR_CONFLICT");
          await social.write("social_follows", "INSERT INTO social_follows DEFAULT VALUES", [index]);
        });
        progress({ action: "batched", target: "*", before: null, after: { done: index, completed: false } });
      }
      return { result: { done: batches }, log: { action: "batched", target: "*", before: null, after: { done: batches, completed: true } } };
    },
  });
}

test("T-015 a batched command commits each batch on its own and logs once at the end", async () => {
  const transactions: Transaction[] = [];
  const outcome = await runSocialOperatorInvocation(
    { command: batched(3, null), input: null, reason: "release" },
    operator,
    recordingRunner(transactions),
  );
  assert.deepEqual(outcome, { command: "batched", logId: "log-4", result: { done: 3 } });
  assert.equal(transactions.length, 4);
  for (const batch of transactions.slice(0, 3)) {
    assert.equal(batch.options, SOCIAL_OPERATOR_BATCH_TRANSACTION, "batches retry and are bounded");
    assert.deepEqual(batch.writes.map((write) => write.table), ["social_follows"]);
  }
  const last = transactions[3]!;
  assert.deepEqual(last.writes.map((write) => write.table), ["social_operator_log"]);
  assert.deepEqual(last.writes[0]!.values, ["ops.jose", "batched", "*", null, '{"done":3,"completed":true}', "release"]);
});

test("T-015 a batched command that fails logs what committed batches did, or nothing if none did", async () => {
  const transactions: Transaction[] = [];
  await assert.rejects(
    runSocialOperatorInvocation({ command: batched(3, 3), input: null, reason: null }, operator, recordingRunner(transactions)),
    (error) => code(error) === "OPERATOR_CONFLICT",
  );
  const logs = transactions.flatMap((transaction) => transaction.writes).filter((write) => write.table === "social_operator_log");
  assert.deepEqual(logs.map((write) => write.values[4]), ['{"done":2,"completed":false}']);

  const none: Transaction[] = [];
  await assert.rejects(
    runSocialOperatorInvocation({ command: batched(3, 1), input: null, reason: null }, operator, recordingRunner(none)),
    (error) => code(error) === "OPERATOR_CONFLICT",
  );
  assert.equal(none.length, 1);
  assert.equal(none[0]!.committed, false);
});
