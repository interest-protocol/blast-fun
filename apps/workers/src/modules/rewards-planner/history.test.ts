import assert from "node:assert/strict";
import test from "node:test";
import { vaultEventBcs } from "@interest-protocol/blast-vault-sdk/events";
import type { TransactionContext } from "@blast/core/modules/database/transaction.ts";
import { historicalFunds } from "./history.ts";
import { PAGE_SIZE } from "#workers/modules/reward-plan/plan.ts";
import { base, deployment, fingerprint, id, key, memeType, quoteType, vault } from "../../../test/fixtures/modules/vault-rewards/rewards.ts";

const cut = { checkpoint: "20", digest: "C".repeat(32), timestampMs: "86401000" };
const collectionEvent = {
  eventType: `${deployment.packages.vault.originalPackageId}::blast_vault_events::FeesCollected<${memeType},${quoteType}>`,
  bcs: Buffer.from(vaultEventBcs.FeesCollected.serialize({ vault_id: vault.objectId, gross_meme_amount: 1n, gross_quote_amount: 1n, protocol_meme_amount: 0n, protocol_quote_amount: 0n, route_meme_amounts: [1n], route_quote_amounts: [1n] }).toBytes()).toString("base64"),
};

function publication(index: number) {
  const roundId = id(`0x${(index + 1).toString(16)}`);
  const event = {
    eventType: `${deployment.packages.vault.originalPackageId}::blast_vault_events::RoundPublished<${memeType},${quoteType}>`,
    bcs: Buffer.from(vaultEventBcs.RoundPublished.serialize({ vault_id: vault.objectId, round_id: roundId, number: BigInt(index), start_checkpoint: 1n, end_checkpoint: 20n, claim_deadline_at_ms: 999999999n, root: base.manifest.root, manifest_digest: base.manifest.manifestDigest, leaf_count: 1n, meme_amount: 1n, quote_amount: 1n, meme_unallocated: 0n, quote_unallocated: 0n, treasury: base.treasury, gas_reserve_amount: 0n }).toBytes()).toString("base64"),
  };
  return { roundId, event };
}

test("native funds replay pages past 10,000 collections and 512 rounds in chronological order", async () => {
  const collectionCount = 10_001, publicationCount = 513;
  const total = collectionCount + publicationCount;
  let pageReads = 0, maxPage = 0;
  const published = Array.from({ length: publicationCount }, (_, i) => publication(i));
  const replayRow = (position: number) => {
    const isPublication = position < publicationCount * 2 && position % 2 === 1;
    const index = Math.floor(position / 2), cursor = { checkpoint: "20", tx_slot: String(position), event_slot: "0" };
    if (isPublication) return { ...cursor, kind: "published", row: { round_id: published[index]!.roundId, published_checkpoint: "20", published_tx_slot: String(position), published_event_slot: "0", published_tx_digest: `round:${index}` } };
    return { ...cursor, kind: "collection", row: { ...cursor, tx_digest: "collection", fee_split: { routes: [{ destination: { kind: "holder_rewards" } }] }, route_meme_amounts: ["1"], route_quote_amounts: ["1"] } };
  };
  const read = async (sql: string, values: unknown[]) => {
    if (sql.includes("require_cut") || sql.includes("AS prefix")) return { rows: [] };
    if (sql.includes("FROM chain_read_v1.transaction_evidence")) {
      const digest = String(values[0]);
      const event = digest === "collection" ? collectionEvent : published[Number(digest.split(":")[1])]!.event;
      return { rows: [{ events: [event], sender: key.toSuiAddress(), checkpoint: "20" }] };
    }
    assert.ok(sql.includes("ORDER BY checkpoint,tx_slot,event_slot LIMIT"));
    assert.equal(values[5], PAGE_SIZE);
    const start = Number(values[3]) + 1;
    const length = Math.min(PAGE_SIZE, total - start);
    const rows = Array.from({ length }, (_, offset) => replayRow(start + offset));
    pageReads++; maxPage = Math.max(maxPage, rows.length);
    return { rows };
  };
  const result = await historicalFunds({ read } as unknown as TransactionContext, deployment, fingerprint, vault.objectId, cut);
  assert.deepEqual(result, { meme: 9488n, quote: 9488n, evidence: { checkpoint: "20", digest: cut.digest, collections: collectionCount, rounds: publicationCount } });
  assert.equal(maxPage, PAGE_SIZE);
  assert.equal(pageReads, Math.ceil(total / PAGE_SIZE));
});
