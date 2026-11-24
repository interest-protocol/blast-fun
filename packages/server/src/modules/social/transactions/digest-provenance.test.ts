import assert from "node:assert/strict";
import test from "node:test";

import { bcs } from "@mysten/sui/bcs";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";

import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { verifyDigestProvenance } from "./digest-provenance.ts";

const SENDER = normalizeSuiAddress("0x1");
const OTHER = normalizeSuiAddress("0x2");
function proof(sender = SENDER, gasOwner = sender) {
  const bytes = bcs.TransactionData.serialize({ V1: {
    kind: { ProgrammableTransaction: { inputs: [], commands: [] } },
    sender,
    gasData: { owner: gasOwner, payment: [], price: "1000", budget: "2000000" },
    expiration: { None: true },
  } }).toBytes();
  return { digest: TransactionDataBuilder.getDigestFromBytes(bytes), transactionBytes: toBase64(bytes) };
}
const code = (expected: string) => (error: unknown) => error instanceof SocialRouteError && error.code === expected;

test("pending full bytes bind digest to the proven sender, including independently sponsored gas", async () => {
  for (const owner of [SENDER, OTHER]) {
    let lookups = 0;
    await verifyDigestProvenance({ ...proof(SENDER, owner), sender: SENDER }, async () => { lookups += 1; return null; });
    assert.equal(lookups, 0);
  }
});

test("another wallet cannot reserve a victim digest using the victim's bytes or changed bytes", async () => {
  const victim = proof();
  await assert.rejects(verifyDigestProvenance({ ...victim, sender: OTHER }, async () => SENDER), code("invalid_request"));
  await assert.rejects(verifyDigestProvenance({ ...proof(OTHER), digest: victim.digest, sender: OTHER }, async () => OTHER), code("invalid_request"));
});

test("malformed, noncanonical, oversized and kind-only bytes fail closed without a chain fallback", async () => {
  const digest = proof().digest;
  for (const transactionBytes of ["", "!", 1, null, "A".repeat(180_001), proof().transactionBytes + "\n", toBase64(bcs.TransactionKind.serialize({ ProgrammableTransaction: { inputs: [], commands: [] } }).toBytes())]) {
    await assert.rejects(verifyDigestProvenance({ digest, sender: SENDER, transactionBytes }, async () => { throw new Error("must not fall back"); }), code("invalid_request"));
  }
});

test("digest-only legacy requests need authoritative executed sender evidence", async () => {
  const input = { digest: proof().digest, sender: SENDER };
  await verifyDigestProvenance(input, async () => SENDER);
  await assert.rejects(verifyDigestProvenance(input, async () => OTHER), code("invalid_request"));
  await assert.rejects(verifyDigestProvenance(input, async () => null), code("service_unavailable"));
  await assert.rejects(verifyDigestProvenance(input, async () => { throw new Error("offline"); }), code("service_unavailable"));
});

test("coins reject unproven digests before entering the financial write transaction", async () => {
  const { createSocialCoinsRoutes } = await import("../coins/route.ts");
  type Dependencies = Parameters<typeof createSocialCoinsRoutes>[0];
  type Context = Parameters<Parameters<Dependencies["kit"]["route"]>[1]>[0];
  let writes = 0;
  const routes = createSocialCoinsRoutes({
    kit: { route: (_spec: unknown, handler: unknown) => handler } as Dependencies["kit"],
    database: () => ({ read: async () => ({ rows: [] }) }) as unknown as ReturnType<Dependencies["database"]>,
    fullnode: () => { throw new Error("unused"); },
    transactions: () => ({ executed: async () => null }),
    blastWallet: async () => OTHER,
  });
  const transfer = routes.transfer as unknown as (context: Context) => Promise<Response>;
  const victim = proof();
  for (const transactionBytes of [victim.transactionBytes, undefined]) {
    const context = {
      request: new Request("https://blast.test/api/social/me/transfers/11111111-1111-4111-8111-111111111111", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ coin_type: `${normalizeSuiAddress("0x2")}::sui::SUI`, amount: "1", recipient: SENDER, digest: victim.digest, ...(transactionBytes ? { transaction_bytes: transactionBytes } : {}) }),
      }),
      caller: { kind: "wallet", address: OTHER },
      account: { account_id: "22222222-2222-4222-8222-222222222222" },
      transaction: async () => { writes += 1; throw new Error("must not write"); },
    } as unknown as Context;
    await assert.rejects(transfer(context), code(transactionBytes ? "invalid_request" : "service_unavailable"));
  }
  assert.equal(writes, 0);
});
