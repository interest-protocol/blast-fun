import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
// eslint-disable-next-line no-restricted-imports -- Proof-only import of the actual API; runtime imports only its generated pure contract.
import { createAnalyticsHandler } from "../../../workers/src/modules/analytics/api.ts";
import { summaryEnvelope, createSummaryReader } from "../src/summary.ts";
import { payload, token, serve } from "./fixture.ts";

test("the generated server-only schema is byte-identical and accepts the actual current API response", async () => {
  assert.equal(
    await readFile(
      new URL("../generated/aggregate-contract.ts", import.meta.url),
      "utf8",
    ),
    await readFile(
      new URL(
        "../../../workers/src/modules/analytics/contract.ts",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const fixture = await serve(() =>
    createAnalyticsHandler(token, async () => ({
      generated_at: new Date(),
      payload: payload(),
    })),
  );
  try {
    const read = createSummaryReader(fixture.origin, token, {
      development: true,
    });
    const data = await read();
    assert.equal(data.version, 2);
    assert.equal(data.accountActivity, null);
    assert.equal(
      data.totals.trade_volume?.pricedUsd,
      "9007199254740993.123456789012345678",
    );
    assert.equal(
      summaryEnvelope.safeParse({ ...data, rawAccount: "private" }).success,
      false,
    );
    assert.equal(
      summaryEnvelope.safeParse({
        ...data,
        users: { ...data.users, productDau: "1" },
      }).success,
      false,
    );
    assert.equal(
      summaryEnvelope.safeParse({ ...data, version: 3 }).success,
      false,
    );
    assert.equal(
      summaryEnvelope.safeParse({ ...data, asOfCheckpoint: 9007199254740992 })
        .success,
      false,
    );
    assert.equal(
      summaryEnvelope.safeParse({ ...data, quoteTotals: { SUI: 1 } }).success,
      false,
    );
    const missing = { ...data };
    Reflect.deleteProperty(missing, "pricingPolicy");
    assert.equal(summaryEnvelope.safeParse(missing).success, false);
  } finally {
    await fixture.close();
  }
});
