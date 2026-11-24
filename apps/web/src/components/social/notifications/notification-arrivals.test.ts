import assert from "node:assert/strict";
import test from "node:test";
import { notificationArrivals } from "./notification-arrivals.ts";

const rows = (...ids: string[]) => ids.map((id) => ({ id, read: false }));

test("first snapshot, counts/read changes, duplicate delivery and batches", () => {
  const receive = notificationArrivals();
  assert.equal(receive(rows("9007199254740993", "12"), true), false);
  assert.equal(receive(rows("9007199254740993", "12"), true), false);
  assert.equal(receive([{ id: "9007199254740993", read: true }], true), false);
  assert.equal(receive(rows("9007199254740995", "9007199254740996"), true), true);
  assert.equal(receive(rows("9007199254740996", "9007199254740995"), true), false);
  assert.equal(receive(rows("9007199254740994"), true), true, "out-of-order new deliveries remain identifiable");
  assert.equal(receive([], true), false);
  assert.equal(receive(rows("9007199254740996"), true), false, "clearing does not forget deliveries");
  assert.equal(receive(rows("10", "13"), true), false, "older rows exposed by filtering are not arrivals");
  assert.equal(receive(rows("invalid", "0", "9223372036854775808"), true), false);
});

test("a hidden/return/remount baseline consumes stale effects without replay", () => {
  const receive = notificationArrivals();
  receive(rows("1"), false);
  assert.equal(receive(rows("2", "3"), false), false);
  assert.equal(receive(rows("2", "3"), true), false);
  assert.equal(receive([{ id: "4", read: true }], true), false);
  assert.equal(receive(rows("4"), true), false, "read-state reversal is not delivery");
  assert.equal(receive(rows("5", "6"), true), true);
  receive([], false);
  assert.equal(receive(rows("5", "6"), true), false, "a sparse return snapshot cannot forget prior deliveries");
});
