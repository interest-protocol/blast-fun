import assert from "node:assert/strict";
import test from "node:test";
import { discoveryPath, discoveryState } from "./discovery-state.ts";
import { orderWatched } from "./watched-model.ts";
import { fixtureList } from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";

test("scope and sorting round-trip independently through every lifecycle and view", () => {
  for (const status of ["live", "upcoming", "ended"] as const) {
    for (const scope of ["all", "watch", "following"] as const) {
      for (const view of ["list", "calendar", "backed"] as const) {
        for (const layout of ["cards", "list"] as const) {
          const state = discoveryState({ status, scope, view, layout, sort: status === "upcoming" ? "interest" : "backed" });
          const params = Object.fromEntries(new URL(discoveryPath(state), "https://blast.fun").searchParams);
          assert.deepEqual(discoveryState(params), state);
        }
      }
    }
  }
  assert.equal(discoveryState({}).sort, "pinned");
  assert.equal(discoveryPath(discoveryState({})), "/presale");
  assert.equal(discoveryPath(discoveryState({ sort: "ending" })), "/presale?sort=ending");
  assert.equal(discoveryState({ scope: "watch", sort: "pinned" }).sort, "ending");
  assert.deepEqual(discoveryState({ status: "invalid", sort: "fastest", scope: "invalid", view: "invalid" }), discoveryState({}));
  assert.equal(discoveryState({ view: "mine" }).view, "list");
});

test("legacy watch and following links retain their personal scope", () => {
  assert.equal(discoveryPath(discoveryState({ sort: "watch" })), "/presale?scope=watch");
  assert.equal(discoveryPath(discoveryState({ status: "ended", sort: "following" })), "/presale?status=ended&scope=following");
});

test("Calendar-only ranges are ignored and omitted outside Calendar without changing Browse preferences", () => {
  for (const view of ["list", "backed", "invalid"]) {
    for (const calendarRange of ["upcoming", "past", "all"]) {
      const preferences = { status: "ended", sort: "best", scope: "watch", layout: "list", view };
      const expected = discoveryState(preferences);
      assert.deepEqual(discoveryState({ ...preferences, calendarRange }), expected);
      assert.equal(discoveryPath({ ...expected, calendarRange: "past" }).includes("calendarRange"), false);
    }
  }
  for (const calendarRange of ["upcoming", "past", "all"]) {
    assert.equal(discoveryState({ view: "calendar", calendarRange }).status, "live");
  }
});

test("personal orders match the public summary metrics, including deterministic ties and missing multiples", () => {
  const [first, second] = fixtureList("live", "ending").presales;
  const rows = [
    { ...first, presale_id: "a", end_ms: 20, start_ms: 20, participants: 2, interested: 1, ended_ms: 30, multiple: null },
    { ...second, presale_id: "b", end_ms: 10, start_ms: 10, participants: 1, interested: 2, ended_ms: 40, multiple: "1.5" },
  ];
  const ids = (sort: string) => orderWatched(rows, sort).map((row) => row.presale_id);
  assert.deepEqual(ids("ending"), ["b", "a"]);
  assert.deepEqual(ids("backed"), ["a", "b"]);
  for (const sort of ["opening", "interest", "recent", "best"]) assert.deepEqual(ids(sort), ["b", "a"]);
  assert.deepEqual(orderWatched(rows.map((row) => ({ ...row, participants: 1 })), "backed").map((row) => row.presale_id), ["b", "a"]);
  assert.equal(rows[0].presale_id, "a", "sorting leaves the source unchanged");
});
