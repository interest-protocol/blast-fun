import assert from "node:assert/strict";
import test from "node:test";
import { compareAvailablePageSize, comparePage, comparePageSize } from "./compare-layout";

test("Compare fits four only with room for four trade footers and pages smaller desktops", () => {
  assert.equal(comparePageSize(1414, 1120, true), 4);
  assert.equal(comparePageSize(1414, 900, true), 2);
  assert.equal(comparePageSize(1414, 600, true), 2);
  assert.equal(comparePageSize(1054, 900, true), 1);
  assert.equal(comparePageSize(1054, 900, false), 2);
  assert.deepEqual(comparePage(["A", "B", "C", "D"], "D", 2), { start: 2, ids: ["C", "D"] });
  assert.deepEqual(comparePage(["A", "B", "C"], "C", 2), { start: 2, ids: ["C"] });
});

test("measured workspace dimensions decide capacity, including 1920x1080", () => {
  assert.equal(comparePageSize(1920,1080,true),4);
  assert.equal(comparePageSize(1230,593,true),2);
  assert.equal(compareAvailablePageSize(743,1080),1);
  assert.equal(compareAvailablePageSize(744,1080),4);
  assert.equal(compareAvailablePageSize(1500,915),2);
  assert.equal(compareAvailablePageSize(1500,916),4);
});
