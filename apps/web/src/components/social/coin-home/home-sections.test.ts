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
  sectionMovedMessage,
  sectionSlotStep,
  serializeHomeSections,
  setHomeSectionShown,
  shownHomeSections,
  springPath,
} from "./home-sections.ts";

test("the cookie round-trips: order with hidden marked; unknown keys dropped; missing sections appended; malformed is the default", () => {
  assert.equal(parseHomeSections(null), HOME_SECTIONS_DEFAULT);
  assert.equal(parseHomeSections(""), HOME_SECTIONS_DEFAULT);
  assert.equal(parseHomeSections("coins.presales.posts"), HOME_SECTIONS_DEFAULT);
  assert.deepEqual(parseHomeSections("coins.traders.presales").order, ["coins", "traders", "bonding", "presales", "posts"], "saved order is preserved");
  const prefs = parseHomeSections("traders.-presales.coins.posts");
  assert.deepEqual(prefs, { order: ["traders", "bonding", "presales", "coins", "posts"], hidden: ["presales"] });
  assert.equal(serializeHomeSections(prefs), "traders.bonding.-presales.coins.posts");
  assert.deepEqual(parseHomeSections("-presales"), { order: ["bonding", "presales", "coins", "posts", "traders"], hidden: ["presales"] });
  assert.deepEqual(parseHomeSections("coins.coins.-coins.top.;drop"), HOME_SECTIONS_DEFAULT);
  assert.deepEqual(parseHomeSections("-coins.-traders.-presales.-posts").hidden, ["coins", "presales", "posts", "traders"]);
  assert.equal(serializeHomeSections(HOME_SECTIONS_DEFAULT), "");
  assert.ok(isDefaultHomeSections(parseHomeSections("presales.coins.posts")) === false);
  assert.ok(isDefaultHomeSections(parseHomeSections("coins.presales.traders.posts")) === false, "the old order is now a saved choice");
});

test("moves walk among the sections showing, hidden ones keep their place, the ends move nothing", () => {
  const prefs = parseHomeSections("coins.-traders.presales.posts.-bonding");
  assert.equal(moveHomeSection(prefs, "coins", -1), prefs);
  assert.equal(moveHomeSection(prefs, "posts", 1), prefs);
  const down = moveHomeSection(prefs, "coins", 1);
  assert.deepEqual(down, { order: ["presales", "traders", "coins", "posts", "bonding"], hidden: ["bonding", "traders"] });
  assert.deepEqual(shownHomeSections(down), ["presales", "coins", "posts"]);
  assert.equal(moveHomeSection(prefs, "traders", 1), prefs);
  assert.deepEqual(placeHomeSection(HOME_SECTIONS_DEFAULT, "presales", 0).order, ["presales", "coins", "bonding", "posts", "traders"]);
  assert.deepEqual(placeHomeSection(HOME_SECTIONS_DEFAULT, "coins", 99).order, ["bonding", "presales", "posts", "traders", "coins"]);
  assert.equal(placeHomeSection(HOME_SECTIONS_DEFAULT, "coins", 0), HOME_SECTIONS_DEFAULT);
});

test("hiding and showing: the same object when nothing changes; every section may be hidden", () => {
  const hidden = setHomeSectionShown(HOME_SECTIONS_DEFAULT, "presales", false);
  assert.deepEqual(hidden.hidden, ["presales"]);
  assert.equal(setHomeSectionShown(hidden, "presales", false), hidden);
  assert.equal(setHomeSectionShown(hidden, "presales", true), HOME_SECTIONS_DEFAULT);
  const none = parseHomeSections("-coins.-bonding.-presales.-posts.-traders");
  assert.deepEqual(shownHomeSections(none), []);
  assert.equal(serializeHomeSections(none), "-coins.-bonding.-presales.-posts.-traders");
});

test("Bonding Curves keeps its saved position and visibility", () => {
  const prefs = parseHomeSections("coins.presales.bonding.posts.traders");
  assert.deepEqual(shownHomeSections(prefs), ["coins", "presales", "bonding", "posts", "traders"]);
  const hidden = setHomeSectionShown(prefs, "bonding", false);
  const saved = parseHomeSections(serializeHomeSections(moveHomeSection(hidden, "posts", -1)));
  assert.equal(saved.order[2], "bonding");
  assert.deepEqual(saved.hidden, ["bonding"]);
});

test("the drag's swap rule and the words", () => {
  const a = { top: 0, height: 100 };
  const b = { top: 100, height: 300 };
  // A short section dragged down: its bottom past the tall neighbour's centre (250) takes the slot.
  assert.equal(sectionSlotStep({ top: 160, height: 100 }, a, b), 1);
  assert.equal(sectionSlotStep({ top: 140, height: 100 }, a, b), 0);
  // A tall section dragged up: its top past the short neighbour's centre (50), not its own centre.
  assert.equal(sectionSlotStep({ top: 40, height: 300 }, a, undefined), -1);
  assert.equal(sectionSlotStep({ top: 60, height: 300 }, a, undefined), 0);
  assert.equal(sectionSlotStep({ top: 60, height: 300 }, undefined, undefined), 0);
  assert.equal(sectionMovedMessage("traders", 0, 3), "PnL leaderboard moved to position 1 of 3");
});

test("the settle's spring starts where the section was let go, never overshoots, and ends at its slot", () => {
  const path = springPath(-120, 800);
  assert.equal(path[0], -120);
  assert.ok(path.every((y) => y <= 0.5), "critically damped: no overshoot past the slot");
  assert.ok(Math.abs(path[path.length - 1]!) < 0.5, `ends at the slot (${path[path.length - 1]})`);
  // A release moving toward the slot gets there sooner than one moving away.
  const toward = springPath(-120, 800).findIndex((y) => Math.abs(y) < 2);
  const away = springPath(-120, -800).findIndex((y) => Math.abs(y) < 2);
  assert.ok(toward < away);
  assert.deepEqual(springPath(0, 0).every((y) => y === 0), true);
});

test("the cookie line and its reading", () => {
  const prefs = parseHomeSections("traders.-presales.coins.posts");
  assert.equal(homeSectionsCookieLine(prefs, true), "blast.home=traders.bonding.-presales.coins.posts; Max-Age=31536000; Path=/; SameSite=Lax; Secure");
  assert.equal(homeSectionsCookieLine(HOME_SECTIONS_DEFAULT, false), "blast.home=; Max-Age=0; Path=/; SameSite=Lax");
  assert.equal(homeSectionsCookieValue("a=1; blast.home=traders.-presales.coins.posts; b=2"), "traders.-presales.coins.posts");
  assert.equal(homeSectionsCookieValue("a=1; blast.homer=x"), null);
  assert.equal(homeSectionsCookieValue(""), null);
});
