import assert from "node:assert/strict";
import test from "node:test";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1";

import { loadSignerKey, refuseForeignSignerKeys } from "./keys.ts";

const key = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(3));
const secret = key.getSecretKey();
const variable = "BLAST_WORKER_SIGNER_KEY";

// This fails if a process loads a key beside another signer key, loads a missing,
// malformed or non-Ed25519 key, puts a key value in an error, or stops trimming.
test("a worker loads only its own Ed25519 key, alone", () => {
  const refusals: [label: string, environment: Record<string, string | undefined>, message: string][] = [
    ["missing", {}, "BLAST_WORKER_SIGNER_KEY is required."],
    ["blank", { [variable]: "  " }, "BLAST_WORKER_SIGNER_KEY is required."],
    ["beside another key", { [variable]: secret, VAULT_REWARDS_SIGNER_KEY: secret }, "VAULT_REWARDS_SIGNER_KEY must not be set: this process signs with BLAST_WORKER_SIGNER_KEY alone."],
    ["another key and no own key", { AUTO_LP_SIGNER_KEY: secret }, "AUTO_LP_SIGNER_KEY must not be set: this process signs with BLAST_WORKER_SIGNER_KEY alone."],
    ["not Bech32", { [variable]: "suiprivkey-not-a-key" }, "BLAST_WORKER_SIGNER_KEY is not a Bech32-encoded Sui Ed25519 private key."],
    ["not Ed25519", { [variable]: Secp256k1Keypair.fromSecretKey(new Uint8Array(32).fill(3)).getSecretKey() }, "BLAST_WORKER_SIGNER_KEY is not a Bech32-encoded Sui Ed25519 private key."],
  ];
  for (const [label, environment, message] of refusals) {
    assert.throws(() => loadSignerKey(environment, variable), (error: unknown) => error instanceof Error && error.message === message, label);
  }
  // A blank foreign variable is not a key; the own key is trimmed.
  assert.equal(loadSignerKey({ [variable]: ` ${secret}\n`, VAULT_REWARDS_SIGNER_KEY: " " }, variable).toSuiAddress(), key.toSuiAddress());
  // A command that signs nothing refuses every key; with none set it passes.
  assert.throws(() => refuseForeignSignerKeys({ BLAST_BUYBACK_SIGNER_KEY: secret }, null), /^Error: BLAST_BUYBACK_SIGNER_KEY must not be set: this command holds no signer key\.$/);
  refuseForeignSignerKeys({ BLAST_WORKER_ALERT_WEBHOOK_URL: "https://example.invalid" }, null);
});
