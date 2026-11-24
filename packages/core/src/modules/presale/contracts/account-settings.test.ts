import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import { accountSettingsSchema } from "./account-settings.ts";

const published = JSON.parse(
  readFileSync(new URL("./schemas/account-settings-request.schema.json", import.meta.url), "utf8"),
);
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(published);

test("Zod and the published settings contract accept every explorer/theme pair unchanged", () => {
  for (const explorer of ["suivision", "suiscan"]) {
    for (const theme of ["system", "dark", "light"]) {
      const body = { explorer, theme };
      assert.equal(validate(body), true);
      assert.deepEqual(accountSettingsSchema.parse(body), body);
    }
  }
});

test("both validators reject missing, unknown and mistyped settings without coercion or stripping", () => {
  const valid = { explorer: "suiscan", theme: "dark" };
  const invalid: unknown[] = [
    null,
    [],
    false,
    0,
    "suiscan",
    {},
    { explorer: "suiscan" },
    { theme: "dark" },
    { ...valid, saved: true },
    { ...valid, extra: null },
    JSON.parse('{"explorer":"suiscan","theme":"dark","__proto__":{}}'),
  ];
  for (const value of [null, false, 0, [], {}, "", "Dark", "etherscan", " suiscan", "dark "]) {
    invalid.push({ ...valid, explorer: value }, { ...valid, theme: value });
  }
  for (const body of invalid) {
    assert.equal(validate(body), false, JSON.stringify(body));
    assert.equal(accountSettingsSchema.safeParse(body).success, false, JSON.stringify(body));
  }
});
