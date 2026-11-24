// The social feed's operator commands. Authenticated like the Mission Control
// operator procedure (MISSION_CONTROL_OPERATOR_ALLOWED_ID and
// MISSION_CONTROL_OPERATOR_TOKEN_SHA256; BLAST_OPERATOR_ID and
// BLAST_OPERATOR_TOKEN presented), against DATABASE_URL, which must be a role
// that may write the social operator tables (the owner). Every command that
// runs appends one social_operator_log row in its own transaction.
//
//   npm run social:operator -- config get [key]
//   npm run social:operator -- config set <key> <value> [--reason <text>]
//   npm run social:operator -- terms add <term> [--reason <text>]
//   npm run social:operator -- terms remove <term> [--reason <text>]
//   npm run social:operator -- terms list
//   npm run social:operator -- defaults set <callsign1> … <callsign5> [--reason <text>]
//   npm run social:operator -- backfill [--batch-size <n>] [--reason <text>]
//   npm run social:operator -- sale trust set <presale_id> --audited --reason <text>
//   npm run social:operator -- sale trust clear <presale_id> --audited --reason <text>
//   npm run social:operator -- sale trust list [--after <presale_id>] [--limit <n>]
//   npm run social:operator -- sale trust history <presale_id> [--before <log_id>] [--limit <n>]
//   npm run social:operator -- coin trust list [--after <coin_type>] [--limit <n>]
//   npm run social:operator -- coin trust history <coin_type> [--before <log_id>] [--limit <n>]
//   npm run social:operator -- sale metadata history <presale_id>
//   npm run social:operator -- sale metadata clear <presale_id> --reason <text>
//   npm run social:operator -- sale metadata revert <presale_id> <edit_id> --reason <text>
//   npm run social:operator -- sale metadata launch-at <presale_id> <ISO-8601|none> --reason <text>
//
// `sale trust set|clear` (R3-23) change a sale's audited flag; the reason is
// required and the public presale reads show the change within their 10 s CDN
// window. `history` reads the operator log back. The pink verified mark, of a
// sale or a bonding-curve coin, is set and cleared only on the admin website
// (0165); `sale trust` and `coin trust` list and history read it here.
//
// `backfill` (release) runs in bounded batches, each its own transaction, and
// logs one row with its counts at the end; it is safe to re-run.
//
// `sale metadata clear` and `revert` remove a cover from the sale's row in
// their transaction; once that commits, the cover's object is deleted from the
// public store when LAUNCH_ASSET_BLOB_READ_WRITE_TOKEN is set (the result's
// `cover` says `removed`, or `kept` without the token or when the delete fails).
//
// Readers (getSocialConfig, findBlockedTerm) cache for 30 s, so a change
// reaches every social route and the worker within 60 s.

import { createPool } from "@blast/core/modules/database/pool.ts";
import { withTransaction } from "@blast/core/modules/database/transaction.ts";
import { OperatorAuthenticator } from "@blast/server/modules/mission-control/operator/auth.ts";
import { OperatorError } from "@blast/server/modules/mission-control/operator/errors.ts";
import { SOCIAL_OPERATOR_COMMANDS } from "../src/modules/social/operator/commands.ts";
import { launchAssetStoreFromEnvironment } from "@blast/server/modules/launch-assets/store.ts";
import { removeOperatorCover } from "../src/modules/social/sales/operator.ts";
import {
  parseSocialOperatorInvocation,
  runSocialOperatorInvocation,
} from "../src/modules/social/operator/framework.ts";

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
  const invocation = parseSocialOperatorInvocation(process.argv.slice(2), SOCIAL_OPERATOR_COMMANDS);
  pool = createPool();
  const primary = pool;
  const result = await runSocialOperatorInvocation(invocation, operator, (operation, options) =>
    withTransaction(primary, operation, { label: "social.operator", ...options }));
  const cover = await removeOperatorCover(result.result, launchAssetStoreFromEnvironment());
  console.log(JSON.stringify(cover === "none" ? result : { ...result, cover }));
} catch (error) {
  const safe = error instanceof OperatorError ? error : new OperatorError("OPERATOR_UNAVAILABLE");
  console.error(JSON.stringify({ error: { code: safe.code, message: safe.message } }));
  if (safe.code === "OPERATOR_INPUT_INVALID") {
    console.error(SOCIAL_OPERATOR_COMMANDS.map((command) => `usage: npm run social:operator -- ${command.usage}`).join("\n"));
  }
  process.exitCode = 1;
} finally {
  await pool?.end();
}
