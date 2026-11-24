import assert from "node:assert/strict";
import test from "node:test";
import { CARD_PAGE_MAX_BYTES, parseCardPage } from "./page.ts";

const id = "01234567-89ab-4cde-8fab-0123456789ab";
const page = { cardId: id, callsign: "A.B-c", crew: 1, recruitTotal: 0 };

test("card page accepts only its minimal published identity, including original MC callsigns", () => {
  assert.deepEqual(parseCardPage(JSON.stringify(page), id.toUpperCase()), page);
  assert.equal(parseCardPage("null", id), null);
});

test("card page refuses private fields, wrong identities, malformed ranges and oversized wire bodies", () => {
  for (const value of [
    [],
    1,
    {},
    { ...page, avatar: "private" },
    { ...page, cardId: "different" },
    { ...page, callsign: "@bad" },
    { ...page, crew: 0 },
    { ...page, crew: 1000000 },
    { ...page, recruitTotal: -1 },
    { ...page, recruitTotal: 0.5 },
  ])
    assert.throws(() => parseCardPage(JSON.stringify(value), id));
  assert.throws(() =>
    parseCardPage(" ".repeat(CARD_PAGE_MAX_BYTES) + "null", id),
  );
  assert.throws(() => parseCardPage("{", id));
});
