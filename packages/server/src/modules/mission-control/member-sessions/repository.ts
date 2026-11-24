import type { Pool } from "pg";

import {
  autocommitRead,
  autocommitWrite,
  type ModuleTransaction,
} from "@blast/core/modules/database/transaction.ts";
import type { MemberAuthorization, MemberSessionScope } from "@blast/core/modules/mission-control/member-sessions/contracts.ts";

export interface CreateMemberSessionRecord {
  absoluteExpiresAt: string;
  createdAt: string;
  idleExpiresAt: string;
  profileId: string;
  scope: MemberSessionScope;
  sessionId: string;
  tokenHash: string;
}

interface AuthorizationRow {
  profile_id: string;
  refresh_due: boolean;
  scope: MemberSessionScope;
}

export class MemberSessionRepository {
  async create(
    database: ModuleTransaction<"session">,
    record: CreateMemberSessionRecord,
  ): Promise<void> {
    await database.write(
      "mission_control_member_sessions",
      `INSERT INTO mission_control_member_sessions (
         session_id, token_hash, profile_id, scope, created_at, last_seen_at,
         idle_expires_at, absolute_expires_at
       ) VALUES ($1, $2, $3, $4, $5, $5, $6, $7)`,
      [
        record.sessionId,
        record.tokenHash,
        record.profileId,
        record.scope,
        record.createdAt,
        record.idleExpiresAt,
        record.absoluteExpiresAt,
      ],
    );
  }

  /**
   * Authorizes with one autocommit read, one round trip. Revocation and both
   * expiries are checked on every call. When the session's activity is at
   * least one refresh interval old, one conditional autocommit UPDATE extends
   * it; parallel requests that lose the race wait for the winner's row lock,
   * re-check the WHERE against its committed row, and skip. GREATEST keeps
   * activity monotonic whatever order the requests' clocks commit in, so the
   * session trigger never rejects a refresh.
   *
   * The two need no shared transaction: at READ COMMITTED they would not
   * share a snapshot anyway, and the UPDATE re-checks revocation, expiry and
   * staleness itself. A failed refresh still fails the authorization.
   */
  async authorizeAndRefresh(
    pool: Pool,
    input: Readonly<{
      idleExpiresAt: string;
      now: string;
      refreshDueBefore: string;
      tokenHash: string;
    }>,
  ): Promise<MemberAuthorization | null> {
    const result = await autocommitRead<AuthorizationRow>(
      pool,
      "session",
      `SELECT profile_id, scope, last_seen_at <= $3::timestamptz AS refresh_due
       FROM mission_control_member_sessions
       WHERE token_hash = $1
         AND revoked_at IS NULL
         AND idle_expires_at > $2
         AND absolute_expires_at > $2`,
      [input.tokenHash, input.now, input.refreshDueBefore],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.refresh_due) {
      await autocommitWrite(
        pool,
        "session",
        "mission_control_member_sessions",
        `UPDATE mission_control_member_sessions
         SET last_seen_at = GREATEST(last_seen_at, $2::timestamptz),
             idle_expires_at = GREATEST(
               idle_expires_at,
               LEAST(absolute_expires_at, $3::timestamptz)
             )
         WHERE token_hash = $1
           AND revoked_at IS NULL
           AND idle_expires_at > $2
           AND absolute_expires_at > $2
           AND last_seen_at <= $4::timestamptz`,
        [input.tokenHash, input.now, input.idleExpiresAt, input.refreshDueBefore],
      );
    }
    return { profileId: row.profile_id, scope: row.scope };
  }

  async revoke(
    database: ModuleTransaction<"session">,
    input: Readonly<{ now: string; tokenHash: string }>,
  ): Promise<boolean> {
    const result = await database.write(
      "mission_control_member_sessions",
      `UPDATE mission_control_member_sessions
       SET revoked_at = $2
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [input.tokenHash, input.now],
    );
    return result.rowCount === 1;
  }
}
