import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

/** Real LOGIN membership on disposable loopback PG; never SET ROLE or writer credentials. */
export async function partnerVerifierFixture(
  database: string,
  t: { after(cleanup: () => Promise<void>): void },
  endpoint = database,
): Promise<string> {
  return runtimeRoleFixture(database, t, "blast_partner_verifier", endpoint);
}

/** A real runtime login, so an administrator's RESET ROLE cannot hide missing grants. */
export async function runtimeRoleFixture(
  database: string,
  t: { after(cleanup: () => Promise<void>): void },
  membership: "blast_partner_verifier" | "blast_web" | "blast_replica",
  endpoint = database,
): Promise<string> {
  const url = new URL(endpoint);
  const authority = new URL(database);
  assert.equal(authority.hostname, "127.0.0.1");
  assert.equal(authority.pathname, url.pathname);
  assert.equal(url.hostname, "127.0.0.1", "Verifier fixtures require the owned loopback primary.");
  const role = "blast_runtime_test_" + randomUUID().replaceAll("-", "");
  const password = randomUUID().replaceAll("-", "");
  const admin = new Pool({ connectionString: database, max: 1 });
  try {
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    t.after(async () => {
      const cleanupUrl = new URL(database);
      cleanupUrl.pathname = "/postgres";
      const cleanup = new Pool({ connectionString: String(cleanupUrl), max: 1 });
      try {
        await cleanup.query(`DROP ROLE ${role}`);
      } finally {
        await cleanup.end();
      }
    });
    await admin.query(`GRANT ${membership} TO ${role}`);
  } finally {
    await admin.end();
  }
  url.username = role;
  url.password = password;
  url.searchParams.delete("options");
  return String(url);
}
