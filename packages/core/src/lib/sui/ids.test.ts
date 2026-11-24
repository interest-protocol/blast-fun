import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import test from "node:test";

import { normalizeStructTag } from "@mysten/sui/utils";

import { SUI_COIN_TYPE, USDC_COIN_TYPE } from "./coin-types.ts";
import { COIN_TYPE, COIN_TYPE_WITH_GENERICS, SUI_OBJECT_ID_PATTERN, isWholeSuiAddressInput } from "./ids.ts";

const HEX = "ab".repeat(32);

test("SUI_OBJECT_ID_PATTERN accepts only the canonical lowercase spelling", () => {
  assert.ok(SUI_OBJECT_ID_PATTERN.test(`0x${HEX}`));
  for (const value of [HEX, `0x${HEX.toUpperCase()}`, `0x${HEX}0`, "0x2", ` 0x${HEX}`]) {
    assert.equal(SUI_OBJECT_ID_PATTERN.test(value), false, value);
  }
});

test("COIN_TYPE accepts a canonical struct tag and bounds each identifier at 128 characters", () => {
  assert.ok(COIN_TYPE.test(`0x${HEX}::coin::COIN`));
  assert.ok(COIN_TYPE.test(`0x${HEX}::${"m".repeat(128)}::${"N".repeat(128)}`));
  for (const value of [`0x${HEX}::${"m".repeat(129)}::N`, `0x${HEX}::coin::COIN<u8>`, "0x2::sui::SUI", `0x${HEX}::9coin::COIN`]) {
    assert.equal(COIN_TYPE.test(value), false, value);
  }
});

test("COIN_TYPE_WITH_GENERICS adds only an optional type-argument suffix to COIN_TYPE", () => {
  assert.ok(COIN_TYPE_WITH_GENERICS.test(`0x${HEX}::coin::COIN`));
  assert.ok(COIN_TYPE_WITH_GENERICS.test(`0x${HEX}::pool::Pool<0x2::sui::SUI>`));
  assert.equal(COIN_TYPE_WITH_GENERICS.test(`0x${HEX}::${"m".repeat(129)}::N<u8>`), false);
});

test("published JSON Schemas bound coin-type identifiers as the code does", () => {
  const root = new URL("../../", import.meta.url);
  const files = globSync("modules/**/schemas/**/*.schema.json", { cwd: root });
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = readFileSync(new URL(file, root), "utf8");
    assert.equal(text.includes("[A-Za-z0-9_]*::"), false, file);
  }
});

test("isWholeSuiAddressInput takes typed input in either case, trimmed", () => {
  assert.ok(isWholeSuiAddressInput(`  0x${HEX.toUpperCase()} `));
  assert.equal(isWholeSuiAddressInput("0x2"), false);
});

test("the SUI and USDC coin types are the normalized canonical tags", () => {
  assert.equal(SUI_COIN_TYPE, normalizeStructTag("0x2::sui::SUI"));
  assert.equal(USDC_COIN_TYPE, normalizeStructTag(USDC_COIN_TYPE));
  assert.ok(COIN_TYPE.test(SUI_COIN_TYPE) && COIN_TYPE.test(USDC_COIN_TYPE));
});
