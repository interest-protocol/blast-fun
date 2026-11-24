import assert from "node:assert/strict";
import test from "node:test";
import { seriesChange } from "./series-change";

const first = { time: 60, close: 30 };
const last = { time: 120, close: 32 };
const history = [first, last];

test("an unchanged candle needs no write and the forming or next candle needs only a tail write", () => {
  assert.equal(seriesChange(history, history), "none");
  assert.equal(seriesChange(history, [{ ...first }, { ...last }]), "none");
  assert.equal(seriesChange(history, [first, { ...last, close: 33 }]), "tail");
  assert.equal(seriesChange(history, [first, last, { time: 180, close: 33 }]), "tail");
  assert.equal(seriesChange([], [first]), "tail");
});

test("a correction to history, a rescale, or a changed time window replaces data on the existing series", () => {
  assert.equal(seriesChange(undefined, history), "replace");
  assert.equal(seriesChange(history, [first]), "replace");
  assert.equal(seriesChange(history, [last]), "replace");
  assert.equal(seriesChange([], history), "replace");
  assert.equal(seriesChange(history, [first, { ...last, time: 180 }]), "replace");
  assert.equal(seriesChange(history, [{ ...first, close: 10 }, last]), "replace");
  assert.equal(seriesChange(history, [first, { ...last, close: 31 }, { time: 180, close: 33 }]), "replace");
  const colored = { ...first, color: "red" };
  assert.equal(seriesChange(history, [colored, last]), "replace");
});
