import assert from "node:assert/strict";
import test from "node:test";

import { MIGRATOR_VENUES as SDK_MIGRATOR_VENUES } from "@interest-protocol/blast-sdk/migrators";

import { MIGRATOR_POOL_KEY, MIGRATOR_VENUES, POOL_KEY, VENUES, isMigratorVenue, isVenue } from "./venues.ts";

const POOL = `0x${"ab".repeat(32)}`;

test("the migrator venues are the SDK's, and every one is a venue", () => {
  assert.deepEqual([...MIGRATOR_VENUES].sort(), [...SDK_MIGRATOR_VENUES].sort());
  assert.ok(MIGRATOR_VENUES.every((venue) => (VENUES as readonly string[]).includes(venue)));
});

test("pool keys name a known venue and a canonical pool id", () => {
  assert.deepEqual(POOL_KEY.exec(`cetus:${POOL}`)?.slice(1), ["cetus", POOL]);
  assert.ok(POOL_KEY.test(`blast_curve:${POOL}`));
  assert.equal(MIGRATOR_POOL_KEY.test(`blast_curve:${POOL}`), false);
  assert.ok(MIGRATOR_POOL_KEY.test(`bluefin:${POOL}`));
  for (const key of [`turbos:${POOL}`, `cetus:${POOL.toUpperCase()}`, `cetus:${POOL}0`, "cetus:0x2"]) {
    assert.equal(POOL_KEY.test(key), false, key);
  }
});

test("venue guards", () => {
  assert.ok(isVenue("blast_curve") && isMigratorVenue("cetus"));
  assert.equal(isMigratorVenue("blast_curve"), false);
  assert.equal(isVenue("aftermath"), false);
});
