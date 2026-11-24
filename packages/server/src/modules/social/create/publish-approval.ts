import { createHash, randomBytes } from "node:crypto";
import { ObjectError, type ClientWithCoreApi } from "@mysten/sui/client";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { fromBase64, normalizeStructTag, parseStructTag } from "@mysten/sui/utils";
import { readPresaleCoinPublication } from "@interest-protocol/blast-sdk/presale";
import type { ModuleTransaction, ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { DraftRow } from "./store.ts";

export type CoinPublication = Readonly<{ digest: string; kindProof: string; timestampMs: number | null }>;
export type PublicationCoin = Readonly<{ coinType: string; sealedTreasuryCap: { objectId: string; version: string; digest: string } }>;

export async function prepareWalletCoinPublication(client: ClientWithCoreApi, transaction: Transaction, signal: AbortSignal) {
  const [{ chainIdentifier }, { systemState }] = await Promise.all([
    client.core.getChainIdentifier({ signal }),
    client.core.getCurrentSystemState({ signal }),
  ]);
  const epoch = BigInt(systemState.epoch);
  // Two versions with the same coin metadata and gas objects still need distinct digests.
  transaction.setExpiration({ ValidDuring: {
    minEpoch: String(epoch), maxEpoch: String(epoch + 1n),
    minTimestamp: null, maxTimestamp: null,
    chain: chainIdentifier, nonce: randomBytes(4).readUInt32LE(),
  } });
  transaction.setGasPrice(systemState.referenceGasPrice);
  const bytes = await transaction.build({ client });
  return { transaction: await Transaction.from(bytes).toJSON(), digest: TransactionDataBuilder.getDigestFromBytes(bytes) };
}

export async function readCoinPublication(
  client: ClientWithCoreApi, coin: PublicationCoin, creator: string, corePackageId: string, signal: AbortSignal,
): Promise<CoinPublication | null> {
  const object = await client.core.getObject({
    objectId: parseStructTag(coin.coinType).address, include: { previousTransaction: true }, signal,
  }).catch((error: unknown) => {
    if (error instanceof ObjectError && error.reason === "notFound") return null;
    throw error;
  });
  const digest = object?.object.previousTransaction;
  if (!digest) return null;

  const { Transaction: receipt } = await client.core.getTransaction({
    digest, include: { effects: true, objectTypes: true, bcs: true }, signal,
  });
  if (!receipt?.status.success || receipt.sender !== creator) return null;
  let publication: ReturnType<typeof readPresaleCoinPublication>;
  try {
    publication = readPresaleCoinPublication(receipt, { core: { originalPackageId: corePackageId } });
  } catch {
    return null;
  }
  const cap = publication.sealedTreasuryCap;
  const expected = coin.sealedTreasuryCap;
  if (normalizeStructTag(publication.saleTokenType) !== coin.coinType || cap.owner !== creator
    || cap.objectId !== expected.objectId || cap.version !== expected.version || cap.digest !== expected.digest) return null;
  return { digest, kindProof: await coinKindProof(receipt.bcs), timestampMs: receipt.timestampMs };
}

export async function coinKindProof(transaction: string | Uint8Array): Promise<string> {
  const kind = await Transaction.from(transaction).build({ onlyTransactionKind: true });
  return `kind:${createHash("sha256").update(kind).digest("hex")}`;
}

export function sponsoredCoinDigest(bytes: string): string {
  return TransactionDataBuilder.getDigestFromBytes(fromBase64(bytes));
}

export async function recordPublishApproval(
  db: ModuleTransaction<"social">, row: DraftRow, accountId: string, creator: string, digest: string,
): Promise<boolean> {
  const approval = await db.write("social_presale_publish_approvals", `
    INSERT INTO social_presale_publish_approvals (draft_id, draft_version, creator, digest)
    SELECT draft_id, version, $4, $5 FROM social_presale_drafts
    WHERE draft_id = $1 AND account_id = $2 AND version = $3 AND published_presale_id IS NULL
    FOR SHARE
    ON CONFLICT DO NOTHING
    RETURNING digest`,
  [row.draftId, accountId, row.version, creator, digest]);
  return approval.rows.length > 0 || (await readPublishApproval(db, row, creator, digest, accountId)).matches;
}

export async function readPublishApproval(
  db: ReadableDatabase, row: DraftRow, creator: string, digest: string, accountId: string,
): Promise<Readonly<{ matches: boolean; legacyUntilMs: number | null }>> {
  const { rows: [approval] } = await db.read<{ matches: boolean | null; legacy_until_ms: string }>(`
    SELECT a.draft_id = $1 AND a.draft_version = $2 AND a.creator = $3
      AND d.version = a.draft_version AND d.account_id = $5 AND d.published_presale_id IS NULL AS matches,
      (extract(epoch FROM coalesce(r.legacy_until, statement_timestamp())) * 1000)::bigint::text AS legacy_until_ms
    FROM social_presale_raise_floor_rollout r
    LEFT JOIN social_presale_publish_approvals a ON a.digest = $4
    LEFT JOIN social_presale_drafts d ON d.draft_id = a.draft_id`,
  [row.draftId, row.version, creator, digest, accountId]);
  return { matches: approval?.matches === true, legacyUntilMs: approval?.matches === null ? Number(approval.legacy_until_ms) : null };
}

export async function legacySponsorshipTime(
  db: ReadableDatabase, digest: string, accountKey: string, creator: string,
): Promise<number | null> {
  const { rows } = await db.read<{ created_at_ms: string }>(`
    SELECT (extract(epoch FROM created_at) * 1000)::bigint::text AS created_at_ms
    FROM presale_sponsor_reservations
    WHERE digest = $1 AND privy_did = $2 AND sender = $3 AND intent = 'create'
    ORDER BY created_at LIMIT 1`, [digest, accountKey, creator]);
  return rows[0] ? Number(rows[0].created_at_ms) : null;
}
