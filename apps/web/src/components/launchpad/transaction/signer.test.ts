import assert from "node:assert/strict";
import test from "node:test";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fromBase64, fromHex, toBase64, toHex } from "@mysten/sui/utils";
import { verifyTransactionSignature } from "@mysten/sui/verify";

import type { SignRawHash } from "#web/components/mission-control/privy-sui-wallet.ts";

import { isUserRejection, privySigner, walletSigner, type LaunchpadSigner } from "./signer.ts";

const keypair = Ed25519Keypair.fromSecretKey(Uint8Array.from({ length: 32 }, (_, index) => index + 7));
const BYTES = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

const signRawHash: SignRawHash = async ({ hash }) => ({
  signature: `0x${toHex(await keypair.sign(fromHex(hash.slice(2))))}`,
});

function privy() {
  return privySigner({
    wallet: { address: keypair.toSuiAddress(), publicKey: keypair.getPublicKey().toBase64() },
    signRawHash,
    network: "localnet",
  });
}

function wallet(chains: readonly string[] = ["sui:localnet", "sui:mainnet"], network = "localnet") {
  const requests: string[] = [];
  const signer = walletSigner({
    walletName: "Slush",
    account: { address: keypair.toSuiAddress(), chains },
    network,
    async signTransaction({ transaction }) {
      requests.push(transaction);
      return keypair.signTransaction(fromBase64(transaction));
    },
  });
  return { signer, requests };
}

async function assertSignsExactBytes(signer: LaunchpadSigner) {
  const signed = await signer.signTransaction(BYTES);
  assert.equal(signed.bytes, toBase64(BYTES));
  const publicKey = await verifyTransactionSignature(BYTES, signed.signature, { offline: true });
  assert.equal(publicKey.toSuiAddress(), signer.address);
}

test("Privy and direct wallets expose the same signer contract and sign the exact bytes", async () => {
  const embedded = privy();
  const direct = wallet().signer;
  assert.deepEqual(Object.keys(embedded).sort(), Object.keys(direct).sort());
  assert.deepEqual(Object.keys(direct).sort(), ["address", "chain", "kind", "label", "signTransaction"]);
  assert.equal(embedded.kind, "privy");
  assert.equal(direct.kind, "wallet");
  assert.equal(embedded.chain, "sui:localnet");
  assert.equal(direct.chain, "sui:localnet");
  await assertSignsExactBytes(embedded);
  await assertSignsExactBytes(direct);
});

test("signers need no Blast Account, member session, or backend call", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("unexpected network call");
  }) as typeof fetch;
  try {
    await assertSignsExactBytes(privy());
    await assertSignsExactBytes(wallet().signer);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0);
});

test("a wallet reports the chain it would actually sign for", () => {
  assert.equal(wallet(["sui:testnet"]).signer.chain, "sui:testnet", "the wallet account lacks the app network");
  assert.equal(wallet(["solana:mainnet"]).signer.chain, null);
  assert.equal(wallet(["sui:mainnet"], "mainnet").signer.chain, "sui:mainnet");
});

test("the wallet is asked to sign the reviewed bytes, not a rebuilt transaction", async () => {
  const { signer, requests } = wallet();
  await signer.signTransaction(BYTES);
  assert.deepEqual(requests, [toBase64(BYTES)]);
});

test("user rejections are told apart from other signing failures", () => {
  assert.equal(isUserRejection(new Error("User rejected the request.")), true);
  assert.equal(isUserRejection(Object.assign(new Error("x"), { code: 4001 })), true);
  assert.equal(isUserRejection(new Error("The user cancelled the signature")), true);
  assert.equal(isUserRejection(new Error("Denied by user")), true);
  assert.equal(isUserRejection(new Error("Network request failed")), false);
  assert.equal(isUserRejection("rejected"), false);
});
