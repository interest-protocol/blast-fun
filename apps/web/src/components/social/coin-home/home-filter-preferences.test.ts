import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";
import { rememberHomeFilters, restoreHomeFilters } from "./home-filter-preferences.ts";
import { HOME_DEFAULT_FEED, viewStateOf } from "./home-state.ts";

const { window } = installTestDom();
const STORAGE_KEY = "blast.homeFilters.v1";
const home = "https://blast.test/";

test("Home restores saved filters, skips explicit views, and retains unrelated URL parameters", () => {
  window.localStorage.clear();
  const selected = viewStateOf(new URLSearchParams("src=following&w=24h&min=5&sort=newest&age=7d&tradable=1&page=4"));
  rememberHomeFilters(HOME_DEFAULT_FEED, selected);

  assert.equal(window.localStorage.getItem(STORAGE_KEY), "?sort=newest&w=24h&min=5&age=7d&tradable=1");
  assert.equal(restoreHomeFilters(new URL(`${home}?ref=jose#coins`))?.href,
    `${home}?ref=jose&sort=newest&w=24h&min=5&age=7d&tradable=1#coins`);
  assert.equal(restoreHomeFilters(new URL(`${home}?w=1h`)), null);
  assert.equal(restoreHomeFilters(new URL(`${home}?page=2`)), null);

  const linked = viewStateOf(new URLSearchParams("w=1h&page=2"));
  rememberHomeFilters(linked, { ...linked, source: "watchlist", page: 1 });
  assert.equal(restoreHomeFilters(new URL(home))?.searchParams.get("w"), "24h");

  rememberHomeFilters(selected, HOME_DEFAULT_FEED);
  assert.equal(restoreHomeFilters(new URL(home)), null);
});

test("Home validates stored filters and tolerates denied storage", (t) => {
  window.localStorage.setItem(STORAGE_KEY, "sort=unknown&w=24h&min=999&src=following&page=4");
  // An unknown sort falls back to the order the filters imply (`held`), which the URL leaves out.
  assert.equal(restoreHomeFilters(new URL(home))?.href, `${home}?w=24h`);

  window.localStorage.setItem(STORAGE_KEY, "w=unknown&min=999&page=4");
  assert.equal(restoreHomeFilters(new URL(home)), null);

  t.mock.getter(window, "localStorage", () => { throw new window.DOMException("Storage is disabled", "SecurityError"); });
  assert.equal(restoreHomeFilters(new URL(home)), null);
  assert.doesNotThrow(() => rememberHomeFilters(HOME_DEFAULT_FEED, { ...HOME_DEFAULT_FEED, sort: "trending", window: "24h" }));
});
