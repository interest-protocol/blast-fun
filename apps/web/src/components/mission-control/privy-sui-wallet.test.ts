import assert from "node:assert/strict";
import test from "node:test";

import { parseSerializedSignature } from "@mysten/sui/cryptography";
import { Ed25519Keypair, Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";
import { fromHex, toHex } from "@mysten/sui/utils";
import { verifyTransactionSignature } from "@mysten/sui/verify";

import {
  findEmbeddedSuiWallet,
  privySuiSigner,
  type SignRawHash,
} from "./privy-sui-wallet.ts";

const keypair = Ed25519Keypair.fromSecretKey(
  Uint8Array.from({ length: 32 }, (_, index) => index + 1),
);
const transactionBytes = Uint8Array.of(1, 2, 3);

test("findEmbeddedSuiWallet only selects Privy's embedded Sui wallet", () => {
  const wallet = findEmbeddedSuiWallet({
    linkedAccounts: [
      {
        address: "0xethereum",
        chainType: "ethereum",
        connectorType: "embedded",
        type: "wallet",
        walletClientType: "privy",
      },
      {
        address: "0xexternal",
        chainType: "sui",
        connectorType: "injected",
        type: "wallet",
        walletClientType: "slush",
      },
      {
        address: keypair.toSuiAddress(),
        chainType: "sui",
        connectorType: "embedded",
        id: "wallet-1",
        imported: false,
        publicKey: keypair.getPublicKey().toBase64(),
        recoveryMethod: "privy-v2",
        type: "wallet",
        walletClientType: "privy",
      },
    ],
  });

  assert.deepEqual(wallet, {
    address: keypair.toSuiAddress(),
    publicKey: keypair.getPublicKey().toBase64(),
  });
});

test("Privy raw Ed25519 signing produces a valid Sui transaction signature", async () => {
  const signingInputs: Parameters<SignRawHash>[0][] = [];
  const signRawHash: SignRawHash = async (input) => {
    signingInputs.push(input);
    const signature = await keypair.sign(fromHex(input.hash.slice(2)));
    return { signature: `0x${toHex(signature)}` };
  };

  const signer = privySuiSigner(
    {
      address: keypair.toSuiAddress(),
      publicKey: `0x${toHex(keypair.getPublicKey().toRawBytes())}`,
    },
    signRawHash,
  );
  const signed = await signer.signTransaction(transactionBytes);
  const expected = await keypair.signTransaction(transactionBytes);
  const signingInput = signingInputs[0];

  assert.equal(signingInput.address, keypair.toSuiAddress());
  assert.equal(signingInput.chainType, "sui");
  assert.match(signingInput.hash, /^0x[0-9a-f]{64}$/);
  assert.equal(signed.signature, expected.signature);
  const publicKey = await verifyTransactionSignature(
    transactionBytes,
    signed.signature,
    { offline: true },
  );
  assert.equal(publicKey.toSuiAddress(), signer.toSuiAddress());
});

test("embedded signing rejects a public key that does not own the wallet address", () => {
  const other = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7));
  let signingCalls = 0;

  assert.throws(
    () => privySuiSigner(
      { address: other.toSuiAddress(), publicKey: keypair.getPublicKey().toBase64() },
      async () => {
        signingCalls += 1;
        return { signature: `0x${"00".repeat(64)}` };
      },
    ),
    /key does not match its address/,
  );
  assert.equal(signingCalls, 0);
});

// A real embedded wallet from Privy's /users/me: `public_key` is Sui's
// flag-prefixed Ed25519 key (0x00 flag + 32 bytes) as 66 hex chars, no 0x.
const PRIVY_SUI_ACCOUNT = {
  address: "0x783af176eb732ca9767d3332c91d104def16a494789a9a869ba9f91a1ba336a3",
  chainType: "sui",
  connectorType: "embedded",
  id: "privy-wallet-id",
  imported: false,
  publicKey: "00b5a7cd3ebe954ea9ad521c68da67c8bbed40541e70abe98d467255add9bb3b5d",
  recoveryMethod: "privy-v2",
  type: "wallet",
  walletClientType: "privy",
} as const;
const privyPublicKey = new Ed25519PublicKey(
  fromHex(PRIVY_SUI_ACCOUNT.publicKey.slice(2)),
);

const signWithoutKey: SignRawHash = async () => ({
  signature: `0x${"00".repeat(64)}`,
});

async function signWithPublicKey(publicKey: string) {
  const signingInputs: Parameters<SignRawHash>[0][] = [];
  const signer = privySuiSigner(
    { address: PRIVY_SUI_ACCOUNT.address, publicKey },
    async (input) => {
      signingInputs.push(input);
      return signWithoutKey(input);
    },
  );
  const { signature } = await signer.signTransaction(transactionBytes);
  return { address: signer.toSuiAddress(), signature, signingInputs };
}

test("Privy's flag-prefixed 66-character hex key signs for its own address", async () => {
  const wallet = findEmbeddedSuiWallet({ linkedAccounts: [PRIVY_SUI_ACCOUNT] });
  assert.deepEqual(wallet, {
    address: PRIVY_SUI_ACCOUNT.address,
    publicKey: PRIVY_SUI_ACCOUNT.publicKey,
  });

  const { address, signature, signingInputs } = await signWithPublicKey(
    PRIVY_SUI_ACCOUNT.publicKey,
  );
  const serialized = parseSerializedSignature(signature);

  assert.equal(address, PRIVY_SUI_ACCOUNT.address);
  assert.equal(signingInputs.length, 1);
  assert.equal(signingInputs[0].address, PRIVY_SUI_ACCOUNT.address);
  assert.equal(serialized.signatureScheme, "ED25519");
  assert.deepEqual(serialized.publicKey, privyPublicKey.toRawBytes());
});

test("raw, 0x-prefixed, and base64 public keys still decode", async () => {
  const raw = toHex(privyPublicKey.toRawBytes());
  for (const publicKey of [
    raw,
    `0x${raw}`,
    `0x${PRIVY_SUI_ACCOUNT.publicKey}`,
    PRIVY_SUI_ACCOUNT.publicKey.toUpperCase(),
    privyPublicKey.toBase64(),
    privyPublicKey.toSuiPublicKey(),
  ]) {
    const { address } = await signWithPublicKey(publicKey);
    assert.equal(address, PRIVY_SUI_ACCOUNT.address, publicKey);
  }
});

test("unsupported public key encodings fail before Privy is asked to sign", () => {
  const raw = toHex(privyPublicKey.toRawBytes());
  const secp256k1 = Secp256k1Keypair.fromSecretKey(new Uint8Array(32).fill(9));
  for (const publicKey of [
    `01${raw}`, // 32 bytes behind the Secp256k1 flag
    secp256k1.getPublicKey().toSuiPublicKey(), // a valid Sui key, not Ed25519
    raw.slice(2), // 31 bytes
    `${PRIVY_SUI_ACCOUNT.publicKey}00`, // 34 bytes
    "not a public key!",
  ]) {
    let signingCalls = 0;
    assert.throws(
      () => privySuiSigner(
        { address: PRIVY_SUI_ACCOUNT.address, publicKey },
        async (input) => {
          signingCalls += 1;
          return signWithoutKey(input);
        },
      ),
      { message: "Privy returned an unsupported Sui public key encoding." },
      publicKey,
    );
    assert.equal(signingCalls, 0, publicKey);
  }
});
