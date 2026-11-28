import assert from "node:assert/strict";
import test from "node:test";
import type { Bar } from "./kline-model.ts";
import { barPeople, bubbleHeadroom, bubblePitch, layoutBubbles, MAX_PEOPLE, moreWidth, mousePress, personIdentity, profileAt, rememberProfiles, RING, STACK_LIMIT, type Bubble, type Person, type PersonTrade } from "./people-bubbles.ts";

const MINUTE = 60_000;
const T0 = 1_795_188_300_000;
const A = `0x${"a".repeat(64)}`, B = `0x${"b".repeat(64)}`, C = `0x${"c".repeat(64)}`, D = `0x${"d".repeat(64)}`, E = `0x${"e".repeat(64)}`, ME = `0x${"f".repeat(64)}`;
const bar = (minute: number, low = 1, high = 2): Bar => ({ timestamp: T0 + minute * MINUTE, open: low, high, low, close: high, volume: 1 });
let nextTradeId = 0;
const trade = (address: string, minute: number, side: "buy" | "sell", usd: number | null = 10, labels: PersonTrade["labels"] = []): PersonTrade =>
  ({ id: String(nextTradeId++), address, timestampMs: T0 + minute * MINUTE + 1_000, side, usd, labels });
const bars = [bar(0), bar(1, 3, 5), bar(2)];

test("one person per wallet per bar, with what it bought and sold there", () => {
  const people = barPeople([trade(A, 1, "buy", 30), trade(A, 1, "sell", 10, ["whale"]), trade(A, 2, "sell", 5), trade(B, 1, "sell", 7)], bars, new Set());
  const onBar = (address: string, minute: number) => people.find((person) => person.address === address && person.bar === T0 + minute * MINUTE);
  assert.equal(people.length, 3);
  assert.deepEqual(
    { side: onBar(A, 1)!.side, high: onBar(A, 1)!.high, low: onBar(A, 1)!.low, bought: onBar(A, 1)!.bought, sold: onBar(A, 1)!.sold, labels: onBar(A, 1)!.labels },
    { side: "buy", high: 5, low: 3, bought: 30, sold: 10, labels: ["whale"] },
  );
  assert.deepEqual({ side: onBar(B, 1)!.side, bought: onBar(B, 1)!.bought }, { side: "sell", bought: null });
  // Each of the wallet's trades on the bar, newest first, for the card's list.
  assert.deepEqual(onBar(A, 1)!.trades.map(({ side, usd }) => [side, usd]), [["buy", 30], ["sell", 10]]);
  assert.equal(onBar(A, 2)!.side, "sell");
  // Before the first bar there is nowhere to put a trade; an unknown size is unknown, not zero.
  assert.equal(barPeople([trade(A, -1, "buy")], bars, new Set()).length, 0);
  assert.equal(barPeople([trade(A, 0, "buy", 4), trade(A, 0, "buy", null)], bars, new Set())[0]!.bought, null);
});

test("the viewer's own wallets are marked whatever the address case", () => {
  const [person] = barPeople([trade(ME, 0, "buy")], bars, new Set([ME.toLowerCase()]));
  assert.equal(person!.own, true);
  assert.equal(barPeople([trade(ME.toUpperCase().replace("0X", "0x"), 0, "buy")], bars, new Set([ME]))[0]!.own, true);
});

// Bars 10 px apart on a 1,000 px plot; y grows down, so a bar's pixel y is (40 - price) × 10.
const px = (price: number) => (40 - price) * 10;
const place = (person: Person) => ({ x: (person.bar - T0) / MINUTE * 10, top: px(person.high), bottom: px(person.low) });
const person = (address: string, minute: number, extra: Partial<Extract<Person, { address: string }>> = {}): Person =>
  ({ address, bar: T0 + minute * MINUTE, side: "buy", high: 20, low: 10, bought: 1, sold: null, buys: 1, sells: 0, labels: [], own: false, lastMs: T0 + minute * MINUTE, trades: [], ...extra });
const SIZE = 24;
/** Empty px between a bubble (ring included) and the price at y `price` under it, or over it for `under`. */
const gapOver = (y: number, price: number) => price - (y + SIZE / 2 + RING);
const gapUnder = (y: number, price: number) => (y - SIZE / 2 - RING) - price;

test("zoomed in, every person floats one bubble height over their own bar's high, buyers and sellers alike", () => {
  const bubbles = layoutBubbles([person(A, 0), person(B, 30), person(C, 60, { side: "sell" })], place, 1_000, 400, SIZE);
  assert.equal(bubbles.length, 3);
  assert.ok(bubbles.every((bubble) => bubble.kind === "person"));
  // The high is at y 200: a full bubble height of empty space under each bubble, and no more than a pixel past it.
  assert.ok(bubbles.every((bubble) => gapOver(bubble.y, px(20)) >= SIZE && gapOver(bubble.y, px(20)) < SIZE + 1), bubbles.map((bubble) => bubble.y).join());
});

test("a bubble keeps its gap over a taller neighbouring bar under it, so the price stays readable", () => {
  // The next bar, 10 px to the right, reaches price 30 (y 100): the bubble rises over it too.
  const [bubble] = layoutBubbles([person(A, 0)], place, 1_000, 400, SIZE, { spans: [{ x: 10, top: px(30), bottom: px(25) }, { x: 200, top: 0, bottom: 10 }] });
  assert.ok(gapOver(bubble!.y, px(30)) >= SIZE, String(bubble!.y));
  // A bar far away changes nothing.
  assert.equal(layoutBubbles([person(A, 0)], place, 1_000, 400, SIZE, { spans: [{ x: 200, top: 0, bottom: 10 }] })[0]!.y, layoutBubbles([person(A, 0)], place, 1_000, 400, SIZE)[0]!.y);
});

test("a bar at the top of the plot puts its stack the same gap under the low instead", () => {
  const top = [person(A, 0, { high: 39.5, low: 30 }), person(B, 0, { high: 39.5, low: 30 })];
  const ys = layoutBubbles(top, place, 1_000, 400, SIZE).map((bubble) => bubble.y);
  assert.ok(ys.every((y) => gapUnder(y, px(30)) >= SIZE), ys.join());
  assert.equal(new Set(ys).size, 2);
});

test("the chart keeps room for one bubble and its gap over the highest price, under the legends", () => {
  // A bar whose high sits the headroom below the legends' inset gets its bubble above it, not under.
  const inset = 20, high = 40 - (inset + bubbleHeadroom(SIZE)) / 10;
  const [bubble] = layoutBubbles([person(A, 0, { high, low: high - 1 })], place, 1_000, 400, SIZE, { topInset: inset });
  assert.ok(bubble!.y - SIZE / 2 >= inset && gapOver(bubble!.y, px(high)) >= SIZE, String(bubble!.y));
});

test("a stack with room for only one bubble over the price folds into +N instead of covering it", () => {
  // Three traders on a bar whose high leaves one slot under the legends and none under its low.
  const inset = 20, high = 40 - (inset + bubbleHeadroom(SIZE)) / 10;
  const crowd = [person(A, 0, { high, low: 0.5 }), person(B, 0, { high, low: 0.5 }), person(C, 0, { high, low: 0.5 })];
  const bubbles = layoutBubbles(crowd, place, 1_000, 400, SIZE, { topInset: inset });
  assert.deepEqual(bubbles.map((bubble) => bubble.kind === "more" && bubble.people.length), [3]);
  assert.ok(gapOver(bubbles[0]!.y, px(high)) >= SIZE, String(bubbles[0]!.y));
  // Two slots: one person and a +2. The viewer's own bubble still shows.
  const two = layoutBubbles(crowd, place, 1_000, 400, SIZE, { topInset: inset - bubblePitch(SIZE) });
  assert.deepEqual(two.map((bubble) => bubble.kind), ["person", "more"]);
  assert.ok(two.every((bubble) => gapOver(bubble.y, px(high)) >= SIZE), two.map((bubble) => bubble.y).join());
  const mine = layoutBubbles([...crowd.slice(1), person(ME, 0, { high, low: 0.5, own: true })], place, 1_000, 400, SIZE, { topInset: inset });
  assert.ok(mine.some((bubble) => bubble.kind === "person" && bubble.person.own));
});

test("zoomed out, a crowded column shows its first people and folds the rest into +N", () => {
  // Bars 10 px apart, 24 px bubbles: minutes 0–2 share the first column.
  const crowd = [person(A, 0), person(B, 1), person(C, 1, { lastMs: T0 + 1.5 * MINUTE }), person(D, 2), person(E, 2, { labels: ["sniper"] })];
  const bubbles = layoutBubbles(crowd, place, 1_000, 400, SIZE);
  const shown = bubbles.filter((bubble) => bubble.kind === "person");
  const more = bubbles.find((bubble) => bubble.kind === "more");
  assert.equal(shown.length, STACK_LIMIT - 1);
  assert.equal(more?.kind === "more" && more.people.length, crowd.length - (STACK_LIMIT - 1));
  // Tagged wallets rank first, then the newest.
  assert.deepEqual(shown.map((bubble) => bubble.kind === "person" && bubble.person.address), [E, D]);
  // A column that fits shows everyone and no +N.
  assert.equal(layoutBubbles(crowd.slice(0, STACK_LIMIT), place, 1_000, 400, SIZE).filter((bubble) => bubble.kind === "more").length, 0);
});

test("a buyer and a seller on one busy bar share a column, both clear above the bar's high", () => {
  const ys = layoutBubbles([person(A, 0), person(B, 0, { side: "sell", buys: 0, sells: 2, bought: null, sold: 5 })], place, 1_000, 400, SIZE).map((bubble) => bubble.y);
  assert.equal(new Set(ys).size, 2);
  assert.ok(ys.every((y) => gapOver(y, px(20)) >= SIZE), ys.join());
});

test("a +N keeps its identity while the chart scrolls, so its open card stays open", () => {
  const crowd = [person(A, 0), person(B, 0), person(C, 0), person(D, 0)];
  const key = (shift: number) => layoutBubbles(crowd, (one) => ({ ...place(one), x: place(one).x + shift }), 1_000, 400, SIZE).find((bubble) => bubble.kind === "more")?.key;
  assert.ok(key(100));
  assert.equal(key(100), key(137.4));
});

test("a wide candle next to a column counts as under it when the chart is zoomed in", () => {
  // The neighbour sits 30 px away: out of reach of a 24 px bubble on thin candles, under it once candles are 40 px wide.
  const tall = [{ x: 30, top: px(30), bottom: px(25) }];
  const thin = layoutBubbles([person(A, 0)], place, 1_000, 400, SIZE, { spans: tall, halfBar: 2 })[0]!;
  const wide = layoutBubbles([person(A, 0)], place, 1_000, 400, SIZE, { spans: tall, halfBar: 20 })[0]!;
  assert.ok(thin.y > px(30), String(thin.y));
  assert.ok(gapOver(wide.y, px(30)) >= SIZE, String(wide.y));
});

test("the viewer's own trades always show, even in a full column", () => {
  const crowd = [person(A, 0), person(B, 0), person(C, 1), person(D, 1), person(ME, 2, { own: true }), person(E, 2, { own: true, address: `${E}0` })];
  const bubbles = layoutBubbles(crowd, place, 1_000, 400, SIZE);
  const own = bubbles.filter((bubble) => bubble.kind === "person" && bubble.person.own);
  assert.equal(own.length, 2);
  const more = bubbles.find((bubble) => bubble.kind === "more");
  assert.ok(more?.kind === "more" && more.people.every((folded) => !folded.own));
  // Off-plot people are skipped; own trades are kept in the people list past the cap.
  assert.equal(layoutBubbles([person(A, 200)], place, 1_000, 400, SIZE).length, 0);
  const many = Array.from({ length: 300 }, (_, index) => trade(`0x${index.toString(16).padStart(64, "0")}`, 0, "buy"));
  assert.ok(barPeople([...many, trade(ME, 0, "buy")], bars, new Set([ME])).some((kept) => kept.own));
});

test("the bubble cap counts only people on screen, so scrolling back still shows the older ones", () => {
  // Newest first, as barPeople returns them: 300 off-screen newer people, then 5 visible older ones.
  const offscreen = Array.from({ length: 300 }, (_, index) => person(`0x${index.toString(16).padStart(64, "0")}`, 500, { lastMs: T0 + 900 * MINUTE }));
  const visible = [person(A, 0), person(B, 10), person(C, 20), person(D, 30), person(E, 40)];
  assert.equal(layoutBubbles([...offscreen, ...visible], place, 1_000, 400, SIZE).length, 5);
  const crowd = Array.from({ length: MAX_PEOPLE + 50 }, (_, index) => person(`0x${index.toString(16).padStart(64, "0")}`, index % 99));
  assert.ok(layoutBubbles(crowd, place, 1_000, 10_000, SIZE).length <= MAX_PEOPLE);
});

/** A bubble's box on the plot, its ring included: a "+N" grows to the right from where a face would start. */
const box = (bubble: Bubble, size: number) => {
  const width = bubble.kind === "more" ? moreWidth(bubble.people.length, size) : size;
  return { left: bubble.x - size / 2 - RING, right: bubble.x - size / 2 + width + RING, top: bubble.y - size / 2 - RING, bottom: bubble.y + size / 2 + RING };
};
const overlaps = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

test("no two bubbles ever overlap, rings and +N included, however the trades fall", () => {
  // x = 0, 20, 30, 40: fixed 24 px bins would put bubbles 10 px apart.
  const few = layoutBubbles([person(A, 0), person(B, 2), person(C, 3), person(D, 4)], place, 1_000, 400, SIZE);
  assert.equal(few.length, 4);
  // Busy charts: up to 40 wallets per bar on bars 1–12 px apart, prices anywhere on the plot, both bubble sizes.
  let seed = 7;
  const random = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647;
  for (let round = 0; round < 200; round++) {
    const size = round % 2 ? 18 : 20;
    const spacing = 1 + Math.floor(random() * 12);
    const crowd = Array.from({ length: 20 + Math.floor(random() * 180) }, (_, index) => {
      const at = Math.floor(random() * 60), high = 2 + random() * 36, low = high - random() * Math.min(high - 1, 10);
      return { ...person(`0x${index.toString(16).padStart(64, "0")}`, at, { high, low, own: random() < .03, labels: random() < .1 ? ["whale"] : [] }), bar: T0 + at * MINUTE };
    });
    const placeAt = (one: Person) => ({ x: (one.bar - T0) / MINUTE * spacing, top: px(one.high), bottom: px(one.low) });
    const bubbles = layoutBubbles(crowd, placeAt, 1_000, 400, size, { topInset: 20 });
    const boxes = bubbles.map((bubble) => box(bubble, size));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      assert.ok(!overlaps(boxes[i]!, boxes[j]!), `round ${round}: ${bubbles[i]!.key} and ${bubbles[j]!.key} overlap`);
    }
    // Each column sits over its own traders: never pushed past them, however many "+NN" columns come before.
    const columns = Map.groupBy(bubbles, (bubble) => bubble.x);
    for (const [x, column] of columns) {
      const xs = column.flatMap((bubble) => bubble.kind === "more" ? bubble.people : [bubble.person]).map((one) => placeAt(one).x);
      assert.ok(x >= Math.min(...xs) && x <= Math.max(...xs), `round ${round}: column at ${x} is off its traders (${Math.min(...xs)}–${Math.max(...xs)})`);
    }
  }
});

test("a bar that fills the plot still fans its stack out on the plot instead of piling up", () => {
  // No room over the high or under the low: the stack hangs from the top edge, each bubble on its own spot.
  const tall = [person(A, 0, { high: 39.5, low: 0.5 }), person(B, 0, { high: 39.5, low: 0.5 }), person(C, 0, { high: 39.5, low: 0.5 })];
  const ys = layoutBubbles(tall, place, 1_000, 400, SIZE).map((bubble) => bubble.y);
  assert.equal(new Set(ys).size, 3);
  assert.ok(ys.every((y) => y >= 12 && y <= 388), ys.join());
  // A bar dragged above the plot still fans its stack out.
  const off = [person(A, 0, { high: 90, low: 60 }), person(B, 0, { high: 90, low: 60 }), person(C, 0, { high: 90, low: 60 })];
  assert.equal(new Set(layoutBubbles(off, place, 1_000, 400, SIZE).map((bubble) => bubble.y)).size, 3);
});

test("no profile shows an anonymous circle and a short address", () => {
  assert.deepEqual(personIdentity(A, null), { anonymous: true, name: "0xaaaa…aaaa", callsign: null, avatarUrl: null });
  assert.deepEqual(personIdentity(A, { callsign: "pilot", avatarUrl: null }), { anonymous: false, name: "@pilot", callsign: "pilot", avatarUrl: null });
});

test("only a real mouse press follows a bubble's link; touch, pen and screen readers open the card", () => {
  assert.equal(mousePress({ pointerType: "mouse", width: 1, height: 1, pressure: 0.5, buttons: 1 }), true);
  // Some desktop mice report no pressure, but a held button.
  assert.equal(mousePress({ pointerType: "mouse", width: 1, height: 1, pressure: 0, buttons: 1 }), true);
  assert.equal(mousePress({ pointerType: "mouse", width: 1, height: 1, pressure: 0, buttons: 0 }), false);
  assert.equal(mousePress({ pointerType: "touch", width: 20, height: 20, pressure: 0.5, buttons: 1 }), false);
  assert.equal(mousePress({ pointerType: "pen", width: 1, height: 1, pressure: 0.5, buttons: 1 }), false);
});

test("profiles build up from the lookup's answers, from the earliest trade they were returned for", () => {
  const empty = new Map();
  assert.equal(rememberProfiles(empty, [undefined, { bad: 1 }]), empty);
  const seen = rememberProfiles(empty, [{ [`${A}:${T0 + 5_000}`]: { callsign: "pilot", avatarUrl: "https://x/a.png" }, [`${B}:${T0}`]: null }]);
  assert.equal(profileAt(seen, A, T0 + 5_000)?.callsign, "pilot");
  assert.equal(profileAt(seen, A.toUpperCase().replace("0X", "0x"), T0 + 9_000)?.callsign, "pilot");
  // An older trade is not credited to a profile only known from a later one, and a wallet answered null stays anonymous.
  assert.equal(profileAt(seen, A, T0), null);
  assert.equal(profileAt(seen, B, T0), null);
  // The same answer again changes nothing; an earlier one widens it.
  assert.equal(rememberProfiles(seen, [{ [`${A}:${T0 + 5_000}`]: { callsign: "pilot", avatarUrl: "https://x/a.png" } }]), seen);
  const wider = rememberProfiles(seen, [{ [`${A}:${T0}`]: { callsign: "pilot", avatarUrl: "https://x/a.png" } }]);
  assert.equal(profileAt(wider, A, T0)?.callsign, "pilot");
});
