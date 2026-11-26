import assert from "node:assert/strict";
import test from "node:test";
import type { Snapshot } from "../../../../packages/core/src/modules/defillama/contracts.ts";
import { FeeSummaryUnavailable } from "../../../../packages/core/src/modules/defillama/daily-fees.ts";
import { failureLine, publishHours, type HourSteps } from "../../scripts/defillama-publish.ts";

const first = Date.parse("2026-11-24T16:00:00Z") / 1000;
const hours = [first, first + 3600, first + 7200];

test("a scheduled run skips an hour it cannot summarize and publishes the later ones", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const published: number[] = [];
  const bases: (string | undefined)[] = [];
  const steps: HourSteps = {
    replayBase: async () => undefined,
    collect: async (start, base) => {
      bases.push(base?.source.digest);
      const replay = { tickets: [], launches: [], vaults: [] };
      return { start_timestamp: start, source: { digest: `cut-${start}` }, contracts: [], native_replay: replay } as unknown as Snapshot;
    },
    publish: async ({ start_timestamp }) => {
      if (start_timestamp === hours[1]) {
        throw new FeeSummaryUnavailable("frontend_fee_source_incomplete");
      }
      published.push(start_timestamp);
    },
  };

  await publishHours(steps, hours, true);
  assert.deepEqual(published, [hours[0], hours[2]]);
  // The hour after a skipped one still replays from the skipped hour's cut.
  assert.deepEqual(bases, [undefined, `cut-${hours[0]}`, `cut-${hours[1]}`]);
  assert.deepEqual(
    warn.mock.calls.map((call) => call.arguments),
    [["skipped hour 2026-11-24T17:00:00.000Z: frontend_fee_source_incomplete"]],
  );
  // Manual runs and every other failure still stop the run.
  await assert.rejects(publishHours(steps, hours, false), FeeSummaryUnavailable);
  const broken = { ...steps, collect: async () => Promise.reject(new Error("Launch history is incomplete")) };
  await assert.rejects(publishHours(broken, hours, true), /Launch history is incomplete/);
});

test("failure lines show our own messages and hide driver and URL details", () => {
  assert.equal(
    failureLine(new Error("Native ingestion has not completed the interval")),
    "DefiLlama publication failed: Native ingestion has not completed the interval",
  );
  assert.equal(
    failureLine(new FeeSummaryUnavailable("frontend_fee_policy_incomplete")),
    "DefiLlama publication failed: DefiLlama fees cannot be summarized: frontend_fee_policy_incomplete",
  );
  for (const error of [
    Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED" }),
    new TypeError("Invalid URL postgres://user:secret@db/blast"),
    new Error("bad target postgres://user:secret@db/blast"),
  ]) {
    assert.doesNotMatch(failureLine(error), /secret|ECONNREFUSED|10\.0\.0\.1/);
  }
});
