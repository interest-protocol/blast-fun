import assert from "node:assert/strict";
import test from "node:test";

import { HOME_ROWS_DEFAULT, homeRowsCookieLine, homeRowsCookieValue, isRowsChoice, parseHomeRows } from "./home-rows";
import { pageItems } from "#web/components/blast-ui/pager-model.ts";

test("rows per page: 5, 10, or 20 out of the cookie; anything else is the default", () => {
  assert.equal(parseHomeRows(null), 10);
  assert.equal(parseHomeRows("5"), 5);
  assert.equal(parseHomeRows("10"), 10);
  assert.equal(parseHomeRows("20"), 20);
  assert.equal(parseHomeRows("7"), HOME_ROWS_DEFAULT);
  for (const bad of ["50", "0", "51", "1.5", "ten", "", "007"]) assert.equal(parseHomeRows(bad), HOME_ROWS_DEFAULT, bad);
  assert.equal(isRowsChoice(20), true);
  assert.equal(isRowsChoice(7), false);
  assert.equal(homeRowsCookieValue("a=1; blast.home.rows=20; b=2"), "20");
  assert.equal(homeRowsCookieValue("a=1"), null);
  assert.equal(homeRowsCookieLine(20, true), "blast.home.rows=20; Max-Age=31536000; Path=/; SameSite=Lax; Secure");
  // Explicit default choices persist across future default changes.
  assert.equal(homeRowsCookieLine(HOME_ROWS_DEFAULT, false), "blast.home.rows=10; Max-Age=31536000; Path=/; SameSite=Lax");
});

test("the pager draws every page up to seven, then the ends and the current page's neighbours with gaps", () => {
  assert.deepEqual(pageItems(1, 1), [1]);
  assert.deepEqual(pageItems(3, 7), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(pageItems(1, 12), [1, 2, 3, 4, null, 12]);
  assert.deepEqual(pageItems(6, 12), [1, null, 5, 6, 7, null, 12]);
  assert.deepEqual(pageItems(12, 12), [1, null, 9, 10, 11, 12]);
  assert.deepEqual(pageItems(2, 12), [1, 2, 3, 4, null, 12]);
});
