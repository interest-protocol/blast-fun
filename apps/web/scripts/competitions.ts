import { readFile } from "node:fs/promises";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import {
  OperatorAuthenticator,
  OperatorError,
} from "@blast/server/modules/mission-control/operator/index.ts";
import {
  createCompetition,
  listCompetitions,
} from "@blast/server/modules/social/competitions/repository.ts";

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
  const [command, argument, ...extra] = process.argv.slice(2);
  if (
    extra.length ||
    !(
      (command === "create" && argument) ||
      (command === "list" && (!argument || /^[1-9][0-9]{0,4}$/.test(argument)))
    )
  ) {
    throw new Error("Usage: competitions create config.json | competitions list [page]");
  }
  pool = createPool();
  const result =
    command === "create"
      ? await createCompetition(pool, JSON.parse(await readFile(argument, "utf8")), operator)
      : await listCompetitions(autocommitReader(pool, "social"), Number(argument ?? "1"));
  console.log(JSON.stringify(result));
} catch (error) {
  // No database/credential detail in operator output.
  console.error(
    error instanceof OperatorError
      ? error.code
      : "Competition command failed: check the configuration, unique slug, future start and database availability.",
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
