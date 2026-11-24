import assert from "node:assert/strict";
import test from "node:test";
import { Transaction } from "@mysten/sui/transactions";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { bytes as rewardBytes, intents } from "../../../test/fixtures/modules/vault-rewards/rewards.ts";
import { attemptOnce, estimateGasBudget } from "./attempt.ts";
import { settleSubmission, type OpenSubmission } from "./submissions.ts";

const bytes = Uint8Array.of(1,2,3);
const digest = "fixture-digest";
const signed = { digest, signature: "fixture-signature" };
const bounds = { providerTimeoutMs: 100, confirmTimeoutMs: 100 };

test("custody is committed before a transaction can reach the node", async () => {
  const calls: string[] = [];
  const client = { core: {
    simulateTransaction: async () => { calls.push("simulate"); return { $kind: "Transaction", Transaction: {} }; },
    executeTransaction: async ({ transaction }: {transaction:Uint8Array}) => {
      calls.push("send"); assert.deepEqual(transaction,bytes);
      return { Transaction: { effects: { transactionDigest:digest,status:{success:true} } } };
    },
  } } as unknown as ClientWithCoreApi;
  const result = await attemptOnce({ client,bytes,bounds,
    sign: async (actual) => { assert.deepEqual(actual,bytes); calls.push("sign"); return signed; },
    beforeSubmit: async () => { calls.push("persist"); return true; },
    reconcile: async () => { calls.push("reconcile"); return "chain"; },
  });
  assert.equal(result.outcome,"executed");
  assert.deepEqual(calls,["simulate","sign","persist","send","reconcile"]);
});

test("a lost custody lease refuses submission after signing", async () => {
  let sent = 0;
  const client = { core: { simulateTransaction:async()=>({$kind:"Transaction",Transaction:{}}),executeTransaction:async()=>{sent++;} } } as unknown as ClientWithCoreApi;
  const result = await attemptOnce({client,bytes,bounds,sign:async()=>signed,beforeSubmit:async()=>false,reconcile:async()=>null});
  assert.equal(result.outcome,"not-submitted"); assert.equal(sent,0);
});

test("unknown bytes remain live through their epoch; expiry never resends", async () => {
  const submission:OpenSubmission = {digest,bytes,expiresEpoch:5n,job:"fixture",recordKeys:["vault"],intent:{}};
  let epoch=5n,resent=0;
  const client = { core: {getTransaction:async()=>{throw new Error("unavailable");},getCurrentSystemState:async()=>({systemState:{epoch}})} } as unknown as ClientWithCoreApi;
  const provider = async <T>(call:(signal:AbortSignal)=>Promise<T>)=>call(new AbortController().signal);
  const settle = () => settleSubmission({client,submission,provider,resend:async()=>{resent++;return null;}});
  assert.equal(await settle(),null); assert.equal(resent,1);
  epoch=6n;assert.equal(await settle(),"expired");assert.equal(resent,1);
});

test("gas estimation signs, persists and sends the same re-simulated bytes using the storage rebate and headroom", async () => {
  const initial = await rewardBytes(intents[2], (tx) => tx.setGasBudget(1_000_000_000n));
  const simulations: Uint8Array[] = [];
  const gasUsed = { computationCost: "600000000", storageCost: "500000000", storageRebate: "400000000" };
  const client = { core: {
    simulateTransaction: async ({ transaction, doGasSelection }: { transaction: Uint8Array; doGasSelection: boolean }) => {
      assert.equal(doGasSelection, true);
      simulations.push(transaction);
      return { $kind: "Transaction", gasPaymentMocked: false, Transaction: { bcs: transaction, effects: { gasUsed } } };
    },
    executeTransaction: async ({ transaction }: { transaction: Uint8Array }) => {
      assert.deepEqual(transaction, simulations[1]);
      return { Transaction: { effects: { transactionDigest: digest, status: { success: true } } } };
    },
  } } as unknown as ClientWithCoreApi;
  const estimate = await estimateGasBudget(client, initial, 1_000_000_000n, bounds);
  assert.equal(estimate.kind, "fits");
  const transaction = Transaction.from(initial);
  transaction.setGasBudget(estimate.budgetMist);
  const finalBytes = await transaction.build();
  const result = await attemptOnce({
    client,
    bytes: finalBytes,
    bounds,
    estimatedGasBudgetMist: estimate.budgetMist,
    sign: async (bytesToSign) => {
      assert.equal(simulations.length, 2);
      assert.deepEqual(bytesToSign, simulations[1]);
      return signed;
    },
    beforeSubmit: async (signedDigest, signature) => {
      assert.equal(signedDigest, digest);
      assert.equal(signature, signed);
      return true;
    },
    reconcile: async () => null,
  });
  assert.equal(result.outcome, "executed");
  assert.deepEqual(simulations.map((data) => Transaction.from(data).getData().gasData.budget), ["1000000000", "770000000"]);
});

test("an estimated gas cost above the available budget never reaches signing", async () => {
  const initial = await rewardBytes(intents[2], (tx) => tx.setGasBudget(1_000_000_000n));
  const client = { core: {
    simulateTransaction: async () => ({
      $kind: "Transaction",
      gasPaymentMocked: false,
      Transaction: { bcs: initial, effects: { gasUsed: { computationCost: "900000000", storageCost: "100000001", storageRebate: "0" } } },
    }),
  } } as unknown as ClientWithCoreApi;
  assert.deepEqual(await estimateGasBudget(client, initial, 1_000_000_000n, bounds), { kind: "capacity" });
  const result = await attemptOnce({
    client,
    bytes: initial,
    bounds,
    estimatedGasBudgetMist: 1_000_000_000n,
    sign: async () => assert.fail("over-budget bytes must not be signed"),
    beforeSubmit: async () => assert.fail("over-budget bytes must not enter the journal"),
    reconcile: async () => null,
  });
  assert.equal(result.reason, "not-admitted");
  assert.equal(result.digest, null);
});


test("gas probes split on Sui gas exhaustion and reject changed simulated bytes", async () => {
  const initial = await rewardBytes(intents[2], (tx) => tx.setGasBudget(1_000_000_000n));
  const changed = await rewardBytes(intents[2], (tx) => tx.setGasBudget(2_000_000_000n));
  let failed = true;
  let returned = initial;
  const client = { core: {
    simulateTransaction: async () => failed ? {
      $kind: "FailedTransaction",
      gasPaymentMocked: false,
      FailedTransaction: { bcs: returned, status: { success: false, error: { $kind: "Unknown", message: "InsufficientGas in command 57" } } },
    } : {
      $kind: "Transaction",
      gasPaymentMocked: false,
      Transaction: { bcs: returned, effects: { gasUsed: { computationCost: "100", storageCost: "20", storageRebate: "0" } } },
    },
  } } as unknown as ClientWithCoreApi;
  assert.deepEqual(await estimateGasBudget(client, initial, 1_000_000_000n, bounds), { kind: "capacity" });
  failed = false;
  returned = changed;
  assert.deepEqual(await estimateGasBudget(client, initial, 1_000_000_000n, bounds), { kind: "unavailable" });
});
