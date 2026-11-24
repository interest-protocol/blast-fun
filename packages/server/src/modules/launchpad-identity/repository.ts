import type { Pool } from "pg";

import {
  autocommitRead,
  autocommitWrite,
  type TransactionContext,
} from "@blast/core/modules/database/transaction.ts";

export const LAUNCHPAD_IDENTITY_MODULE = "launchpad-identity";
const TABLE = "mission_control_launchpad_wallet_challenges";

export interface StoredLaunchpadChallenge {
  challengeId: string;
  action: string;
  address: string;
  origin: string;
  nonceHash: string;
  messageHash: string;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

interface ChallengeRow {
  challenge_id: string;
  action: string;
  wallet_address: string;
  origin: string;
  nonce_hash: string;
  message_hash: string;
  issued_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}

/** Launchpad Wallet Proof challenges; never Mission Control's. */
export class LaunchpadChallengeRepository {
  /** One INSERT that stands alone: autocommit, one round trip. */
  async create(pool: Pool, challenge: StoredLaunchpadChallenge): Promise<void> {
    await autocommitWrite(
      pool,
      LAUNCHPAD_IDENTITY_MODULE,
      TABLE,
      `INSERT INTO mission_control_launchpad_wallet_challenges (
         challenge_id, action, wallet_address, origin, nonce_hash, message_hash,
         issued_at, expires_at, consumed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        challenge.challengeId,
        challenge.action,
        challenge.address,
        challenge.origin,
        challenge.nonceHash,
        challenge.messageHash,
        challenge.issuedAt,
        challenge.expiresAt,
        challenge.consumedAt,
      ],
    );
  }

  /** An unlocked read for the pre-check; consumption re-checks under the row lock. */
  async find(pool: Pool, challengeId: string): Promise<StoredLaunchpadChallenge | null> {
    const result = await autocommitRead<ChallengeRow>(
      pool,
      LAUNCHPAD_IDENTITY_MODULE,
      `SELECT challenge_id, action, wallet_address, origin, nonce_hash,
              message_hash, issued_at, expires_at, consumed_at
       FROM mission_control_launchpad_wallet_challenges
       WHERE challenge_id = $1`,
      [challengeId],
    );
    const row = result.rows[0];
    return row
      ? {
        challengeId: row.challenge_id,
        action: row.action,
        address: row.wallet_address,
        origin: row.origin,
        nonceHash: row.nonce_hash,
        messageHash: row.message_hash,
        issuedAt: row.issued_at,
        expiresAt: row.expires_at,
        consumedAt: row.consumed_at,
      }
      : null;
  }

  /**
   * Spends the challenge if, at `now`, it is still unspent, unexpired and
   * bound exactly as checked. One conditional UPDATE: of concurrent uses only
   * the first to lock the row matches, and a rollback of the caller's
   * transaction un-spends it.
   */
  async consume(
    transaction: TransactionContext,
    binding: Readonly<{
      action: string;
      address: string;
      challengeId: string;
      messageHash: string;
      origin: string;
    }>,
    now: Date,
  ): Promise<boolean> {
    const result = await transaction.forModule(LAUNCHPAD_IDENTITY_MODULE).write(
      TABLE,
      `UPDATE mission_control_launchpad_wallet_challenges
       SET consumed_at = $6
       WHERE challenge_id = $1
         AND action = $2
         AND wallet_address = $3
         AND origin = $4
         AND message_hash = $5
         AND consumed_at IS NULL
         AND issued_at <= $6
         AND expires_at > $6
       RETURNING challenge_id`,
      [binding.challengeId, binding.action, binding.address, binding.origin, binding.messageHash, now],
    );
    return result.rowCount === 1;
  }
}
