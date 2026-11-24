// Keyless operator command for the signing workers' release gate (`worker-runtime/release-gate.ts`).
// It writes gate records as the migration login and sends no transaction.
import { createPool } from "@blast/core/modules/database/pool.ts";
import { migrationDatabaseUrl } from "@blast/core/modules/database/topology.ts";
import { workerSecrets } from "#workers/modules/worker-runtime/log.ts";
import {
  parseReleaseGateCommand,
  readReleaseGate,
  recordReleaseCheck,
  releaseGateDigest,
  releaseGateIdentityFromEnvironment,
  type ReleaseGateCommand,
} from "#workers/modules/worker-runtime/release-gate.ts";

console.info = (...lines: unknown[]) => console.error(...lines);

let command: ReleaseGateCommand;
try {
  command = parseReleaseGateCommand(process.argv.slice(2));
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : "usage" }));
  process.exit(2);
}

let pool: ReturnType<typeof createPool> | undefined;
try {
  const identity = releaseGateIdentityFromEnvironment(command.role, process.env);
  pool = createPool(migrationDatabaseUrl(process.env), { max: 1 });
  if (command.action !== "status") {
    const secrets = [...workerSecrets(process.env), process.env.DATABASE_MIGRATION_URL?.trim() ?? ""];
    await recordReleaseCheck(pool, identity, command.check, command.action === "record", command.evidence, secrets);
  }
  const missing = await readReleaseGate(pool, identity);
  console.log(JSON.stringify({
    role: identity.role,
    network: identity.network,
    identityDigest: releaseGateDigest(identity),
    gate: missing.length === 0 ? "passed" : "open",
    missing,
  }));
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : "Release gate failed." }));
  process.exitCode = 1;
} finally {
  await pool?.end();
}
