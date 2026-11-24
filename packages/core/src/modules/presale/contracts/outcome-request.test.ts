import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import { outcomeRequestSchema, outcomeSubmissionSchema } from "./outcome-request.ts";

const readSchema = (name: string) =>
  JSON.parse(readFileSync(new URL(`./schemas/${name}.schema.json`, import.meta.url), "utf8"));
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(readSchema("defs"));
const validate = ajv.compile(readSchema("outcome-request"));
const valid = { presale_id: `0x${"ab".repeat(32)}`, tx_digest: "1".repeat(43) };

test("the Zod wire schema preserves the published digest range; submission retains its stricter range", () => {
  for (const length of [31, 32, 42, 43, 44, 45]) {
    const body = { ...valid, tx_digest: "1".repeat(length) };
    const wireValid = length >= 32 && length <= 44;
    assert.equal(validate(body), wireValid);
    assert.equal(outcomeRequestSchema.safeParse(body).success, wireValid);
    assert.equal(outcomeSubmissionSchema.safeParse(body).success, length === 43 || length === 44);
  }
  assert.deepEqual(outcomeSubmissionSchema.parse(valid), valid);
});

test("both wire validators reject malformed, missing, unknown and mistyped fields", () => {
  const invalid: unknown[] = [
    null,
    [],
    false,
    1,
    "body",
    {},
    { presale_id: valid.presale_id },
    { tx_digest: valid.tx_digest },
    { ...valid, sender: valid.presale_id },
    JSON.parse(`${JSON.stringify(valid).slice(0, -1)},"__proto__":{}}`),
  ];
  for (const value of [null, false, 1, [], {}, ""]) {
    invalid.push({ ...valid, presale_id: value }, { ...valid, tx_digest: value });
  }
  for (const presale_id of [
    "0x1",
    valid.presale_id.toUpperCase(),
    ` ${valid.presale_id}`,
    `${valid.presale_id} `,
  ]) {
    invalid.push({ ...valid, presale_id });
  }
  for (const tx_digest of [
    "0".repeat(43),
    "I".repeat(43),
    "O".repeat(43),
    "l".repeat(43),
    ` ${valid.tx_digest}`,
  ]) {
    invalid.push({ ...valid, tx_digest });
  }
  for (const body of invalid) {
    assert.equal(validate(body), false, JSON.stringify(body));
    assert.equal(outcomeRequestSchema.safeParse(body).success, false, JSON.stringify(body));
    assert.equal(outcomeSubmissionSchema.safeParse(body).success, false, JSON.stringify(body));
  }
});

test("both wire and submission validators reject an address with a trailing newline", () => {
  const body = { ...valid, presale_id: `${valid.presale_id}\n` };
  assert.equal(validate(body), false);
  assert.equal(outcomeRequestSchema.safeParse(body).success, false);
  assert.equal(outcomeSubmissionSchema.safeParse(body).success, false);
});
