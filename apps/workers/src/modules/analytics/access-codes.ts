import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";

// Operator-only: the redeem role has no insert, update or table-read permission.
export async function mintAccessCode(admin: Pool): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  await admin.query(
    "INSERT INTO blast_analytics.access_codes(code_hash,expires_at) VALUES($1,statement_timestamp()+INTERVAL '1 hour')",
    [createHash("sha256").update(code).digest("hex")],
  );
  return code;
}

export async function redeemAccessCode(access: Pool, code: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) {
    return null;
  }
  const hash = createHash("sha256").update(code).digest("hex");
  const result = await access.query<{ accepted: boolean }>(
    "SELECT blast_analytics.redeem_access_code($1) AS accepted", [hash],
  );
  return result.rows[0]?.accepted ? hash : null;
}
