import { randomBytes } from "node:crypto";

import type { ModuleTransaction, ReadableDatabase } from "@blast/core/modules/database/transaction.ts";

/** Length of `creator_authority::CreatorRecipient::Account`'s commitment. */
export const ACCOUNT_COMMITMENT_BYTES = 32;

const READ_SQL = "SELECT commitment FROM social_creator_commitments WHERE account_id = $1::uuid";
const MINT_SQL = `INSERT INTO social_creator_commitments (account_id, commitment) VALUES ($1::uuid, $2)
  ON CONFLICT (account_id) DO NOTHING`;

type Row = Readonly<{ commitment: Buffer }>;

/** The account's commitment, or null while it has none (it was never read through the route). */
export async function readCreatorCommitment(database: ReadableDatabase, accountId: string): Promise<Uint8Array | null> {
  const row = (await database.read<Row>(READ_SQL, [accountId])).rows[0];
  return row ? new Uint8Array(row.commitment) : null;
}

/**
 * The account's commitment, minted on first use: 32 random bytes, so nothing about the account
 * can be recovered from it or guessed for another one (contracts ADR 0080). A concurrent first
 * read keeps whichever row landed first; the commitment never changes afterwards.
 */
export async function creatorCommitmentOf(social: ModuleTransaction<"social">, accountId: string): Promise<Uint8Array> {
  await social.write("social_creator_commitments", MINT_SQL, [accountId, randomBytes(ACCOUNT_COMMITMENT_BYTES)]);
  const row = (await social.read<Row>(READ_SQL, [accountId])).rows[0];
  if (!row) throw new Error("the creator commitment was not stored");
  return new Uint8Array(row.commitment);
}
