import assert from "node:assert/strict";
import test from "node:test";
import { Transaction } from "@mysten/sui/transactions";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { prepareVestingTransaction } from "@blast/server/modules/vesting/prepare-transaction.ts";

const sender = `0x${"a".repeat(64)}`;
const request = {
  sender,
  caller: { kind: "privy", did: "did:privy:test" } as const,
  ip: "203.0.113.1",
  signal: new AbortController().signal,
};

test("a Privy vesting transaction sponsors its kind without selecting wallet gas", async () => {
  const tx = new Transaction();
  tx.moveCall({ target: "0x2::example::create", arguments: [tx.pure.u64(1)] });
  const build = tx.build.bind(tx);
  tx.build = async (options) => {
    if (!options?.onlyTransactionKind)
      throw new Error(
        "Unable to perform gas selection due to insufficient SUI balance",
      );
    return build(options);
  };
  let reserved = false;
  const result = await prepareVestingTransaction(
    tx,
    request,
    {} as SuiGrpcClient,
    {
      async sponsor(input) {
        reserved = true;
        assert.equal(input.intent, "vesting");
        assert.equal(input.presaleId, null);
        assert.deepEqual(input.caller, request.caller);
        assert.equal(input.sender, sender);
        assert.ok(input.kindBytes.length);
        return {
          reservation_id: "reservation",
          transaction_bytes: "AQID",
          expires_at_ms: 1234,
          gas_budget: "2000000",
          sponsor_signature: "",
        };
      },
    },
  );
  assert.equal(reserved, true);
  assert.deepEqual(result.bytes, new Uint8Array([1, 2, 3]));
  assert.equal(result.reservationId, "reservation");
  assert.equal(result.expiresAt, 1234);
});

test("a wallet session is sponsored like a Privy wallet", async () => {
  const tx = new Transaction();
  tx.moveCall({ target: "0x2::example::claim" });
  const caller = { kind: "wallet", address: sender } as const;
  const prepared = await prepareVestingTransaction(
    tx,
    { ...request, caller },
    {} as SuiGrpcClient,
    {
      async sponsor(input) {
        assert.deepEqual(input.caller, caller);
        return {
          reservation_id: "wallet-reservation",
          transaction_bytes: "BAU=",
          expires_at_ms: 5678,
          gas_budget: "2000000",
          sponsor_signature: "",
        };
      },
    },
  );
  assert.deepEqual(prepared.bytes, new Uint8Array([4, 5]));
  assert.equal(prepared.reservationId, "wallet-reservation");
});

test("a sponsor refusal never retries the transaction with wallet gas", async () => {
  const tx = new Transaction();
  tx.moveCall({ target: "0x2::example::claim" });
  const build = tx.build.bind(tx);
  tx.build = async (options) => {
    assert.equal(options?.onlyTransactionKind, true);
    return build(options);
  };
  await assert.rejects(
    prepareVestingTransaction(tx, request, {} as SuiGrpcClient, {
      sponsor: async () => {
        throw new Error("Sponsor unavailable");
      },
    }),
    /Sponsor unavailable/,
  );
});
