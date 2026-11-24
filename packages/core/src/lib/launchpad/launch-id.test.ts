import assert from "node:assert/strict";
import test from "node:test";

import { parseLaunchId } from "@blast/core/lib/launchpad/launch-id.ts";

const LAUNCH_ID = "0x5f1a0c3e9b7d2468ace013579bdf2468ace013579bdf2468ace013579bdf2468";

test("a canonical Sui object ID is the launch ID, unchanged", () => {
  assert.equal(parseLaunchId(LAUNCH_ID), LAUNCH_ID);
});

test("malformed launch IDs are rejected instead of normalized or substituted", () => {
  for (const value of [
    "",
    "0x",
    "0x2",
    LAUNCH_ID.slice(2),
    LAUNCH_ID.toUpperCase(),
    `0X${LAUNCH_ID.slice(2)}`,
    `${LAUNCH_ID}0`,
    LAUNCH_ID.slice(0, -1),
    `${LAUNCH_ID.slice(0, -1)}g`,
    ` ${LAUNCH_ID}`,
    `${LAUNCH_ID}/`,
    `${LAUNCH_ID}.png`,
    "pepe",
    "0x2::sui::SUI",
  ]) assert.equal(parseLaunchId(value), null, JSON.stringify(value));
});
