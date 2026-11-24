import assert from "node:assert/strict";
import test from "node:test";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { coinKindProof, readCoinPublication } from "./publish-approval.ts";

const address = (value: string) => `0x${value.padStart(64, "0")}`;
const digest = "4yUWbNQnn9KhVz9mSaQnTnmzAhHmzuHJyUz1rQpRKjat";
const packageId = address("c01");
const core = address("c02");
const owner = address("c03");
const cap = { objectId: address("ca"), version: "12", digest };
const currencyId = address("cc");
const coinType = `${packageId}::coin::COIN`;

test("resume verifies the confirmed package, creator, and exact sealed cap", async () => {
  const transaction = new Transaction();
  transaction.setSender(owner);
  transaction.setGasPrice(750);
  transaction.setGasBudget(20_000_000);
  transaction.setGasPayment([{ objectId: address("ee"), version: "1", digest }]);
  const bytes = await transaction.build();
  const owned = { $kind: "AddressOwner", AddressOwner: owner };
  const receipt = {
    digest, sender: owner, status: { success: true }, timestampMs: 123, bcs: bytes,
    effects: {
      status: { success: true },
      changedObjects: [
        { objectId: packageId, idOperation: "Created", outputState: "PackageWrite" },
        { objectId: cap.objectId, idOperation: "Created", outputVersion: cap.version, outputDigest: cap.digest, outputOwner: owned },
        { objectId: currencyId, idOperation: "Created", outputVersion: "12", outputDigest: digest, outputOwner: { ...owned, AddressOwner: address("c") } },
      ],
    },
    objectTypes: {
      [packageId]: "package",
      [cap.objectId]: `${core}::sealed_treasury_cap::SealedTreasuryCap<${coinType}>`,
      [currencyId]: `0x2::coin_registry::Currency<${coinType}>`,
    },
  };
  const client = { core: {
    async getObject(input: { objectId: string }) {
      assert.equal(input.objectId, packageId);
      return { object: { previousTransaction: digest } };
    },
    async getTransaction(input: { digest: string }) {
      assert.equal(input.digest, digest);
      return { $kind: "Transaction", Transaction: receipt };
    },
  } } as unknown as ClientWithCoreApi;
  const signal = new AbortController().signal;
  const coin = { coinType, sealedTreasuryCap: cap };
  assert.deepEqual(await readCoinPublication(client, coin, owner, core, signal), {
    digest, timestampMs: 123, kindProof: await coinKindProof(bytes),
  });
  assert.equal(await readCoinPublication(client, coin, address("c04"), core, signal), null);
  assert.equal(await readCoinPublication(client, { ...coin, sealedTreasuryCap: { ...cap, version: "13" } }, owner, core, signal), null);
});
