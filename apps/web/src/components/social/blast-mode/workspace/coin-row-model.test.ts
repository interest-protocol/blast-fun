import assert from "node:assert/strict";
import test from "node:test";
import { ecosystemSlot } from "./coin-row-model";

test("ecosystem coins join the page that holds the ranked boundary, never past the last page", () => {
  // [page, ranked, total] at 10 rows a page -> the page's index, or null on every other page.
  const slots = (ranked: number, total: number) =>
    Array.from({ length: Math.max(1, Math.ceil(total / 10)) }, (_, index) => {
      const page = index + 1;
      return ecosystemSlot("trending", { page, total, ranked }, 10, Math.min(10, total - index * 10));
    });
  assert.deepEqual(slots(0, 25), [0, null, null], "no ranked coin: first on page 1");
  assert.deepEqual(slots(4, 25), [4, null, null], "mid-page");
  assert.deepEqual(slots(10, 25), [null, 0, null], "exactly one page ranked: first on page 2");
  assert.deepEqual(slots(20, 25), [null, null, 0], "a multiple of the page");
  assert.deepEqual(slots(13, 13), [null, 3], "every coin ranked: after the last");
  assert.deepEqual(slots(20, 20), [null, 10], "ranked coins fill every page: end of the last page");
  assert.deepEqual(slots(0, 0), [0], "no Blast coin at all");
  // New: after every Blast coin, launch time or not (standalone vault coins have none), so by `total`; `ranked` plays no part.
  const newest = (total: number, ranked?: number) =>
    Array.from({ length: Math.max(1, Math.ceil(total / 10)) }, (_, index) =>
      ecosystemSlot("newest", { page: index + 1, total, ...(ranked === undefined ? {} : { ranked }) }, 10, Math.min(10, total - index * 10)));
  assert.deepEqual(newest(15, 12), [null, 5], "12 sale coins and 3 standalone coins: after all 15");
  assert.deepEqual(newest(3), [3], "New needs no server count");
  assert.deepEqual(newest(20), [null, 10], "New fills every page: end of the last page");
  assert.equal(ecosystemSlot("held", { page: 1, total: 3, ranked: 0 }, 10, 3), null, "other sorts list Blast coins only");
  assert.equal(ecosystemSlot("trending", { page: 1, total: 25, ranked: 8 }, 10, 5), 5, "a short page clamps to its rows");
  assert.equal(ecosystemSlot("trending", { page: 1, total: 3 }, 10, 3), null, "a page without the server's count places none");
});
