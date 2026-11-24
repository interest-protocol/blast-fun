// Gives a fresh disposable database blast-infra's roles and `chain_read_v1`
// views (role-fixtures.ts `CHAIN_FIXTURE`), as production has them before the
// web migrations run: 0055 `social_feed_entries` reads chain_read_v1.
import pg from "pg";

import { CHAIN_FIXTURE } from "../fixtures/modules/database/role-fixtures.ts";

const client = new pg.Client({ connectionString: process.env.MISSION_CONTROL_TEST_DATABASE_URL });
await client.connect();
try {
  await client.query(CHAIN_FIXTURE);
} finally {
  await client.end();
}
