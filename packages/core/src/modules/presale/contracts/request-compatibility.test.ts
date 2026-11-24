import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import { allowlistBindRequestSchema, allowlistCreateRequestSchema } from "./allowlist-request.ts";
import {
  bridgeTransferRequestSchema,
  bridgeTransferSubmissionSchema,
} from "./bridge-transfer-request.ts";
import { sponsorRequestSchema, sponsorSubmissionSchema } from "./sponsor-request.ts";
import { PRESALE_EXAMPLES } from "./examples.ts";

const readSchema = (name: string) =>
  JSON.parse(readFileSync(new URL(`./schemas/${name}.schema.json`, import.meta.url), "utf8"));
const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(readSchema("defs"));
const schemas = {
  "allowlist-bind-request": allowlistBindRequestSchema,
  "allowlist-create-request": allowlistCreateRequestSchema,
  "bridge-transfer-request": bridgeTransferRequestSchema,
  "sponsor-request": sponsorRequestSchema,
};
const address = `0x${"1".repeat(64)}`;

test("remaining request schemas agree with independent published JSON Schema consumers", () => {
  for (const [name, schema] of Object.entries(schemas)) {
    const validate = ajv.compile(readSchema(name));
    const example = PRESALE_EXAMPLES[name as keyof typeof schemas];
    const values: unknown[] = [
      example,
      null,
      false,
      0,
      "",
      [],
      {},
      { ...example, extra: true },
      JSON.parse('{"__proto__":{}}'),
    ];
    for (const key of Object.keys(example)) {
      const missing = { ...example } as Record<string, unknown>;
      delete missing[key];
      values.push(missing);
      for (const value of [
        null,
        false,
        0,
        -1,
        "",
        " ",
        [],
        {},
        address,
        "0",
        "00",
        "Zg",
        "Zg==",
        "withdraw",
        "solana",
      ]) {
        values.push({ ...example, [key]: value });
      }
    }
    if (name === "allowlist-create-request") {
      for (const entries of [
        [],
        [null],
        [{}],
        [{ wallet: address }],
        [{ wallet: address, cap: "0" }],
        [{ wallet: address, cap: "00" }],
        [{ wallet: address, cap: "1", extra: true }],
      ]) {
        values.push({ ...example, entries });
      }
    }
    if (name === "sponsor-request") {
      values.push({ sender: address, transaction_kind_bytes: "Zg", intent: "withdraw" });
      values.push({
        sender: address,
        transaction_kind_bytes: "Zg==",
        intent: "withdraw",
        presale_id: address,
      });
    }
    for (const value of values) {
      assert.equal(
        schema.safeParse(value).success,
        validate(value),
        `${name}: ${JSON.stringify(value)}`,
      );
    }
  }
});

test("submission rules preserve canonical base64 and source-specific bridge hashes and u64 amounts", () => {
  const sponsor = { sender: address, transaction_kind_bytes: "Zg==", intent: "withdraw" };
  assert.equal(sponsorSubmissionSchema.safeParse(sponsor).success, true);
  for (const transaction_kind_bytes of ["Zg", "Zh==", "Zm9=", "AAAA==", "Zg==\n"]) {
    assert.equal(
      sponsorSubmissionSchema.safeParse({ ...sponsor, transaction_kind_bytes }).success,
      false,
    );
  }
  const bridge = {
    source: "ethereum",
    tx_hash: `0x${"A".repeat(64)}`,
    sui_address: address,
    amount: "1",
    presale_id: address,
  };
  assert.equal(bridgeTransferSubmissionSchema.safeParse(bridge).success, true);
  for (const amount of ["0", "00", "-1", "1.1", "18446744073709551616", "1".repeat(10_000)]) {
    assert.equal(bridgeTransferSubmissionSchema.safeParse({ ...bridge, amount }).success, false);
  }
  assert.equal(
    bridgeTransferSubmissionSchema.safeParse({ ...bridge, source: "solana" }).success,
    false,
  );
  assert.equal(
    bridgeTransferSubmissionSchema.safeParse({
      ...bridge,
      source: "solana",
      tx_hash: "2".repeat(88),
    }).success,
    true,
  );
});
