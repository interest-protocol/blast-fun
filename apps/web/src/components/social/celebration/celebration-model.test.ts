import assert from "node:assert/strict";
import test from "node:test";

import { CBLT, happeningPresale, happeningRead, MRDN, TIDE } from "../../../../test/fixtures/social/happening/happening-fixtures.ts";
import {
  CELEBRATED_KEY,
  CELEBRATED_MAX,
  fundedSince,
  readCelebrated,
  rememberCelebrated,
  presaleNotice,
} from "./celebration-model";

const funded = (row: typeof TIDE, lifecycle = "funded") => happeningPresale({ ...row.presale, lifecycle, raised: "401800000000" });

test("§19 a presale Home showed open and the next read shows funded is celebrated; nothing else is", () => {
  const before = happeningRead();
  const after = happeningRead({ today: [funded(TIDE), MRDN, CBLT], fastest: [MRDN] });
  assert.deepEqual(fundedSince(before, after).map((row) => row.presale.name), ["Tidal"]);
  // Already funded at the first read (Cobalt): no celebration, nor for the page's first read.
  assert.deepEqual(fundedSince(null, after), []);
  assert.deepEqual(fundedSince(after, after), []);
  // A cancelled close: no confetti.
  assert.deepEqual(fundedSince(before, happeningRead({ today: [funded(TIDE, "cancelled")] })), []);
  // Funded and already migrated by the next read still closed funded.
  assert.deepEqual(fundedSince(before, happeningRead({ today: [funded(TIDE, "migrated")] })).length, 1);
  // Open only in "Fastest filling" before: still one Home showed.
  assert.deepEqual(fundedSince(happeningRead({ today: [], fastest: [TIDE] }), after).length, 1);
});

function memoryStorage(refuse = false) {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (refuse) throw new Error("QuotaExceededError");
      data.set(key, value);
    },
  };
}

test("§19 never twice for one sale on this device; storage that refuses or holds junk never throws", () => {
  const storage = memoryStorage();
  assert.equal(rememberCelebrated(storage, "0xa4"), true);
  assert.equal(rememberCelebrated(storage, "0xa4"), false);
  assert.deepEqual(JSON.parse(storage.data.get(CELEBRATED_KEY)!), ["0xa4"]);
  for (let index = 0; index < CELEBRATED_MAX + 5; index += 1) rememberCelebrated(storage, `0x${index}`);
  assert.equal(readCelebrated(storage).length, CELEBRATED_MAX);
  assert.equal(rememberCelebrated(memoryStorage(true), "0xa4"), true);
  assert.equal(rememberCelebrated(null, "0xa4"), true);
  const junk = memoryStorage();
  junk.data.set(CELEBRATED_KEY, "{not json");
  assert.deepEqual(readCelebrated(junk), []);
  junk.data.set(CELEBRATED_KEY, JSON.stringify(["0xa4", 7]));
  assert.deepEqual(readCelebrated(junk), ["0xa4"]);
});


test("a funded presale migrating is announced once, including when duplicated in the read", () => {
  const before = happeningRead({ today: [funded(TIDE)], fastest: [] });
  const migrated = funded(TIDE, "migrated");
  const after = happeningRead({ today: [migrated, migrated], fastest: [] });
  assert.deepEqual(fundedSince(before, after), [migrated]);
  assert.deepEqual(fundedSince(after, after), []);
  assert.deepEqual(fundedSince(null, after), []);
});

test("notices distinguish funding from migration and keep large batches concise", () => {
  assert.equal(presaleNotice([]), null);
  const fundedNotice = presaleNotice([funded(TIDE).presale])!;
  assert.equal(fundedNotice.title, "Tidal is funded");
  assert.match(fundedNotice.sub, /has not launched/);
  const migrated = funded(TIDE, "migrated").presale;
  const notice = presaleNotice([migrated])!;
  assert.equal(notice.title, "Tidal has migrated");
  assert.match(notice.sub, /Migrated to Cetus/);
  assert.equal(notice.href, `/presale/${TIDE.presale.presale_id}`);
  const batch = presaleNotice(Array.from({ length: 100 }, () => migrated))!;
  assert.equal(batch.title, "100 presales migrated");
  assert.match(batch.sub, /and 98 more/);
  assert.equal(batch.href, "/presale");
  assert.equal(presaleNotice([migrated, funded(MRDN).presale])!.title, "2 presales updated");
  assert.equal(presaleNotice([funded(TIDE).presale, funded(MRDN).presale])!.title, "2 presales funded");
});
