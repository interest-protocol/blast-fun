// The signing workers' release gate. An operator records each owner-provisioned
// check for the identity in force (`npm run worker:release-gate -- <role>
// record <check> <evidence>`); a gated worker signs nothing until every
// check's latest record for that identity is passed (`release-gate-open`
// otherwise). Records are appended to `blast_worker_release_gate_checks` by
// its owner, the migration login, and read through `blast_watcher`. A record
// binds to one identity digest (network, deployment fingerprint, signer
// address and, for the cap holders, the AdminCap), so a rotated key, cap or
// deployment starts with an open gate. Revoking a check is the durable way to
// pause a worker.
//
// Each role's digest is the one its records were made with: keeper and rewards
// hash `{network, role, fingerprint, signerAddress, adminCapId}`, the buyback
// key hashes `{adminCapId, deploymentFingerprint, network, signerAddress}`.
// Changing either shape would open every recorded gate.

import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { normalizeSuiAddress, normalizeSuiObjectId } from "@mysten/sui/utils";
import { autocommitRead, autocommitWrite } from "@blast/core/modules/database/transaction.ts";
import { redactPresaleText } from "@blast/core/modules/presale/redaction/redaction.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";
import type { WorkerAccess } from "./deployment.ts";
import { refuseForeignSignerKeys } from "./keys.ts";

const MODULE = "worker-runtime";
const MAX_EVIDENCE = 1_000;
const WORKER_CHECKS = ["indexer-coverage", "service-isolation", "gas-pool-rehearsal", "alerts"] as const;

/** Each signing role's checks, in the runbooks' order. */
const RELEASE_GATE_CHECKS = Object.freeze({
  "blast-keeper": WORKER_CHECKS,
  "vault-rewards": [...WORKER_CHECKS, "core-role"],
  // docs/launchpad/runbooks/buyback-key.md: a dedicated, gas-only key; an AdminCap holding
  // BuybackAdmin alone; BLAST_BUYBACK_ALERT_WEBHOOK_URL reaches the operators.
  "vault-buyback": ["buyback-key", "buyback-admin-grant", "buyback-alerts"],
} as const satisfies Record<string, readonly string[]>);

type WorkerRole = keyof typeof RELEASE_GATE_CHECKS;
const WORKER_ROLES = Object.freeze(Object.keys(RELEASE_GATE_CHECKS) as WorkerRole[]);

type IdentityFields = Readonly<{ network: string; fingerprint: string; signerAddress: string }>;

/** What a gate record binds to. Only the cap holders carry an AdminCap. */
export type ReleaseGateIdentity =
  | (IdentityFields & Readonly<{ role: "blast-keeper" }>)
  | (IdentityFields & Readonly<{ role: "vault-rewards" | "vault-buyback"; adminCapId: string }>);

/** sha256 (hex) of the identity's canonical JSON, in the shape its role's records were made with. */
export function releaseGateDigest(identity: ReleaseGateIdentity): string {
  // The type already says this; a cast must still not mint a digest no role's records use.
  const adminCapId = (identity as Readonly<{ adminCapId?: string | null }>).adminCapId ?? null;
  if (!Object.hasOwn(RELEASE_GATE_CHECKS, identity.role) || !/^[0-9a-f]{64}$/.test(identity.fingerprint))
    throw new Error("Invalid release gate identity.");
  if ((identity.role === "blast-keeper") !== (adminCapId === null)) throw new Error("Only the cap holders carry an AdminCap.");
  const signerAddress = normalizeSuiAddress(identity.signerAddress);
  const canonical =
    identity.role === "vault-buyback"
      ? { adminCapId: normalizeSuiObjectId(identity.adminCapId), deploymentFingerprint: identity.fingerprint, network: identity.network, signerAddress }
      : {
          network: identity.network,
          role: identity.role,
          fingerprint: identity.fingerprint,
          signerAddress,
          adminCapId: identity.role === "vault-rewards" ? normalizeSuiObjectId(identity.adminCapId) : null,
        };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** The role's checks whose latest record for `identity` is not passed, in the role's order. */
export async function readReleaseGate(pool: Pool, identity: ReleaseGateIdentity): Promise<readonly string[]> {
  const { rows } = await autocommitRead<{ check_name: string; passed: boolean }>(
    pool,
    MODULE,
    `SELECT DISTINCT ON (check_name) check_name, passed FROM blast_worker_release_gate_checks
     WHERE network = $1 AND identity_digest = $2 ORDER BY check_name, id DESC`,
    [identity.network, releaseGateDigest(identity)],
  );
  const passed = new Set(rows.filter((row) => row.passed).map((row) => row.check_name));
  return RELEASE_GATE_CHECKS[identity.role].filter((check) => !passed.has(check));
}

/** Appends a record (a revocation is `passed: false`). Evidence is redacted first and must then be 1 to 1000 characters. */
export async function recordReleaseCheck(
  pool: Pool,
  identity: ReleaseGateIdentity,
  check: string,
  passed: boolean,
  evidence: string,
  secrets: readonly string[] = [],
): Promise<void> {
  if (!(RELEASE_GATE_CHECKS[identity.role] as readonly string[]).includes(check)) throw new Error("Unknown worker release check.");
  const safe = redactReleaseGateEvidence(evidence, secrets).trim();
  if (!safe || safe.length > MAX_EVIDENCE) throw new Error(`Release evidence must be 1 to ${MAX_EVIDENCE} characters.`);
  await autocommitWrite(
    pool,
    MODULE,
    "blast_worker_release_gate_checks",
    `INSERT INTO blast_worker_release_gate_checks (network, identity_digest, check_name, passed, evidence)
     VALUES ($1, $2, $3, $4, $5)`,
    [identity.network, releaseGateDigest(identity), check, passed, safe],
  );
}

/** Keeper and rewards: in production, the stack's access holds only while the gate is passed. */
export function withWorkerReleaseGate(
  options: Readonly<{
    pool: Pool;
    /** The identity without the deployment fingerprint, which each pass's access supplies. */
    identity: (fingerprint: string) => ReleaseGateIdentity & Readonly<{ role: "blast-keeper" | "vault-rewards" }>;
    access: () => Promise<WorkerAccess>;
  }>,
): () => Promise<WorkerAccess> {
  return async () => {
    const access = await options.access();
    if (access.status === "blocked" || access.deployment.environment !== "production") return access;
    try {
      const missing = await readReleaseGate(options.pool, options.identity(access.fingerprint));
      return missing.length === 0 ? access : { status: "blocked", network: "mainnet", reasons: ["release-gate-open"] };
    } catch {
      return { status: "blocked", network: "mainnet", reasons: ["release-gate-unreadable"] };
    }
  };
}

const RELEASE_GATE_USAGE =
  "usage: npm run worker:release-gate -- <blast-keeper|vault-rewards|vault-buyback> status | record <check> <evidence> | revoke <check> <evidence>";

export type ReleaseGateCommand = Readonly<{ role: WorkerRole }> &
  (Readonly<{ action: "status" }> | Readonly<{ action: "record" | "revoke"; check: string; evidence: string }>);

/**
 * The operator command's arguments; throws the usage or the reason when they do not parse.
 * Evidence is bounded before redaction too, so an oversized paste cannot shrink to `[redacted]` and pass.
 */
export function parseReleaseGateCommand(argv: readonly string[]): ReleaseGateCommand {
  const [role, action, check, ...words] = argv;
  if (!WORKER_ROLES.includes(role as WorkerRole)) throw new Error(RELEASE_GATE_USAGE);
  const known = role as WorkerRole;
  if (action === "status" && argv.length === 2) return { role: known, action };
  if ((action !== "record" && action !== "revoke") || !check || words.length === 0) throw new Error(RELEASE_GATE_USAGE);
  const checks: readonly string[] = RELEASE_GATE_CHECKS[known];
  if (!checks.includes(check)) throw new Error(`unknown check: expected one of ${checks.join(", ")}`);
  const evidence = words.join(" ").trim();
  if (!evidence || evidence.length > MAX_EVIDENCE) throw new Error(`evidence must be 1 to ${MAX_EVIDENCE} characters`);
  return { role: known, action, check, evidence };
}

/** Each role's public identity variables: its signer key's name with `_KEY` → `_ADDRESS`, and the cap the worker reads. */
const IDENTITY_VARIABLES = Object.freeze({
  "blast-keeper": { address: "BLAST_WORKER_SIGNER_ADDRESS", cap: null },
  "vault-rewards": { address: "VAULT_REWARDS_SIGNER_ADDRESS", cap: "VAULT_REWARDS_ADMIN_CAP_ID" },
  "vault-buyback": { address: "BLAST_BUYBACK_SIGNER_ADDRESS", cap: "BLAST_BUYBACK_ADMIN_CAP_ID" },
} as const satisfies Record<WorkerRole, Readonly<{ address: string; cap: string | null }>>);

/**
 * The identity the keyless operator command records against: `BLAST_NETWORK`
 * (mainnet), `BLAST_DEPLOYMENT_FINGERPRINT`, the role's public signer address
 * and its AdminCap. Any `*_SIGNER_KEY` in the environment is refused.
 */
export function releaseGateIdentityFromEnvironment(role: WorkerRole, environment: Readonly<Record<string, string | undefined>>): ReleaseGateIdentity {
  refuseForeignSignerKeys(environment, null);
  const variables = IDENTITY_VARIABLES[role];
  const network = environment.BLAST_NETWORK?.trim();
  const fingerprint = environment.BLAST_DEPLOYMENT_FINGERPRINT?.trim() ?? "";
  const signerAddress = environment[variables.address]?.trim() ?? "";
  if (network !== "mainnet") throw new Error("BLAST_NETWORK must be mainnet.");
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error("BLAST_DEPLOYMENT_FINGERPRINT must be 64 lowercase hex.");
  if (!SUI_OBJECT_ID_PATTERN.test(signerAddress)) throw new Error(`${variables.address} must be the ${role} key's 0x-prefixed address.`);
  if (variables.cap === null) return { role: "blast-keeper", network, fingerprint, signerAddress };
  const adminCapId = environment[variables.cap]?.trim() ?? "";
  if (!SUI_OBJECT_ID_PATTERN.test(adminCapId)) throw new Error(`${variables.cap} must be a 0x-prefixed 64-hex object ID.`);
  return { role: role as "vault-rewards" | "vault-buyback", network, fingerprint, signerAddress, adminCapId };
}

/** An http(s) URL in free text. */
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>]+/gi;

/** A URL's password (`scheme://user:password@`): the password goes, the scheme and username stay. */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@"]*):[^\s/@"]+@/gi;

/**
 * A Sui address or object ID: public. It is delimited by anything but base64
 * letters, digits, `+` and `=`, so `/` separates it from a path's next
 * segment while a base64 run that merely contains hex stays one run.
 */
const SUI_ID = /(?<![A-Za-z0-9+=])0x[0-9a-fA-F]{64}(?![A-Za-z0-9+=])/g;

/** Sui explorers, matched exactly (no subdomain, so `api.suiscan.xyz` is not one). */
const EXPLORER_HOSTS: readonly string[] = ["suiscan.xyz", "suivision.xyz", "explorer.sui.io", "suiexplorer.com", "explorer.polymedia.app"];

/** A bare Telegram bot token (`<bot id>:<35 characters>`). */
const BOT_TOKEN = /\b\d{6,12}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g;

/** The value after a signer key's name (`PRESALE_LIFECYCLE_SIGNER_KEY=…`, `signer_key: …`, `"…_SIGNER_KEY":"…"`). */
const SIGNER_KEY_VALUE = /\b([A-Za-z0-9_]*SIGN(?:ER|ING)_?KEY["']?\s*[:=]\s*["']?)[^\s"',;]+/gi;

/** URL shapes that carry a token in their path. The configured webhook goes by its value (`secrets`). */
const TOKEN_URLS: readonly ((url: URL) => boolean)[] = [
  (url) => url.hostname === "hooks.slack.com",
  (url) => (url.hostname === "discord.com" || url.hostname === "discordapp.com") && url.pathname.startsWith("/api/webhooks/"),
  (url) => url.hostname === "api.telegram.org" && url.pathname.startsWith("/bot"),
  (url) => url.hostname.endsWith(".webhook.office.com"),
  (url) => url.hostname === "hooks.zapier.com",
];

function parsedUrl(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/**
 * Evidence as it may be stored. In order:
 *
 * 1. a URL's password goes (its scheme and username stay);
 * 2. every configured secret goes, whatever its shape (`secrets`: the keys in
 *    each encoding, the webhook URL and its path, database and node URLs and
 *    their passwords), before anything below can set text aside;
 * 3. bare Telegram bot tokens and the value after a signer key's name go;
 * 4. an explorer link keeps only its scheme, host and path: its query and
 *    fragment are dropped;
 * 5. Sui IDs (`0x` + 64 hex) are set aside, then T-008's rules run
 *    (`redactPresaleText`: named secrets, JWTs, keys, long base64 runs, which
 *    still apply to every explorer path segment and route word), and the path
 *    of a token-bearing URL (Slack, Discord, Telegram, Teams, Zapier) goes;
 * 6. the IDs are put back.
 *
 * Route words are not set aside: a token beside them still makes a long run.
 */
function redactReleaseGateEvidence(text: string, secrets: readonly string[]): string {
  let output = text.replace(URL_PASSWORD, "$1:[redacted]@");
  for (const secret of secrets) {
    if (secret.length >= 8) output = output.split(secret).join("[redacted]");
  }
  output = output
    .replace(BOT_TOKEN, "[redacted]")
    .replace(SIGNER_KEY_VALUE, "$1[redacted]")
    .replace(URL_IN_TEXT, (match) => {
      const url = parsedUrl(match);
      if (!url || !EXPLORER_HOSTS.includes(url.hostname.toLowerCase())) return match;
      const end = match.search(/[?#]/);
      return end === -1 ? match : match.slice(0, end);
    });
  const kept: string[] = [];
  output = output.replace(SUI_ID, (id) => `\u0000${kept.push(id) - 1}\u0000`);
  output = redactPresaleText(output).replace(URL_IN_TEXT, (match) => {
    const url = parsedUrl(match);
    return url && TOKEN_URLS.some((shape) => shape(url)) ? `${url.origin}/[redacted]` : match;
  });
  return output.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => kept[Number(index)] ?? "[redacted]");
}
