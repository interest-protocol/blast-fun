import assert from "node:assert/strict";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import test from "node:test";
import { readCreationPolicy } from "./creation-policy.ts";
import { parsePresaleRuntimeIdentity } from "@blast/core/modules/presale/deployment/service.ts";
import { presaleIdentityFixture } from "../../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { readSuiQuotePrice } from "./quote-price.ts";

test("a failed quote source returns unavailable and records a safe failure", async (t) => {
  const previous = process.env.MISSION_CONTROL_METRICS;
  process.env.MISSION_CONTROL_METRICS = "on";
  t.after(() => {
    if (previous === undefined) delete process.env.MISSION_CONTROL_METRICS;
    else process.env.MISSION_CONTROL_METRICS = previous;
  });
  const records: Record<string, unknown>[] = [];
  t.mock.method(console, "info", (line: string) => {
    records.push(JSON.parse(line));
  });
  const source = {
    read: async () => {
      throw new Error("private database endpoint");
    },
  };
  assert.equal(await readSuiQuotePrice(source), null);
  const identity = parsePresaleRuntimeIdentity(presaleIdentityFixture(), {
    production: false,
  });
  assert.equal(
    await readCreationPolicy(() => {
      throw new Error("private policy endpoint");
    }, identity),
    null,
  );
  assert.deepEqual(
    records
      .filter((record) => record.metric === "social.source")
      .map(({ source, outcome, error }) => ({ source, outcome, error })),
    [
      { source: "sui_quote_price", outcome: "unavailable", error: "Error" },
      { source: "creation_policy", outcome: "unavailable", error: "Error" },
    ],
  );
  assert.equal(JSON.stringify(records).includes("private database endpoint"), false);
});

test("quote reads initialize their pool and fail closed on connection errors", async () => {
  assert.deepEqual(
    await readSuiQuotePrice(
      () =>
        ({
          read: async () => ({ rows: [{ usd_price: "3.42", as_of_ms: "42" }] }),
        }) as unknown as ReadableDatabase,
    ),
    { usd_price: "3.42", as_of_ms: 42 },
  );
  assert.equal(
    await readSuiQuotePrice(() => {
      throw new Error("pool unavailable");
    }),
    null,
  );
});
