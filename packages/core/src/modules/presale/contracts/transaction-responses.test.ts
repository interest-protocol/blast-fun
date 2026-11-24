import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import { allowlistProofResponseSchema, executeResponseSchema, sponsorResponseSchema, sponsoredTransactionSchema, executedSponsoredSchema } from "./transaction-responses.ts";

const ajv = new Ajv2020({ strict: true });
const document = (name: string) => JSON.parse(readFileSync(new URL(`./schemas/${name}.schema.json`, import.meta.url), "utf8"));
ajv.addSchema(document("defs"));

function parity(name: string, schema: { safeParse(value: unknown): { success: boolean } }, cases: readonly unknown[]) {
  const accepts = ajv.compile(document(name));
  for (const value of cases) {
    assert.equal(schema.safeParse(value).success, accepts(value), `${name}: ${JSON.stringify(value)}`);
  }
}

test("presale transaction response schemas preserve the published wire constraints", () => {
  const sponsor = { reservation_id: "r1", transaction_bytes: "AQ==", sponsor_signature: "", expires_at_ms: 1, gas_budget: "1" };
  parity("sponsor-response", sponsorResponseSchema, [sponsor, { ...sponsor, reservation_id: "😀".repeat(128) }, { ...sponsor, sponsor_signature: "unexpected" }, { ...sponsor, transaction_bytes: "invalid bytes" }, { ...sponsor, expires_at_ms: -1 }, { ...sponsor, extra: true }]);
  const executed = { digest: "1".repeat(32), effects: { status: "success", gas_used: "-1" } };
  parity("execute-response", executeResponseSchema, [executed, { ...executed, effects: { status: "failure", gas_used: "0" } }, { ...executed, effects: { status: "success", gas_used: "-0" } }, { ...executed, digest: "invalid" }]);
  const proof = { index: "0", wallet_cap: "10", proof: ["a".repeat(64)] };
  parity("allowlist-proof-response", allowlistProofResponseSchema, [proof, { ...proof, proof: [] }, { ...proof, index: "01" }, { ...proof, proof: ["0xaa"] }, { ...proof, proof: Array(17).fill("a".repeat(64)) }]);
});

test("signing projections preserve bytes and digest for the existing semantic verifier", () => {
  const sponsor = { reservation_id: "r1", transaction_bytes: "%not base64%", expires_at_ms: 1, gas_budget: "2" };
  assert.deepEqual(sponsoredTransactionSchema.parse(sponsor), sponsor);
  const executed = { digest: "mismatched digest", effects: { status: "failure", gas_used: "1" } };
  assert.deepEqual(executedSponsoredSchema.parse(executed), executed);
});
