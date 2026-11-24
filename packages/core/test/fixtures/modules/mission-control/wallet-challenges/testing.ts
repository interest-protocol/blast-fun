import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";

// Deterministic non-production signers for contract and route integration tests.
export const syntheticSlushSigner = Ed25519Keypair.fromSecretKey(
  Uint8Array.from({ length: 32 }, (_, index) => index + 1),
);

export const syntheticEmbeddedSigner = Secp256k1Keypair.fromSecretKey(
  Uint8Array.from({ length: 32 }, (_, index) => 32 - index),
);
