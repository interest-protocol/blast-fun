import assert from "node:assert/strict";
import test from "node:test";
import { fixtureList } from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import { calendarDate, calendarEvents, calendarHeading, calendarTarget, eventsInRange, utcDayStartMs } from "./calendar-model.ts";
import { readCalendarPages } from "./calendar-pages.ts";
import { discoveryPath, discoveryState } from "./discovery-state.ts";

const sale = fixtureList("live", "ending").presales[0]!;
const now = Date.UTC(2026, 11, 31, 23, 59, 30);

test("ranges compare complete event timestamps and ignore lifecycle, deduplicate sales, and omit unset dates", () => {
  const before = { ...sale, start_ms: now - 1, end_ms: now };
  const future = { ...sale, phase: "pending" as const, presale_id: "future", start_ms: now + 1, end_ms: now + 60_000 };
  const undated = { ...sale, presale_id: "undated", start_ms: 0, end_ms: 0 };
  const events = calendarEvents([future, before, before, undated]);
  assert.deepEqual(events.map((e) => e.at), [now - 1, now, now + 1, now + 60_000]);
  assert.equal(eventsInRange(events, "past", now).length, 1);
  assert.equal(eventsInRange(events, "upcoming", now).length, 3);
  assert.equal(eventsInRange(events, "all", now).length, 4);
  assert.equal(eventsInRange(events, "past", now + 2).length, 3);
});

test("UTC dates and headings cross midnight, month and year without depending on the host timezone", () => {
  const tomorrow = Date.UTC(2027, 0, 1);
  assert.equal(utcDayStartMs(now), Date.UTC(2026, 11, 31));
  assert.match(calendarDate(tomorrow, now), /^Tomorrow · Friday, January 1, 2027$/);
  assert.doesNotMatch(calendarDate(tomorrow, tomorrow), /Tomorrow/);
  const events = calendarEvents([{ ...sale, start_ms: now, end_ms: tomorrow }]);
  assert.equal(calendarHeading(events), "Dec ’26 – Jan ’27");
  assert.equal(calendarHeading(events.slice(0, 1)), "Dec ’26");
  assert.equal(calendarHeading([]), "Schedule");
});

test("financial targets retain every digit and original unit", () => {
  assert.equal(calendarTarget({ ...sale, target_atoms: "1234567890123456789123456789", quote_decimals: 9, quote_symbol: "SUI" }), "1,234,567,890,123,456,789.123456789 SUI");
  assert.equal(calendarTarget({ ...sale, target_atoms: "400000120001", quote_decimals: 6, quote_symbol: "USDC" }), "400,000.120001 USDC");
});

test("calendar range round-trips independently of lifecycle and defaults to Upcoming", () => {
  for (const calendarRange of ["upcoming", "past", "all"] as const) {
    const state = discoveryState({ view: "calendar", status: "ended", calendarRange });
    const params = Object.fromEntries(new URL(discoveryPath(state), "https://blast.fun").searchParams);
    assert.deepEqual(discoveryState(params), state);
    assert.equal(state.status, "ended");
  }
  assert.equal(discoveryState({ view: "calendar", calendarRange: "invalid", status: "ended" }).calendarRange, "upcoming");
});

test("calendar reads every page and rejects failed or non-advancing pagination", async () => {
  const first = { ...fixtureList("live", "ending"), presales: [sale], next_cursor: "next" };
  const cursors: (string | null)[] = [];
  const page = await readCalendarPages(async (cursor) => {
    cursors.push(cursor);
    return cursor === null ? first : { ...first, presales: [{ ...sale, presale_id: "second" }], next_cursor: null };
  });
  assert.deepEqual(cursors, [null, "next"]);
  assert.equal(page.presales.length, 2);
  assert.equal(page.next_cursor, null);
  await assert.rejects(readCalendarPages(async () => first), /did not advance/);
  await assert.rejects(readCalendarPages(async (cursor) => { if (cursor) throw new Error("offline"); return first; }), /offline/);
});
