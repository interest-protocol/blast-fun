import assert from "node:assert/strict";
import test from "node:test";
import { notificationArrivals } from "./notification-arrivals.ts";

test("the first answer is the starting point; a higher newest ID is one arrival", () => {
  const receive = notificationArrivals();
  assert.equal(receive("9007199254740993", true), false, "the first answer only sets the starting point");
  assert.equal(receive("9007199254740993", true), false);
  assert.equal(receive("9007199254740995", true), true, "beyond 2^53 the IDs still compare exactly");
  assert.equal(receive("9007199254740995", true), false, "the same alert never pops twice");
  assert.equal(receive("9007199254740994", true), false, "reading the newest alert lowers the ID: no arrival");
  assert.equal(receive(null, true), false, "clearing every alert is no arrival");
  assert.equal(receive("9007199254740995", true), false, "clearing does not forget what was seen");
  assert.equal(receive("9007199254740996", true), true);
  assert.equal(receive("invalid", true), false);
  assert.equal(receive("9223372036854775808", true), false, "an ID past the BIGINT range is ignored");
});

test("with nothing unread at first, the first alert still pops", () => {
  const receive = notificationArrivals();
  assert.equal(receive(null, true), false);
  assert.equal(receive("1", true), true);
});

test("a silent answer (hidden tab, return, remount) moves the starting point without a pop", () => {
  const receive = notificationArrivals();
  receive("1", false);
  assert.equal(receive("3", false), false);
  assert.equal(receive("3", true), false, "an alert that came while hidden does not pop on return");
  assert.equal(receive("4", true), true);
});
