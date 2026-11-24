import type { Pool } from "pg";

import {
  autocommitWrite,
  type ModuleTransaction,
  type ReadableDatabase,
} from "@blast/core/modules/database/transaction.ts";
import type {
  WalletChallengeAction,
  WalletChallengeContext,
} from "@blast/server/modules/mission-control/wallet-challenges/contracts.ts";

export interface StoredWalletChallenge {
  challengeId: string;
  action: WalletChallengeAction;
  address: string;
  origin: string;
  context: WalletChallengeContext;
  nonceHash: string;
  messageHash: string;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

interface WalletChallengeRow {
  challenge_id: string;
  action: WalletChallengeAction;
  wallet_address: string;
  origin: string;
  context_kind: WalletChallengeContext["kind"];
  context_id: string;
  nonce_hash: string;
  message_hash: string;
  issued_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}

function fromRow(row: WalletChallengeRow): StoredWalletChallenge {
  return {
    challengeId: row.challenge_id,
    action: row.action,
    address: row.wallet_address,
    origin: row.origin,
    context: { kind: row.context_kind, id: row.context_id } as WalletChallengeContext,
    nonceHash: row.nonce_hash,
    messageHash: row.message_hash,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

export class WalletChallengeRepository {
  async findVerifiedOnboardingProof(
    database: ReadableDatabase,
    input: {
      address: string;
      attemptId: string;
      challengeId: string;
      origin: string;
    },
  ): Promise<boolean> {
    const result = await database.read<{ verified: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM mission_control_wallet_challenges
         WHERE challenge_id = $1
           AND action = 'onboarding'
           AND wallet_address = $2
           AND origin = $3
           AND context_kind = 'attempt'
           AND context_id = $4
           AND consumed_at IS NOT NULL
       ) AS verified`,
      [input.challengeId, input.address, input.origin, input.attemptId],
    );
    return result.rows[0]?.verified === true;
  }

  /** One INSERT that stands alone: autocommit, one round trip. */
  async create(
    pool: Pool,
    challenge: StoredWalletChallenge,
  ): Promise<void> {
    await autocommitWrite(
      pool,
      "wallet-challenge",
      "mission_control_wallet_challenges",
      `INSERT INTO mission_control_wallet_challenges (
         challenge_id, action, wallet_address, origin, context_kind, context_id,
         nonce_hash, message_hash, issued_at, expires_at, consumed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        challenge.challengeId,
        challenge.action,
        challenge.address,
        challenge.origin,
        challenge.context.kind,
        challenge.context.id,
        challenge.nonceHash,
        challenge.messageHash,
        challenge.issuedAt,
        challenge.expiresAt,
        challenge.consumedAt,
      ],
    );
  }

  async lockById(
    database: ModuleTransaction<"wallet-challenge">,
    challengeId: string,
  ): Promise<StoredWalletChallenge | null> {
    const result = await database.read<WalletChallengeRow>(
      `SELECT challenge_id, action, wallet_address, origin, context_kind,
              context_id, nonce_hash, message_hash, issued_at, expires_at,
              consumed_at
       FROM mission_control_wallet_challenges
       WHERE challenge_id = $1
       FOR UPDATE`,
      [challengeId],
    );
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async consume(
    database: ModuleTransaction<"wallet-challenge">,
    challengeId: string,
    consumedAt: Date,
  ): Promise<boolean> {
    const result = await database.write(
      "mission_control_wallet_challenges",
      `UPDATE mission_control_wallet_challenges
       SET consumed_at = $2
       WHERE challenge_id = $1 AND consumed_at IS NULL
       RETURNING challenge_id`,
      [challengeId, consumedAt],
    );
    return result.rowCount === 1;
  }
}
