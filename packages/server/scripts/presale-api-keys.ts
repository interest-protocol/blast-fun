// The presale agent API key operator command: issues a key (printed once,
// stored only as its SHA-256), revokes one, or lists them without secrets.
// The key records `operator:<BLAST_OPERATOR_ID>` as its issuer or revoker.
// Authenticated like the Mission Control operator procedure
// (MISSION_CONTROL_OPERATOR_ALLOWED_ID and MISSION_CONTROL_OPERATOR_TOKEN_SHA256;
// BLAST_OPERATOR_ID and BLAST_OPERATOR_TOKEN presented), against DATABASE_URL.
// Agents send the key in the `X-Blast-Api-Key` header.
//
//   npm run presale:api-keys -- create <label>
//   npm run presale:api-keys -- revoke <id>
//   npm run presale:api-keys -- list

import { createPool } from "@blast/core/modules/database/pool.ts";
import { OperatorAuthenticator } from "@blast/server/modules/mission-control/operator/auth.ts";
import { OperatorError } from "@blast/server/modules/mission-control/operator/errors.ts";
import { parseApiKeyCommand, runApiKeyCommand } from "@blast/server/modules/presale/api-keys/command.ts";
import { issuePresaleApiKey, listPresaleApiKeys, revokePresaleApiKey } from "@blast/server/modules/presale/api-keys/repository.ts";

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
  const command = parseApiKeyCommand(process.argv.slice(2));
  pool = createPool();
  const primary = pool;
  const result = await runApiKeyCommand(command, operator, {
    issue: (label, issuedBy) => issuePresaleApiKey(primary, label, issuedBy),
    revoke: (id, revokedBy) => revokePresaleApiKey(primary, id, revokedBy),
    list: () => listPresaleApiKeys(primary),
  });
  console.log(JSON.stringify(result));
} catch (error) {
  const safe = error instanceof OperatorError ? error : new OperatorError("OPERATOR_UNAVAILABLE");
  console.error(JSON.stringify({ error: { code: safe.code, message: safe.message } }));
  process.exitCode = 1;
} finally {
  await pool?.end();
}
