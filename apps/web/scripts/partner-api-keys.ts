// Operator-authenticated administration on the primary, using the same
// credentials as presale:api-keys. See docs/security/partner-read-api.md.
import { createPool } from "@blast/core/modules/database/pool.ts";
import { OperatorAuthenticator } from "@blast/server/modules/mission-control/operator/auth.ts";
import { OperatorError } from "@blast/server/modules/mission-control/operator/errors.ts";
import { parsePartnerKeyCommand, runPartnerKeyCommand } from "@blast/server/modules/partner-api-keys/command.ts";
import { createPartner, setPartnerOrigins, issuePartnerApiKey, revokePartnerApiKey, listPartnerApiKeys, setPartnerKeyPolicy, deleteRevokedPartnerKey, deleteInactivePartnerGroup } from "@blast/server/modules/partner-api-keys/repository.ts";

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
  const command = parsePartnerKeyCommand(process.argv.slice(2));
  pool = createPool();
  const primary = pool;
  const result = await runPartnerKeyCommand(command, operator, {
    createPartner: (partner, by) => createPartner(primary, partner, by),
    setOrigins: (partner, by) => setPartnerOrigins(primary, partner, by),
    issue: (id, label, by) => issuePartnerApiKey(primary, id, label, by),
    deleteKey: (id, by) => deleteRevokedPartnerKey(primary, id, by),
    deletePartner: (id, by) => deleteInactivePartnerGroup(primary, id, by),
    revoke: (id, by) => revokePartnerApiKey(primary, id, by),
    setPolicy: (id, policy, by) => setPartnerKeyPolicy(primary, id, policy, by),
    list: () => listPartnerApiKeys(primary),
  });
  console.log(JSON.stringify(result));
} catch (error) {
  const safe = error instanceof OperatorError ? error : new OperatorError("OPERATOR_UNAVAILABLE");
  console.error(JSON.stringify({ error: { code: safe.code, message: safe.message } }));
  process.exitCode = 1;
} finally {
  await pool?.end();
}
