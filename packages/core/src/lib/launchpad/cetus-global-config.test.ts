import assert from "node:assert/strict";
import test from "node:test";

import { fromHex } from "@mysten/sui/utils";

import { decodeCetusFees } from "./cetus-global-config.ts";

/**
 * The Move contents of Cetus CLMM's mainnet `config::GlobalConfig`
 * (0xdaa4…3d8f), copied from contracts 442116a
 * `sui/launchpad/ptb_tests/fork/snapshot/objects/cetus_global_config.bcs`
 * (the object's `data.Move.contents`).
 */
const SNAPSHOT_CONTENTS =
  "daa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8fd00700000000000010020000000200000064000000000000000a0000000a000000f4010000000000003c0000003c000000c409000000000000c8000000c800000010270000000000001400000014000000e803000000000000dc000000dc000000204e0000000000000400000004000000c80000000000000006000000060000002c01000000000000080000000800000090010000000000001e0000001e000000dc050000000000002800000028000000d0070000000000005000000050000000b80b0000000000006400000064000000a00f00000000000078000000780000007017000000000000a0000000a0000000401f0000000000000401000004010000409c000000000000cf1897ae0793665f0e3f676d86450675bbf31842fde1aa02613b7b53f34b764c01aabf2fedcb36146db164bec930b74a47969c4df98216e049342a3c49b6d11580012891c6b8dca29a075d263c1bb21c7b88adf3ff6baddae1b8743cc00b66bd2c4706000000000000000e00000000000000";

test("Cetus's registered tick spacings and fee rates decode from its GlobalConfig as mainnet stores it", () => {
  const fees = decodeCetusFees(fromHex(SNAPSHOT_CONTENTS));
  assert.equal(Object.keys(fees).length, 16);
  assert.equal(fees["2"], "100");
  assert.equal(fees["60"], "2500");
  assert.equal(fees["200"], "10000");
  assert.equal(fees["220"], "20000");
  assert.equal(fees["50"], undefined);
});
