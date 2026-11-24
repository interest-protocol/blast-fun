import { z } from "zod";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { autocommitRead, autocommitWrite, type ModuleTransaction } from "@blast/core/modules/database/transaction.ts";
import {
  SOCIAL_WALLET_HINT_COOKIE,
  SOCIAL_WALLET_SESSION_COOKIE,
  SOCIAL_WALLET_SESSION_IDLE_MS,
  SOCIAL_WALLET_SESSION_TTL_MS,
} from "../contracts/wallet-sign-in.ts";

type Social = ModuleTransaction<"social">;

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** A live session records its use at most this often (one write per page load at most). */
const TOUCH_INTERVAL_MS = 10 * 60_000;
/** Expired rows a new session sweeps, oldest first. */
const SWEEP_BATCH = 100;

/** A fresh session token: 256 random bits, base64url (43 characters). */
export function createWalletSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The token as stored: its SHA-256, lowercase hex. The token itself is never stored or logged. */
export function walletSessionTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** The session token from a request's cookies; null when absent, malformed or sent twice. */
export function readWalletSessionToken(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  let token: string | null = null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1 || part.slice(0, separator).trim() !== SOCIAL_WALLET_SESSION_COOKIE) continue;
    if (token !== null) return null;
    token = part.slice(separator + 1).trim();
  }
  return z.string().regex(TOKEN).safeParse(token).success ? token : null;
}

/**
 * The two cookies of a new session: the HttpOnly token and the readable hint.
 * Both are `__Host-` (Secure, Path=/, no Domain) and `SameSite=Strict`: only
 * same-site requests carry them, and the routes that read them are fetches.
 */
export function walletSessionCookies(token: string, maxAgeSeconds: number): readonly string[] {
  if (!z.tuple([z.string().regex(TOKEN), z.number().int().min(1)]).safeParse([token, maxAgeSeconds]).success) {
    throw new TypeError("Invalid wallet session cookie.");
  }
  return [
    `${SOCIAL_WALLET_SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`,
    `${SOCIAL_WALLET_HINT_COOKIE}=1; Path=/; Max-Age=${maxAgeSeconds}; Secure; SameSite=Strict`,
  ];
}

/** Clears both cookies. */
export function clearedWalletSessionCookies(): readonly string[] {
  return [
    `${SOCIAL_WALLET_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
    `${SOCIAL_WALLET_HINT_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Strict`,
  ];
}

export type WalletSession = Readonly<{ sessionId: string; address: string; expiresAt: Date }>;

/**
 * Stores a new session for a consumed challenge and sweeps a batch of
 * expired rows. A challenge makes at most one session (`challenge_id`
 * UNIQUE). Answers the session; the caller sets the cookie.
 */
export async function createWalletSession(
  social: Social,
  input: Readonly<{ token: string; address: string; challengeId: string; now: Date; sessionId?: string }>,
): Promise<WalletSession> {
  const sessionId = input.sessionId ?? randomUUID();
  const expiresAt = new Date(input.now.getTime() + SOCIAL_WALLET_SESSION_TTL_MS);
  await social.write(
    "social_wallet_sessions",
    `DELETE FROM social_wallet_sessions
     WHERE session_id IN (
       SELECT session_id FROM social_wallet_sessions WHERE expires_at <= $1 ORDER BY expires_at LIMIT ${SWEEP_BATCH}
     )`,
    [input.now],
  );
  await social.write(
    "social_wallet_sessions",
    `INSERT INTO social_wallet_sessions (
       session_id, token_hash, wallet_address, challenge_id, created_at, expires_at, last_used_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $5)`,
    [sessionId, walletSessionTokenHash(input.token), input.address, input.challengeId, input.now, expiresAt],
  );
  return { sessionId, address: input.address, expiresAt };
}

/**
 * The live session a token names, or null: unknown, revoked, past its 30
 * days, or idle for 7. A live session older than ten minutes since its last
 * use records this use (which keeps it from going idle).
 */
export async function liveWalletSession(pool: Pool, token: string, now: Date): Promise<WalletSession | null> {
  const { rows } = await autocommitRead<{ session_id: string; wallet_address: string; expires_at: Date; last_used_at: Date }>(
    pool, "social",
    `SELECT session_id, wallet_address, expires_at, last_used_at
     FROM social_wallet_sessions
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2 AND last_used_at > $3`,
    [walletSessionTokenHash(token), now, new Date(now.getTime() - SOCIAL_WALLET_SESSION_IDLE_MS)],
    { label: "social.wallet_session", prepare: true },
  );
  const row = rows[0];
  if (!row) return null;
  if (now.getTime() - row.last_used_at.getTime() >= TOUCH_INTERVAL_MS) {
    // Revalidate in the write itself: a concurrent revocation or expiry must not be revived.
    const touched = await autocommitWrite(
      pool, "social", "social_wallet_sessions",
      `UPDATE social_wallet_sessions SET last_used_at = GREATEST(last_used_at, $2)
       WHERE session_id = $1 AND revoked_at IS NULL AND expires_at > $2 AND last_used_at > $3
       RETURNING session_id`,
      [row.session_id, now, new Date(now.getTime() - SOCIAL_WALLET_SESSION_IDLE_MS)],
    );
    if (touched.rowCount !== 1) return null;
  }
  return { sessionId: row.session_id, address: row.wallet_address, expiresAt: row.expires_at };
}

/** Revokes the session a token names; false when there was no live one. */
export async function revokeWalletSession(social: Social, token: string, now: Date): Promise<boolean> {
  const result = await social.write(
    "social_wallet_sessions",
    "UPDATE social_wallet_sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL RETURNING session_id",
    [walletSessionTokenHash(token), now],
  );
  return result.rowCount === 1;
}
