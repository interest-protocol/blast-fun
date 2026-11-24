import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import { executeRequestSchema, executeSubmissionSchema } from "./execute-request.ts";

const readSchema = (name: string) =>
  JSON.parse(readFileSync(new URL(`./schemas/${name}.schema.json`, import.meta.url), "utf8"));
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(readSchema("defs"));
const validate = ajv.compile(readSchema("execute-request"));

test("canonical base64 is preserved without coercion, trimming or decoding the signature", () => {
  for (const user_signature of [
    "Zg==",
    "Zm8=",
    "Zm9v",
    "Zm9vYg==",
    "Zm9vYmE=",
    "Zm9vYmFy",
    "/w==",
    "+/8=",
  ]) {
    const body = { user_signature };
    assert.equal(validate(body), true);
    assert.deepEqual(executeRequestSchema.parse(body), body);
    assert.deepEqual(executeSubmissionSchema.parse(body), body);
  }
});

test("the published wire pattern stays broader than canonical submission padding and pad bits", () => {
  for (const user_signature of ["A", "Zg", "Zg=", "Zh==", "Zm9=", "AAAA=="]) {
    const body = { user_signature };
    assert.equal(validate(body), true, user_signature);
    assert.equal(executeRequestSchema.safeParse(body).success, true, user_signature);
    assert.equal(executeSubmissionSchema.safeParse(body).success, false, user_signature);
  }
});

test("wire and submission reject unknown keys, missing fields, types and malformed alphabets", () => {
  const invalid: unknown[] = [
    null,
    [],
    false,
    1,
    "body",
    {},
    { user_signature: "Zg==", extra: true },
  ];
  for (const user_signature of [
    null,
    false,
    1,
    [],
    {},
    "",
    "====",
    "AA=A",
    "Zg===",
    "_w==",
    "-w==",
    " Zg==",
    "Zg== ",
    "Zg==\n",
  ]) {
    invalid.push({ user_signature });
  }
  invalid.push(JSON.parse('{"user_signature":"Zg==","__proto__":{}}'));
  for (const body of invalid) {
    assert.equal(validate(body), false, JSON.stringify(body));
    assert.equal(executeRequestSchema.safeParse(body).success, false, JSON.stringify(body));
    assert.equal(executeSubmissionSchema.safeParse(body).success, false, JSON.stringify(body));
  }
});
