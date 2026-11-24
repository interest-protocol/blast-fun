import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { QueryResult } from "pg";

import type { TransactionContext } from "@blast/core/modules/database/transaction.ts";
import { OperatorAuthenticator } from "@blast/server/modules/mission-control/operator/auth.ts";
import { OperatorError } from "@blast/server/modules/mission-control/operator/errors.ts";
import { SOCIAL_OPERATOR_COMMANDS } from "./commands.ts";
import { parseCoinTrustChange } from "./coin-trust.ts";
import {
  parseSocialOperatorInvocation,
  runSocialOperatorInvocation,
  socialOperatorCommand,
} from "./framework.ts";

const TOKEN = "social-operator-unit-token-of-32-characters";
const operator = new OperatorAuthenticator({
  operatorId: "ops.jose",
  tokenHash: createHash("sha256").update(TOKEN).digest("hex"),
}).authenticate("ops.jose", TOKEN);

function code(error: unknown): string | undefined {
  return error instanceof OperatorError ? error.code : undefined;
}

function parse(...argv: string[]) {
  return parseSocialOperatorInvocation(argv, SOCIAL_OPERATOR_COMMANDS);
}

test("T-003-AC-1 invocations parse into a command and validated input", () => {
  const set = parse("config", "set", "big_commit_usd", "2500", "--reason", "raise the bar");
  assert.equal(set.command.path.join(" "), "config set");
  assert.deepEqual(set.input, { key: "big_commit_usd", value: "2500" });
  assert.equal(set.reason, "raise the bar");

  assert.deepEqual(parse("config", "get").input, { key: null });
  assert.deepEqual(parse("config", "get", "reactions").input, { key: "reactions" });
  assert.deepEqual(parse("terms", "add", "MOON").input, { term: "moon" });
  assert.deepEqual(parse("terms", "remove", "moon").input, { term: "moon" });
  assert.deepEqual(parse("terms", "list").input, {});
  assert.equal(parse("terms", "list").reason, null);
});

const SALE = `0x${"ab".repeat(32)}`;

test("R3-23 sale trust: set and clear take one sale, the audited flag and a required reason; list and history page by keyset", () => {
  const set = parse("sale", "trust", "set", SALE.toUpperCase().replace("0X", "0x"), "--audited", "--reason", "read the report");
  assert.equal(set.command.path.join(" "), "sale trust set");
  assert.deepEqual(set.input, { presaleId: SALE, flags: ["audited"] });
  assert.equal(set.reason, "read the report");
  assert.deepEqual(parse("sale", "trust", "clear", SALE, "--reason", "wrong commit", "--audited").input, { presaleId: SALE, flags: ["audited"] });
  assert.equal(parse("sale", "trust", "clear", SALE, "--audited", "--reason", "x").command.path.join(" "), "sale trust clear");
  assert.deepEqual(parse("sale", "trust", "list").input, { after: null, limit: 50 });
  assert.deepEqual(parse("sale", "trust", "list", "--after", SALE, "--limit", "200").input, { after: SALE, limit: 200 });
  assert.deepEqual(parse("sale", "trust", "history", SALE).input, { presaleId: SALE, before: null, limit: 50 });
  const logId = "0b5e2f9a-3c1d-4e7f-8a9b-0c1d2e3f4a5b";
  assert.deepEqual(parse("sale", "trust", "history", SALE, "--before", logId, "--limit", "5").input, { presaleId: SALE, before: logId, limit: 5 });

  const refused = [
    // Jose 2026-11-21: the verified mark is set and cleared only on the admin website.
    ["sale", "trust", "set", SALE, "--verified", "--reason", "met the founders on a call"],
    ["sale", "trust", "clear", SALE, "--verified", "--reason", "team changed"],
    ["sale", "trust", "set", SALE, "--audited", "--verified", "--reason", "both"],
    // No reason: a judgement is never changed without saying why (reasonRequired).
    ["sale", "trust", "set", SALE, "--audited"],
    ["sale", "trust", "clear", SALE, "--audited"],
    ["sale", "trust", "set", SALE, "--audited", "--reason"],
    // No flag, an unknown or repeated flag, a malformed sale, a stray argument.
    ["sale", "trust", "set", SALE, "--reason", "x"],
    ["sale", "trust", "set", SALE, "--lp", "--reason", "x"],
    // OA-26: the LP lock is protocol-wide, so no operator records it.
    ["sale", "trust", "set", SALE, "--lp-locked", "--reason", "x"],
    ["sale", "trust", "clear", SALE, "--lp-locked", "--reason", "x"],
    ["sale", "trust", "set", SALE, "--audited", "--audited", "--reason", "x"],
    ["sale", "trust", "set", "0xabc", "--audited", "--reason", "x"],
    ["sale", "trust", "set", "--audited", "--reason", "x"],
    ["sale", "trust", "set", SALE, "--audited", "true", "--reason", "x"],
    ["sale", "trust", "list", "--limit", "0"],
    ["sale", "trust", "list", "--limit", "201"],
    ["sale", "trust", "list", "--after", "0x1"],
    ["sale", "trust", "list", "--after", SALE, "--after", SALE],
    ["sale", "trust", "list", "extra"],
    ["sale", "trust", "history"],
    ["sale", "trust", "history", SALE, "--before", "not-a-log-id"],
    ["sale", "trust", "history", SALE, "--limit"],
    ["sale", "trust", "delete", SALE],
  ];
  for (const argv of refused) {
    assert.throws(() => parse(...argv), (error) => code(error) === "OPERATOR_INPUT_INVALID", argv.join(" "));
  }
});

test("R3-23 coin trust: the CLI lists and reads history only; a coin type is read in its canonical form", () => {
  const coin = `0x${"cd".repeat(32)}::meme::MEME`;
  assert.deepEqual(parseCoinTrustChange(["0xCDcd" + "cd".repeat(30) + "::meme::MEME"]), { coinType: coin });
  assert.deepEqual(parseCoinTrustChange(["0x2::sui::SUI"]), { coinType: `0x${"0".repeat(63)}2::sui::SUI` });
  for (const args of [[], ["not-a-type"], ["0x2::sui"], [coin, coin]]) assert.equal(parseCoinTrustChange(args), null, args.join(" "));
  assert.deepEqual(parse("coin", "trust", "list", "--after", coin, "--limit", "10").input, { after: coin, limit: 10 });
  assert.deepEqual(parse("coin", "trust", "history", coin).input, { coinType: coin, before: null, limit: 50 });
  const refused = [
    // Jose 2026-11-21: the verified mark is set and cleared only on the admin website.
    ["coin", "trust", "set", coin, "--reason", "met the team"],
    ["coin", "trust", "clear", coin, "--reason", "team changed"],
    ["coin", "trust", "list", "--after", "0x1"],
    ["coin", "trust", "history", coin, "--before", "nope"],
  ];
  for (const argv of refused) {
    assert.throws(() => parse(...argv), (error) => code(error) === "OPERATOR_INPUT_INVALID", argv.join(" "));
  }
});

test("R3-23 reasonRequired is enforced by the framework for any command that declares it", () => {
  const judged = socialOperatorCommand<Record<string, never>>({
    path: ["judge"],
    usage: "judge --reason <text>",
    reasonRequired: true,
    parse: (args) => (args.length === 0 ? {} : null),
    run: async () => ({ result: null, log: { action: "judge", target: "*", before: null, after: null } }),
  });
  assert.throws(() => parseSocialOperatorInvocation(["judge"], [judged]), (error) => code(error) === "OPERATOR_INPUT_INVALID");
  assert.equal(parseSocialOperatorInvocation(["judge", "--reason", "because"], [judged]).reason, "because");
});

test("T-003-AC-1 unknown commands, keys, wrong types and stray arguments are refused", () => {
  const refused = [
    [],
    ["config"],
    ["config", "delete", "big_commit_usd"],
    ["config", "set", "nope", "1"],
    ["config", "set", "big_commit_usd", "abc"],
    ["config", "set", "big_commit_usd"],
    ["config", "set", "big_commit_usd", "1", "2"],
    ["config", "set", "reactions", "fire,fire"],
    ["config", "get", "nope"],
    ["terms", "add"],
    ["terms", "add", "  "],
    ["terms", "list", "extra"],
    ["terms", "add", "moon", "--reason"],
    ["terms", "add", "moon", "--reason", "a", "--reason", "b"],
    ["terms", "add", "moon", "--reason", "x".repeat(501)],
    ["moderate", "hide", "x"],
  ];
  for (const argv of refused) {
    assert.throws(() => parse(...argv), (error) => code(error) === "OPERATOR_INPUT_INVALID", argv.join(" "));
  }
});

type Statement = { kind: "read" | "write"; table?: string; text: string; values: readonly unknown[] };

function recordingTransaction(statements: Statement[]): TransactionContext {
  const result = (rows: unknown[] = []) =>
    Promise.resolve({ rows, rowCount: rows.length, command: "", oid: 0, fields: [] } as unknown as QueryResult);
  const read = (text: string, values: readonly unknown[] = []) => {
    statements.push({ kind: "read", text, values });
    return result();
  };
  return {
    read,
    forModule: (moduleName) => ({
      moduleName,
      read,
      write: (table: string, text: string, values: readonly unknown[] = []) => {
        statements.push({ kind: "write", table, text, values });
        return result(table === "social_operator_log" ? [{ log_id: "log-1" }] : []);
      },
    }),
  } as TransactionContext;
}

test("T-003-AC-3 a successful command appends exactly one operator-log row in its transaction", async () => {
  const statements: Statement[] = [];
  const invocation = parse("config", "set", "big_commit_usd", "2500", "--reason", "raise the bar");
  const outcome = await runSocialOperatorInvocation(invocation, operator, (operation) =>
    operation(recordingTransaction(statements)));

  assert.deepEqual(outcome, {
    command: "config set",
    logId: "log-1",
    result: { key: "big_commit_usd", before: "1000", after: "2500" },
  });
  const logs = statements.filter((statement) => statement.table === "social_operator_log");
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0].values, ["ops.jose", "config.set", "big_commit_usd", '"1000"', '"2500"', "raise the bar"]);
  assert.equal(statements.at(-1), logs[0], "the log row is the transaction's last statement");
});

test("T-003-AC-3 a command that fails writes no log row", async () => {
  const statements: Statement[] = [];
  const failing = socialOperatorCommand<null>({
    path: ["fail"],
    usage: "fail",
    parse: () => null,
    run: async () => {
      throw new OperatorError("OPERATOR_TARGET_NOT_FOUND");
    },
  });
  await assert.rejects(
    runSocialOperatorInvocation({ command: failing, input: null, reason: null }, operator, (operation) =>
      operation(recordingTransaction(statements))),
    (error) => code(error) === "OPERATOR_TARGET_NOT_FOUND",
  );
  assert.equal(statements.length, 0);
});
