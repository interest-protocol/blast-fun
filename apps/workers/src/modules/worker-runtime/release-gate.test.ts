import assert from "node:assert/strict";
import test from "node:test";
import { parseReleaseGateCommand, releaseGateDigest, releaseGateIdentityFromEnvironment, type ReleaseGateIdentity } from "./release-gate.ts";

// The identities whose gates production recorded on 2026-11-09 (public chain data), and the digests it stored.
const fingerprint = "efe971beca5639cb0b181e39dc1851a08d3ef5d7fa385a2557907750c807bbda";
const production: readonly (readonly [ReleaseGateIdentity, string])[] = [
  [{ role: "blast-keeper", network: "mainnet", fingerprint, signerAddress: "0x69002e1a31084536ae6850510e2ee304a55db7cf3b1486e33680970a0b67cbe5" },
    "4a2c785cb1f070c1860e8b0df54903383247a88e0037d6ca2f73d4536dba07f6"],
  [{ role: "vault-rewards", network: "mainnet", fingerprint, signerAddress: "0x6c0bd3e93f303b550245a55e1d92245d1a8776bfe37e1083186686a148626dff",
    adminCapId: "0xd567cfb04bca1c48a3e5c7b3a1f8fbd9a9a014ffbb53b94aa39943289b5841ae" },
    "cdba9e090a8124bc2e2e7f14164d2a8b6ffdb2ac2dc0c0aab5ac68410ca780b4"],
  [{ role: "vault-buyback", network: "mainnet", fingerprint, signerAddress: "0x88e0fc76c0a8682c01afe09dea541d364a537a7e81cdd790557acd974f6651e5",
    adminCapId: "0x2462f6c7dc95b6d7dd822ce887242738ae5f59f50d79e87a951ca7f83a810ea9" },
    "67f8140b8bb43541653b6ae7000b494db46e83b2ff14dc6b1d76ebb8f82a0023"],
];

test("every role's digest is the one production's gate records were made with", () => {
  for (const [identity, digest] of production) assert.equal(releaseGateDigest(identity), digest, identity.role);
});

test("a rotated signing key, cap or deployment cannot reuse release evidence", () => {
  for (const [identity] of production) {
    const initial = releaseGateDigest(identity);
    const changes = [{ signerAddress: "0x3" }, { fingerprint: "b".repeat(64) }, ...(identity.role === "blast-keeper" ? [] : [{ adminCapId: "0x4" }])];
    for (const change of changes) assert.notEqual(releaseGateDigest({ ...identity, ...change }), initial, identity.role);
  }
  // A keeper given a cap (only possible through a cast) is refused rather than hashed into an unused shape.
  assert.throws(() => releaseGateDigest({ ...production[0]![0], adminCapId: "0x4" } as unknown as ReleaseGateIdentity), /AdminCap/);
});

test("the operator command binds each role to its own signer address and refuses any signer key", () => {
  const [keeper, rewards] = production.map(([identity]) => identity);
  assert.ok(rewards?.role === "vault-rewards");
  const environment = {
    BLAST_NETWORK: "mainnet",
    BLAST_DEPLOYMENT_FINGERPRINT: fingerprint,
    BLAST_WORKER_SIGNER_ADDRESS: keeper?.signerAddress,
    VAULT_REWARDS_SIGNER_ADDRESS: rewards.signerAddress,
    VAULT_REWARDS_ADMIN_CAP_ID: rewards.adminCapId,
  };
  assert.deepEqual(releaseGateIdentityFromEnvironment("vault-rewards", environment), rewards);
  assert.deepEqual(releaseGateIdentityFromEnvironment("blast-keeper", environment), keeper);
  assert.throws(() => releaseGateIdentityFromEnvironment("vault-buyback", environment), /BLAST_BUYBACK_SIGNER_ADDRESS/);
  assert.throws(() => releaseGateIdentityFromEnvironment("blast-keeper", { ...environment, BLAST_WORKER_SIGNER_KEY: "suiprivkey1x" }));
});

test("an oversized evidence paste is refused before redaction could shrink it into a pass", () => {
  // 1500 characters of one run redact to "[redacted]", which alone would fit the stored bound.
  assert.throws(() => parseReleaseGateCommand(["vault-buyback", "record", "buyback-key", "x".repeat(1_500)]), /1 to 1000/);
  assert.throws(() => parseReleaseGateCommand(["blast-keeper", "record", "buyback-key", "evidence"]), /unknown check/);
  assert.throws(() => parseReleaseGateCommand(["vault-buyback", "status", "extra"]), /usage/);
  assert.throws(() => parseReleaseGateCommand(["vault-buyback", "record", "buyback-key"]), /usage/);
  assert.deepEqual(parseReleaseGateCommand(["vault-rewards", "revoke", "core-role", "rolled", "back"]),
    { role: "vault-rewards", action: "revoke", check: "core-role", evidence: "rolled back" });
});
