import type { Pool } from "pg";
import type { SocialWorker } from "../../../../../src/modules/social/worker/runtime.ts";
import { FIXTURE_NETWORK } from "../../../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";

export async function seedSocialCheckpoint(admin: Pool, checkpoint: string | number, timestampMs: string | number): Promise<void> {
  await admin.query(`INSERT INTO checkpoint_journal
    (checkpoint, network, digest, previous_digest, epoch, timestamp_ms, total_transactions, format_version, payload, payload_hash)
    VALUES ($1,$2,$3,NULL,0,$4,0,1,$5,$6) ON CONFLICT(checkpoint) DO UPDATE SET timestamp_ms=EXCLUDED.timestamp_ms`,
  [checkpoint, FIXTURE_NETWORK, `social-cut-${checkpoint}`, timestampMs, Buffer.alloc(0), Buffer.alloc(32)]);
}

/** Explicit native headers and intake coverage for synthetic social SQL scenarios. */
export async function syncSocialCoverage(admin: Pool): Promise<void> {
  const { rows } = await admin.query<{ checkpoint: string; timestamp_ms: string }>(
    "SELECT DISTINCT checkpoint_hi_inclusive::text AS checkpoint, timestamp_ms_hi_inclusive::text AS timestamp_ms FROM watermarks WHERE pipeline IN ('market','presale')",
  );
  for (const row of rows) {
    await seedSocialCheckpoint(admin, row.checkpoint, row.timestamp_ms);
  }
  await admin.query(`UPDATE watermarks SET checkpoint_hi_inclusive=(SELECT max(checkpoint_hi_inclusive) FROM watermarks WHERE pipeline IN ('market','presale')),
    timestamp_ms_hi_inclusive=(SELECT max(timestamp_ms_hi_inclusive) FROM watermarks WHERE pipeline IN ('market','presale')) WHERE pipeline='intake'`);
}


export function withSocialCoverage(worker: SocialWorker, admin: Pool): SocialWorker {
  return { ...worker, runPass: async () => { await syncSocialCoverage(admin); return worker.runPass(); } };
}
