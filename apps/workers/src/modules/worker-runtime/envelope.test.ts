import assert from "node:assert/strict";
import test from "node:test";
import { defineBlastDeployment } from "@interest-protocol/blast-deployments-sdk";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress, toBase58 } from "@mysten/sui/utils";

import { NON_PRODUCTION_MANIFEST } from "../../../test/fixtures/final-stack/non-production-deployment.ts";
import { addressBalanceGas } from "../../../test/fixtures/modules/worker-runtime/address-balance-gas.ts";
import { payFromSenderBalance } from "./address-balance.ts";
import { assertAddressBalanceEnvelope, SignerRefusal, type AddressBalanceEnvelope } from "./signer.ts";

const deployment = defineBlastDeployment(NON_PRODUCTION_MANIFEST);
const sender = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7)).toSuiAddress();
const other = normalizeSuiAddress("0xdead");
const budget = 50_000_000n;
const envelope: AddressBalanceEnvelope = { sender, gasBudgetMist: budget, chainIdentifier: deployment.chainIdentifier };
const ownedGas = { objectId: normalizeSuiAddress("0x99"), version: "1", digest: toBase58(new Uint8Array(32).fill(1)) };

/** Bytes as the runtime builds them (`payFromAddressBalance` on the deployment's chain), then `alter`. */
async function bytes(alter: (tx: Transaction) => void = () => {}): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.moveCall({ target: "0x2::test::noop" });
  addressBalanceGas(tx, { sender, gasBudgetMist: budget, chainIdentifier: deployment.chainIdentifier });
  alter(tx);
  return tx.build();
}

const validDuring = (overrides: object) => (tx: Transaction) => tx.setExpiration({
  ValidDuring: { minEpoch: "1", maxEpoch: "1", minTimestamp: null, maxTimestamp: null, chain: deployment.chainIdentifier, nonce: 0, ...overrides },
});

// This fails if any envelope guard is dropped or reordered past another, or if the
// keeper's withdrawal allowance stops admitting the Bluefin creation-fee input.
test("every signer refuses bytes outside the address-balance envelope, each for its own reason", async () => {
  const cases: [label: string, bytes: Promise<Uint8Array> | Uint8Array, envelope: AddressBalanceEnvelope, reason: string][] = [
    ["unreadable", new Uint8Array([1, 2, 3]), envelope, "unreadable transaction bytes"],
    ["another sender", bytes(), { ...envelope, sender: other }, "another sender"],
    ["another gas owner", bytes((tx) => tx.setGasOwner(other)), envelope, "another gas owner"],
    ["a budget above the cap", bytes(), { ...envelope, gasBudgetMist: budget - 1n }, "a gas budget that is zero or above the configured cap"],
    ["a zero budget", bytes((tx) => tx.setGasBudget(0n)), envelope, "a gas budget that is zero or above the configured cap"],
    ["a gas coin payment", bytes((tx) => tx.setGasPayment([ownedGas])), envelope, "a gas coin payment"],
    ["a command on the gas coin", bytes((tx) => tx.transferObjects([tx.splitCoins(tx.gas, [1n])], other)), envelope, "a command that uses the gas coin"],
    ["an epoch expiration", bytes((tx) => tx.setExpiration({ Epoch: "1" })), envelope, "an expiration other than one epoch on the deployment chain"],
    ["two epochs", bytes(validDuring({ maxEpoch: "2" })), envelope, "an expiration other than one epoch on the deployment chain"],
    ["no epoch bound", bytes(validDuring({ minEpoch: null, maxEpoch: null })), envelope, "an expiration other than one epoch on the deployment chain"],
    ["a timestamp bound", bytes(validDuring({ maxTimestamp: "1" })), envelope, "an expiration other than one epoch on the deployment chain"],
    ["another chain", bytes(validDuring({ chain: toBase58(new Uint8Array(32).fill(2)) })), envelope, "an expiration other than one epoch on the deployment chain"],
    ["a withdrawal", bytes((tx) => tx.moveCall({ target: "0x2::coin::redeem_funds", typeArguments: ["0x2::sui::SUI"], arguments: [tx.withdrawal({ amount: 1n })] })), envelope, "a balance withdrawal"],
  ];
  for (const [label, encoded, bound, reason] of cases) {
    const raw = await encoded;
    assert.throws(
      () => assertAddressBalanceEnvelope(raw, bound),
      (error: unknown) => error instanceof SignerRefusal && error.message === `Worker signature refused: ${reason}.`,
      label,
    );
  }
  assert.equal(assertAddressBalanceEnvelope(await bytes(), envelope).sender, sender);
  const withdrawal = await bytes((tx) => tx.moveCall({ target: "0x2::coin::redeem_funds", typeArguments: ["0x2::sui::SUI"], arguments: [tx.withdrawal({ amount: 1n })] }));
  assert.equal(assertAddressBalanceEnvelope(withdrawal, { ...envelope, withdrawals: "allowed" }).inputs[0]?.$kind, "FundsWithdrawal");
});

// This fails if the node's chain stops being compared with the deployment's, or if the balance
// check stops counting the SUI the transaction itself withdraws.
test("payment from the sender's balance refuses a node on another chain and a balance short of gas plus withdrawals", async () => {
  const pay = async (chain: string, addressBalance: bigint, alter: (tx: Transaction) => void = () => {}) => {
    const client = { core: {
      getCurrentSystemState: async () => ({ systemState: { epoch: "5", referenceGasPrice: "1000" } }),
      getBalance: async () => ({ balance: { addressBalance: String(addressBalance) } }),
      getChainIdentifier: async () => ({ chainIdentifier: chain }),
    } } as unknown as Parameters<typeof payFromSenderBalance>[1]["client"];
    const tx = new Transaction();
    tx.setSender(sender);
    alter(tx);
    const result = await payFromSenderBalance(tx, { client, provider: (fn) => fn(new AbortController().signal), sender, gasBudgetMist: budget, chainIdentifier: deployment.chainIdentifier });
    return { kind: result.kind, expiration: tx.getData().expiration };
  };
  const withdraw = (tx: Transaction) => tx.moveCall({ target: "0x2::coin::redeem_funds", typeArguments: ["0x2::sui::SUI"], arguments: [tx.withdrawal({ amount: 7n })] });
  assert.deepEqual(await pay(toBase58(new Uint8Array(32).fill(2)), budget * 10n), { kind: "wrong-chain", expiration: null });
  assert.equal((await pay(deployment.chainIdentifier, budget + 6n, withdraw)).kind, "insufficient-gas");
  const ready = await pay(deployment.chainIdentifier, budget + 7n, withdraw);
  assert.equal(ready.kind, "ready");
  assert.equal(ready.expiration?.ValidDuring?.chain, deployment.chainIdentifier);
});
