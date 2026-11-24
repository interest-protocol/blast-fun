import assert from "node:assert/strict";
import test from "node:test";

import type { SuiClientTypes } from "@mysten/sui/client";
import type { Transaction } from "@mysten/sui/transactions";

import type { AttemptResult } from "./attempt.ts";
import { chunks, simulateSignSendBatch, type BatchRecord } from "./batch.ts";
import type { JobContext, Submission } from "./runtime.ts";

type Item = BatchRecord<string>;

/** A record adding `commands` placeholder calls (a Bluefin migration adds two: its zero coin and its call). */
function record(key: string, commands = 1): Item {
  return {
    key,
    intent: key,
    add: (transaction: Transaction) => {
      for (let index = 0; index < commands; index += 1) {
        transaction.moveCall({ target: `0x2::${key}::call${index}` });
      }
    },
  };
}

const error = (command?: number) => ({ $kind: "Unknown", message: "abort", Unknown: null, command }) as SuiClientTypes.ExecutionError;

/**
 * A context whose `submit` answers each transaction from `answer`, given its
 * record keys, and records what it was asked to send.
 */
function context(answer: (keys: readonly string[]) => AttemptResult<null>) {
  const sent: string[][] = [];
  const intents: unknown[] = [];
  const value = {
    async submit(submission: Submission<null>) {
      sent.push([...submission.recordKeys]);
      intents.push(submission.intent);
      return answer(submission.recordKeys);
    },
  } as unknown as JobContext;
  return { context: value, sent, intents };
}

const steps = { beforeSubmit: async () => true, reconcile: async () => null };
const executed: AttemptResult<null> = { outcome: "executed", digest: "D", reconciled: null };

test("records that all succeed go in one transaction, its intent their intents in command order", async () => {
  const items = [record("a"), record("b", 2), record("c")];
  const { context: ctx, sent, intents } = context(() => executed);
  const outcomes = await simulateSignSendBatch(ctx, items, steps);
  assert.deepEqual(sent, [["a", "b", "c"]]);
  assert.deepEqual(intents, [{ records: ["a", "b", "c"] }]);
  assert.deepEqual(items.map((item) => outcomes.get(item)?.blame), ["none", "none", "none"]);
});

test("a simulation failing in a record's commands drops that record and simulates the rest again", async () => {
  // Commands: a = 0, b = 1-2 (two commands), c = 3. The failure is in b's second command.
  const items = [record("a"), record("b", 2), record("c")];
  const { context: ctx, sent } = context((keys) =>
    keys.includes("b") ? { outcome: "simulation-failed", digest: null, reconciled: null, simulationError: error(2) } : executed,
  );
  const outcomes = await simulateSignSendBatch(ctx, items, steps);
  assert.deepEqual(sent, [["a", "b", "c"], ["a", "c"]]);
  assert.equal(outcomes.get(items[1]!)?.attempt.outcome, "simulation-failed");
  assert.equal(outcomes.get(items[1]!)?.blame, "this");
  assert.equal(outcomes.get(items[0]!)?.attempt.outcome, "executed");
  assert.equal(outcomes.get(items[2]!)?.attempt.outcome, "executed");
});

test("a simulation failure that names no command sends each record alone", async () => {
  const items = [record("a"), record("b"), record("c")];
  const { context: ctx, sent } = context((keys) =>
    keys.length > 1 || keys[0] === "b"
      ? { outcome: "simulation-failed", digest: null, reconciled: null, simulationError: error() }
      : executed,
  );
  const outcomes = await simulateSignSendBatch(ctx, items, steps);
  assert.deepEqual(sent, [["a", "b", "c"], ["a"], ["b"], ["c"]]);
  assert.deepEqual(items.map((item) => [outcomes.get(item)?.attempt.outcome, outcomes.get(item)?.blame]), [
    ["executed", "none"],
    ["simulation-failed", "this"],
    ["executed", "none"],
  ]);
});

test("a transaction that fails on chain blames the record whose command failed; the others rode along", async () => {
  const items = [record("a"), record("b"), record("c", 2)];
  const failed = (command?: number): AttemptResult<null> => ({ outcome: "failed", digest: "F", reconciled: null, executionError: error(command) });
  const named = await simulateSignSendBatch(context(() => failed(3)).context, items, steps);
  assert.deepEqual(items.map((item) => named.get(item)?.blame), ["another", "another", "this"]);
  // No command named: nobody is blamed, and every record failed.
  const unnamed = await simulateSignSendBatch(context(() => failed()).context, items, steps);
  assert.deepEqual(items.map((item) => unnamed.get(item)?.blame), ["none", "none", "none"]);
});

test("a batch not worth its gas drops its last record and tries again", async () => {
  const items = [record("high"), record("mid"), record("low")];
  const { context: ctx, sent } = context((keys) =>
    keys.length > 2 ? { outcome: "not-submitted", reason: "not-admitted", digest: null, reconciled: null } : executed,
  );
  const outcomes = await simulateSignSendBatch(ctx, items, steps);
  assert.deepEqual(sent, [["high", "mid", "low"], ["high", "mid"]]);
  assert.equal(outcomes.get(items[2]!)?.attempt.reason, "not-admitted");
  assert.equal(outcomes.get(items[0]!)?.attempt.outcome, "executed");
});

test("chunks splits in order, the last one shorter", () => {
  assert.deepEqual(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunks([], 3), []);
});
