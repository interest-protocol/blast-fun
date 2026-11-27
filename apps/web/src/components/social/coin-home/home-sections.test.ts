import assert from "node:assert/strict";
import test from "node:test";

import {
  HOME_SECTIONS_DEFAULT,
  homeSectionsCookieLine,
  homeSectionsCookieValue,
  isDefaultHomeSections,
  moveHomeSection,
  parseHomeSections,
  placeHomeSection,
  serializeHomeSections,
  setHomeSectionShown,
  shownHomeSections,
} from "./home-sections.ts";

test("the cookie round-trips: order with hidden marked; unknown keys dropped; missing sections appended; malformed is the default", () => {
  assert.equal(parseHomeSections(null), HOME_SECTIONS_DEFAULT);
  assert.equal(parseHomeSections(""), HOME_SECTIONS_DEFAULT);
  assert.deepEqual(parseHomeSections("coins.traders.bonding").order, ["coins", "traders", "bonding", "posts"], "saved order is preserved");
  const prefs = parseHomeSections("traders.-posts.coins.bonding");
  assert.deepEqual(prefs, { order: ["traders", "posts", "coins", "bonding"], hidden: ["posts"] });
  assert.equal(serializeHomeSections(prefs), "traders.-posts.coins.bonding");
  assert.deepEqual(parseHomeSections("coins.coins.-coins.top.;drop"), HOME_SECTIONS_DEFAULT);
  assert.deepEqual(parseHomeSections("-coins.-traders.-bonding.-posts").hidden, ["coins", "bonding", "posts", "traders"]);
  assert.equal(serializeHomeSections(HOME_SECTIONS_DEFAULT), "");
  assert.ok(isDefaultHomeSections(parseHomeSections("bonding.coins.posts")) === false);
});

test("a cookie saved while Home had a Presales section loads cleanly: Presales drops out, Bonding Curves takes its place", () => {
  assert.equal(parseHomeSections("coins.presales.posts"), HOME_SECTIONS_DEFAULT, "the old default order is today's default");
  assert.equal(parseHomeSections("coins.bonding.presales.posts.traders"), HOME_SECTIONS_DEFAULT);
  assert.deepEqual(parseHomeSections("-presales"), { order: ["bonding", "coins", "posts", "traders"], hidden: [] }, "a hidden Presales section leaves nothing hidden; Bonding Curves stays first, as that cookie showed it");
  assert.deepEqual(parseHomeSections("traders.-presales.coins.posts"), { order: ["traders", "bonding", "coins", "posts"], hidden: [] });
  assert.deepEqual(parseHomeSections("presales.-coins.posts.traders"), { order: ["bonding", "coins", "posts", "traders"], hidden: ["coins"] });
  assert.deepEqual(parseHomeSections("coins.-bonding.presales.-posts"), { order: ["coins", "bonding", "posts", "traders"], hidden: ["bonding", "posts"] }, "a saved Bonding Curves keeps its place and visibility");
  assert.deepEqual(parseHomeSections("-coins.-bonding.-presales.-posts.-traders").hidden, ["coins", "bonding", "posts", "traders"]);
  assert.equal(serializeHomeSections(parseHomeSections("traders.-presales.coins.posts")), "traders.bonding.coins.posts", "the next write forgets Presales");
});

test("moves walk among the sections showing, hidden ones keep their place, the ends move nothing", () => {
  const prefs = parseHomeSections("coins.-traders.bonding.posts");
  assert.equal(moveHomeSection(prefs, "coins", -1), prefs);
  assert.equal(moveHomeSection(prefs, "posts", 1), prefs);
  const down = moveHomeSection(prefs, "coins", 1);
  assert.deepEqual(down, { order: ["bonding", "traders", "coins", "posts"], hidden: ["traders"] });
  assert.deepEqual(shownHomeSections(down), ["bonding", "coins", "posts"]);
  assert.equal(moveHomeSection(prefs, "traders", 1), prefs);
  assert.deepEqual(placeHomeSection(HOME_SECTIONS_DEFAULT, "posts", 0).order, ["posts", "coins", "bonding", "traders"]);
  assert.deepEqual(placeHomeSection(HOME_SECTIONS_DEFAULT, "coins", 99).order, ["bonding", "posts", "traders", "coins"]);
  assert.equal(placeHomeSection(HOME_SECTIONS_DEFAULT, "coins", 0), HOME_SECTIONS_DEFAULT);
});

test("hiding and showing: the same object when nothing changes; every section may be hidden", () => {
  const hidden = setHomeSectionShown(HOME_SECTIONS_DEFAULT, "posts", false);
  assert.deepEqual(hidden.hidden, ["posts"]);
  assert.equal(setHomeSectionShown(hidden, "posts", false), hidden);
  assert.equal(setHomeSectionShown(hidden, "posts", true), HOME_SECTIONS_DEFAULT);
  const none = parseHomeSections("-coins.-bonding.-posts.-traders");
  assert.deepEqual(shownHomeSections(none), []);
  assert.equal(serializeHomeSections(none), "-coins.-bonding.-posts.-traders");
});

test("Bonding Curves keeps its saved position and visibility", () => {
  const prefs = parseHomeSections("coins.posts.bonding.traders");
  assert.deepEqual(shownHomeSections(prefs), ["coins", "posts", "bonding", "traders"]);
  const hidden = setHomeSectionShown(prefs, "bonding", false);
  const saved = parseHomeSections(serializeHomeSections(moveHomeSection(hidden, "traders", -1)));
  assert.equal(saved.order[2], "bonding");
  assert.deepEqual(saved.hidden, ["bonding"]);
});

test("the cookie line and its reading", () => {
  const prefs = parseHomeSections("traders.-posts.coins.bonding");
  assert.equal(homeSectionsCookieLine(prefs, true), "blast.home=traders.-posts.coins.bonding; Max-Age=31536000; Path=/; SameSite=Lax; Secure");
  assert.equal(homeSectionsCookieLine(HOME_SECTIONS_DEFAULT, false), "blast.home=; Max-Age=0; Path=/; SameSite=Lax");
  assert.equal(homeSectionsCookieValue("a=1; blast.home=traders.-posts.coins; b=2"), "traders.-posts.coins");
  assert.equal(homeSectionsCookieValue("a=1; blast.homer=x"), null);
  assert.equal(homeSectionsCookieValue(""), null);
});
