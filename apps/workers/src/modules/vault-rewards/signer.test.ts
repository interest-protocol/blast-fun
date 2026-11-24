import assert from "node:assert/strict";
import test from "node:test";
import { buildRewardManifest } from "@interest-protocol/blast-core/rewards/allocations";
import { Transaction } from "@mysten/sui/transactions";
import { createRewardsSigner, rewardsSignerFromEnvironment } from "./signer.ts";
import { pendingMatches } from "./job.ts";
import { CLAIM_WINDOW_MS } from "#workers/modules/reward-plan/plan.ts";
import { parseRewardIntent, sameRewardKind } from "./transactions.ts";
import { base, intents, bytes, deployment, key, cap, id, manifest, frozen, round } from "../../../test/fixtures/modules/vault-rewards/rewards.ts";

const signer = createRewardsSigner(key, cap.objectId, 50_000_000n);
test("one RewardsAdmin signer signs the five exact vault operations only after durable custody", async () => {
  for (const i of intents) {
    let barrier = false;
    const raw = await bytes(i);
    const signed = await signer.sign(raw, i, deployment, async () => { barrier = true; });
    assert.ok(barrier); assert.ok(signed.signature); assert.ok(signed.digest);
    assert.equal(sameRewardKind(raw, deployment, i), true);
    const calls = Transaction.from(raw).getData().commands.flatMap(c => c.MoveCall ? [c.MoveCall] : []);
    assert.equal(calls.at(-1)?.module, "holder_rewards");
    assert.equal(calls.at(-1)?.function, i.kind);
  }
});
test("the signer refuses altered roots, role/cap inputs, amounts, extra commands, payment and expiry", async () => {
  const i = intents[0]!;
  const alterations = [
    (tx: Transaction) => tx.moveCall({ target: "0x2::test::unexpected" }),
    (tx: Transaction) => tx.setSender(id("0xdead")),
    (tx: Transaction) => tx.setGasOwner(id("0xdead")),
    (tx: Transaction) => tx.setGasBudget(50_000_001n),
    (tx: Transaction) => tx.setGasPayment([cap]),
    (tx: Transaction) => tx.setExpiration({ Epoch: "1" }),
    (tx: Transaction) => tx.setExpiration({ ValidDuring: { minEpoch: "1", maxEpoch: "2", minTimestamp: null, maxTimestamp: null, chain: deployment.chainIdentifier, nonce: 0 } }),
  ];
  for (const alter of alterations) {
    let barriers = 0;
    await assert.rejects(signer.sign(await bytes(i, alter), i, deployment, async () => { barriers++; }));
    assert.equal(barriers, 0);
  }
  const raw = await bytes(i);
  await assert.rejects(signer.sign(raw, { ...i, reserve: "11" }, deployment, async () => {}), /exact SDK/);
  if (i.kind === "schedule_round") await assert.rejects(signer.sign(raw, { ...i, admin: { ...cap, objectId: id("0xcb") } }, deployment, async () => {}), /foreign RewardsAdmin/);
  await assert.rejects(signer.sign(raw, i, deployment), /durable/);
  await assert.rejects(signer.sign(raw, i, deployment, async () => { throw new Error("custody unavailable"); }), /custody unavailable/);
});
test("claims bind the v2 leaf domain, vault, beneficiary, both assets and proof; gas settlement is capped", () => {
  const i = intents[2]!;
  assert.equal(i.kind, "claim"); if (i.kind !== "claim") return;
  assert.equal(manifest.version, 2);
  assert.throws(() => parseRewardIntent({ ...i, leaves: [{ ...i.leaves[0], memeAmount: "81" }] }), /leaf or proof/);
  assert.throws(() => parseRewardIntent({ ...i, leaves: [i.leaves[0], i.leaves[0]] }), /leaf or proof/);
  assert.throws(() => parseRewardIntent({ ...i, manifest: { ...i.manifest, version: 1 } }), /malformed/);
  assert.throws(() => parseRewardIntent({ ...intents[3], reimbursement: "11" }), /original reserve/);
  assert.throws(() => parseRewardIntent({ ...i, reserve: "15" }), /reserve/);
});

test("the rewards signer accepts a larger batch and refuses more than 1 SUI for gas", async () => {
  const { allocations, ...summary } = buildRewardManifest({
    vaultId: base.vault.objectId, number: 0n, startCheckpoint: 10n, endCheckpoint: 20n,
    allocations: Array.from({ length: 33 }, (_, index) => ({
      beneficiary: id(`0x${(index + 1).toString(16)}`), memeAmount: 0n, quoteAmount: 10n,
    })),
  });
  const intent = {
    ...base, kind: "claim" as const, round, manifest: { ...summary, leafCount: 33 },
    leaves: allocations,
  };
  const raw = await bytes(intent, (tx) => tx.setGasBudget(1_000_000_000n));
  assert.deepEqual(
    Transaction.from(raw).getData().commands.map((command) => command.MoveCall?.function),
    Array(33).fill("claim"),
  );
  assert.ok((await signer.sign(raw, intent, deployment, async () => {})).signature);
  const overBudget = await bytes(intent, (tx) => tx.setGasBudget(1_000_000_001n));
  await assert.rejects(signer.sign(overBudget, intent, deployment, async () => {
    assert.fail("oversized gas budget must not reach custody");
  }), /gas budget that is zero or above the configured cap/);
});

test("vault rewards accepts only its own Ed25519 secret name", () => {
  assert.throws(() => rewardsSignerFromEnvironment({ BLAST_WORKER_SIGNER_KEY: key.getSecretKey(), VAULT_REWARDS_SIGNER_KEY: key.getSecretKey() }, cap.objectId, 1n), /BLAST_WORKER_SIGNER_KEY must not be set/);
  assert.throws(() => rewardsSignerFromEnvironment({}, cap.objectId, 1n), /VAULT_REWARDS_SIGNER_KEY is required/);
});

test("a delayed publication must preserve every scheduled round term", () => {
  const m=intents[0]!.manifest;
  const terms={number:0n,start_checkpoint:10n,end_checkpoint:20n,root:m.root,manifest_digest:m.manifestDigest,leaf_count:2n,meme_amount:100n,quote_amount:140n,gas_reserve_amount:10n,claim_window_duration_ms:BigInt(CLAIM_WINDOW_MS),expected_treasury:frozen.treasury};
  assert.equal(pendingMatches(terms,frozen,m),true);
  assert.equal(pendingMatches({...terms,quote_amount:139n},frozen,m),false);
  assert.equal(pendingMatches({...terms,expected_treasury:id("0xff")},frozen,m),false);
  assert.equal(pendingMatches({...terms,claim_window_duration_ms:1n},frozen,m),false);
});
