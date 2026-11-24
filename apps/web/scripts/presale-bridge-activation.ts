// The presale bridge activation operator command: records the 5 October
// CCTP V2 checklist, deactivates the bridge, or prints its state and record
// history. Authenticated like the Mission Control operator procedure
// (MISSION_CONTROL_OPERATOR_ALLOWED_ID and MISSION_CONTROL_OPERATOR_TOKEN_SHA256;
// BLAST_OPERATOR_ID and BLAST_OPERATOR_TOKEN presented), against DATABASE_URL,
// with the deployment's PRESALE_DEPLOYMENT_MANIFEST, PRESALE_BRIDGE_FORWARDING
// and PRESALE_BRIDGE_RELAYER_ADDRESS. See docs/presale/runbooks/bridge-activation.md.
//
//   npm run presale:bridge-activation -- record <checklist.json>
//   npm run presale:bridge-activation -- deactivate <reason>
//   npm run presale:bridge-activation -- status
//   npm run presale:bridge-activation -- history [limit]
//   npm run presale:bridge-activation -- register-test <source> <tx_hash> <sui_address> <amount> <presale_id>

import { readFile } from "node:fs/promises";

import { createPool } from "@blast/core/modules/database/pool.ts";
import { OperatorAuthenticator } from "@blast/server/modules/mission-control/operator/auth.ts";
import { OperatorError } from "@blast/server/modules/mission-control/operator/errors.ts";
import { bridgeConfigurationFromEnvironment } from "@blast/server/modules/presale/bridge/activation.ts";
import { parseBridgeActivationCommand, runBridgeActivationCommand } from "@blast/server/modules/presale/bridge/activation-command.ts";
import { PostgresBridgeActivations, PostgresBridgeTransfers } from "@blast/core/modules/presale/bridge/repository.ts";
import { readPresaleDeploymentIdentity } from "@blast/core/modules/presale/deployment/service.ts";

// Stdout carries exactly one JSON result line; metric lines go to stderr with any error.
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
  const command = parseBridgeActivationCommand(process.argv.slice(2));
  pool = createPool();
  const result = await runBridgeActivationCommand(command, operator, {
    async readChecklist(path) {
      try {
        return JSON.parse(await readFile(path, "utf8")) as unknown;
      } catch {
        throw new OperatorError("OPERATOR_INPUT_INVALID");
      }
    },
    records: new PostgresBridgeActivations(pool),
    transfers: new PostgresBridgeTransfers(pool),
    configuration: () => bridgeConfigurationFromEnvironment(process.env, readPresaleDeploymentIdentity(process.env)),
  });
  console.log(JSON.stringify(result));
} catch (error) {
  const safe = error instanceof OperatorError ? error : new OperatorError("OPERATOR_UNAVAILABLE");
  console.error(JSON.stringify({ error: { code: safe.code, message: safe.message } }));
  process.exitCode = 1;
} finally {
  await pool?.end();
}
