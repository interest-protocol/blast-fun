// The launchpad's moderation operator command: hides or restores one post
// record, or prints a post's audit. Authenticated like the Mission Control
// operator procedure (MISSION_CONTROL_OPERATOR_ALLOWED_ID and
// MISSION_CONTROL_OPERATOR_TOKEN_SHA256; BLAST_OPERATOR_ID and
// BLAST_OPERATOR_TOKEN presented), against DATABASE_URL. See
// docs/launchpad/social.md.
//
//   npm run launchpad:moderate -- hide <recordId> <reason>
//   npm run launchpad:moderate -- restore <recordId> <reason>
//   npm run launchpad:moderate -- audit <thesisId>

import { createPool } from "@blast/core/modules/database/pool.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { OperatorAuthenticator } from "@blast/server/modules/mission-control/operator/auth.ts";
import { OperatorError } from "@blast/server/modules/mission-control/operator/errors.ts";
import { setThesisVisibility } from "../src/modules/launchpad-social/moderation.ts";
import { parseModerationCommand, runModerationCommand } from "../src/modules/launchpad-social/moderation-command.ts";
import { postAudit } from "@blast/server/modules/launchpad-social/reads.ts";

// Stdout carries exactly one JSON result line; the database's metric lines
// (`recordMetric`, console.info) go to stderr with any error.
console.info = (...lines: unknown[]) => console.error(...lines);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new OperatorError("OPERATOR_AUTH_FAILED");
  return value;
}

let pool: ReturnType<typeof createPool> | null = null;

try {
  const operator = new OperatorAuthenticator({
    operatorId: required("MISSION_CONTROL_OPERATOR_ALLOWED_ID"),
    tokenHash: required("MISSION_CONTROL_OPERATOR_TOKEN_SHA256"),
  }).authenticate(required("BLAST_OPERATOR_ID"), required("BLAST_OPERATOR_TOKEN"));
  const command = parseModerationCommand(process.argv.slice(2));
  pool = createPool();
  const primary = pool;
  const result = await runModerationCommand(command, operator, {
    setVisibility: (change) => setThesisVisibility(primary, change),
    audit: (thesisId) => postAudit(autocommitReader(primary, "launchpad-social", { label: "launchpad.moderation" }), thesisId),
  });
  console.log(JSON.stringify(result));
} catch (error) {
  const safe = error instanceof OperatorError ? error : new OperatorError("OPERATOR_UNAVAILABLE");
  console.error(JSON.stringify({ error: { code: safe.code, message: safe.message } }));
  process.exitCode = 1;
} finally {
  await pool?.end();
}
