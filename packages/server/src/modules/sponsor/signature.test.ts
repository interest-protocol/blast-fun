import assert from "node:assert/strict";
import test from "node:test";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { MultiSigPublicKey } from "@mysten/sui/multisig";
import { isValidTransactionSignature } from "@mysten/sui/verify";
import { getZkLoginSignature, toZkLoginPublicIdentifier } from "@mysten/sui/zklogin";
import { createSponsorSignatureVerifier } from "./signature.ts";

const ISSUER = "https://synthetic-issuer.test";
const TX_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

/** A zkLogin signature shaped like Slush's Google and Apple accounts (synthetic proof). */
function zkLogin() {
  const signature = getZkLoginSignature({
    inputs: {
      proofPoints: { a: ["1", "2", "3"], b: [["1", "2"], ["3", "4"], ["5", "6"]], c: ["1", "2", "3"] },
      issBase64Details: { value: Buffer.from(`"iss":"${ISSUER}",`).toString("base64url"), indexMod4: 0 },
      headerBase64: "synthetic",
      addressSeed: "1",
    },
    maxEpoch: 1,
    userSignature: new Uint8Array(97),
  });
  const publicKey = toZkLoginPublicIdentifier(1n, ISSUER, { legacyAddress: false });
  return { signature, publicKey, address: publicKey.toSuiAddress() };
}

/** A node whose `verifySignature` answers `valid` (or throws), recording what it was asked. */
function node(answer: boolean | Error) {
  const asked: Array<Record<string, unknown>> = [];
  const client = {
    core: {
      async verifySignature(input: Record<string, unknown>) {
        asked.push(input);
        if (answer instanceof Error) throw answer;
        return { valid: answer, reason: answer ? null : "synthetic refusal" };
      },
    },
  } as unknown as ClientWithCoreApi;
  return { client, asked };
}

test("regression (Slush, 2026-11-21): a zkLogin signature is checked by the node, where the offline check threw", async () => {
  const { signature, address } = zkLogin();
  // The bug: execute checked offline, the SDK throws for zkLogin, and the route answered invalid_signature.
  await assert.rejects(isValidTransactionSignature(TX_BYTES, signature, { address, offline: true }), /zkLogin/);
  const valid = node(true);
  assert.equal(await createSponsorSignatureVerifier(() => valid.client)(TX_BYTES, signature, address), true);
  assert.equal(valid.asked.length, 1);
  assert.deepEqual(valid.asked[0]?.transaction, TX_BYTES, "the reservation's exact bytes");
  assert.equal(valid.asked[0]?.address, address, "the reservation's sender");
  const refused = node(false);
  assert.equal(await createSponsorSignatureVerifier(() => refused.client)(TX_BYTES, signature, address), false);
});

test("a multisig with a zkLogin member also goes to the node", async () => {
  const { signature, publicKey } = zkLogin();
  const multisig = MultiSigPublicKey.fromPublicKeys({ threshold: 1, publicKeys: [{ publicKey, weight: 1 }] });
  const valid = node(true);
  const verify = createSponsorSignatureVerifier(() => valid.client);
  assert.equal(await verify(TX_BYTES, multisig.combinePartialSignatures([signature]), multisig.toSuiAddress()), true);
  assert.equal(valid.asked.length, 1);
});

test("a node that cannot answer rejects, so execute does not count it as a wrong signature", async () => {
  const { signature, address } = zkLogin();
  const down = node(new Error("node down"));
  await assert.rejects(createSponsorSignatureVerifier(() => down.client)(TX_BYTES, signature, address), /node down/);
});

test("a plain key is checked locally: the node is never asked", async () => {
  const signer = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(21));
  const { signature } = await signer.signTransaction(TX_BYTES);
  const verify = createSponsorSignatureVerifier(() => assert.fail("a plain key never reaches the node"));
  assert.equal(await verify(TX_BYTES, signature, signer.toSuiAddress()), true);
  assert.equal(await verify(TX_BYTES, signature, `0x${"1".repeat(64)}`), false, "another address");
  assert.equal(await verify(new Uint8Array([9]), signature, signer.toSuiAddress()), false, "other bytes");
  assert.equal(await verify(TX_BYTES, "not-a-signature", signer.toSuiAddress()), false, "malformed");
});

test("a zkLogin or multisig signature for another address is false without asking the node", async () => {
  const { signature, publicKey } = zkLogin();
  const multisig = MultiSigPublicKey.fromPublicKeys({ threshold: 1, publicKeys: [{ publicKey, weight: 1 }] });
  const verify = createSponsorSignatureVerifier(() => assert.fail("another address never reaches the node"));
  const other = `0x${"1".repeat(64)}`;
  assert.equal(await verify(TX_BYTES, signature, other), false);
  assert.equal(await verify(TX_BYTES, multisig.combinePartialSignatures([signature]), other), false);
});
