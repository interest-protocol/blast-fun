import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decimal,
  compact,
  timestamp,
  day,
  utc,
  chartRows,
} from "../public/format.js";

test("financial displays and copies retain exact decimals while only normalized chart coordinates use Number", () => {
  assert.equal(
    decimal("9007199254740993.123456789012345678"),
    "9,007,199,254,740,993.123456789012345678",
  );
  assert.equal(decimal("42"), "42");
  assert.equal(compact("0.000000000000000001", true), "<$0.01");
  assert.equal(compact("0.001", true), "<$0.01");
  assert.equal(compact("0", true), "$0.00");
  assert.equal(compact("0.000", true), "$0.00");
  assert.equal(compact("1.001", true), "$1.00");
  assert.equal(compact("0.001"), "0");
  assert.equal(compact("1.123456789", true), "$1.12");
  assert.equal(compact("0.1000001", true), "$0.10");
  assert.equal(compact("42"), "42");
  assert.equal(compact("1000000", true), "$1.0M");
  assert.equal(compact("1000000"), "1.0M");
  assert.equal(compact("2500000000", true), "$2.5B");
  assert.equal(compact("3000000000000", true), "$3.0T");
  assert.equal(compact("9007199254740993.123456789", true), "$9.0P");
  assert.equal(compact("1000000000000000000", true), "$1.0 quintillion");
  assert.equal(compact("999999999999999999999", true), "$999.9 quintillion");
  assert.equal(compact("1".repeat(100), true), "$100 digits · inspect");
  assert.equal(compact("1".repeat(100)), "100 digits · inspect");
  assert.deepEqual(
    chartRows([
      { day_ms: "0", priced_usd: "9007199254740993.123456789012345678" },
      {
        day_ms: "86400000",
        priced_usd: "18014398509481986.246913578024691356",
      },
    ]),
    [
      { time: 0, value: 0.5 },
      { time: 86400, value: 1 },
    ],
  );
  assert.equal(timestamp("9223372036854775807"), null);
  assert.equal(timestamp("253402300799999"), 253402300799999);
  assert.equal(timestamp("+1"), null);
  assert.equal(timestamp("1x"), null);
  assert.equal(day("0"), "1970-01-01");
  assert.equal(utc("0"), "1 Jan 1970, 00:00 UTC");
  assert.equal(
    utc("9223372036854775807"),
    "9223372036854775807 ms since Unix epoch",
  );
  assert.equal(
    day("9223372036854775807"),
    "9223372036854775807 ms since Unix epoch",
  );
  assert.equal(
    chartRows([{ day_ms: "9223372036854775807", priced_usd: "1" }]),
    null,
  );
  assert.equal(
    chartRows([
      { day_ms: "0", priced_usd: "1" },
      { day_ms: "9223372036854775807", priced_usd: "1" },
    ]),
    null,
  );
  assert.equal(
    chartRows([
      { day_ms: "0", priced_usd: "1" },
      { day_ms: "0", priced_usd: "2" },
    ]),
    null,
  );
  assert.deepEqual(
    chartRows([
      { day_ms: "86400000", priced_usd: "0.3" },
      { day_ms: "0", priced_usd: "0.600" },
    ]),
    [
      { time: 0, value: 1 },
      { time: 86400, value: 0.5 },
    ],
  );
  assert.deepEqual(chartRows([{ day_ms: "0", priced_usd: "0" }]), [
    { time: 0, value: 0 },
  ]);
  assert.deepEqual(
    chartRows([
      { day_ms: "0", priced_usd: "0.600" },
      { day_ms: "86400000", priced_usd: "0.3" },
    ]),
    [
      { time: 0, value: 1 },
      { time: 86400, value: 0.5 },
    ],
  );
});
