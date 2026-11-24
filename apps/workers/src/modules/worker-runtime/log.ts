// The worker's metrics and structured logs: one JSON line each on stdout, in
// the web app's metric format (`{ metric, at, ...fields }`), silenced by
// `MISSION_CONTROL_METRICS=off`. Fields are numbers, booleans and short
// labels; logs may add public chain identifiers (a Meme type, a digest).
// Nothing carries a key, a signature, a database or provider URL, or a
// provider's answer, and every line is redacted against the process's secrets
// before it is written.

import { createStructuredLog, type StructuredLog } from "@blast/core/lib/logging.ts";
import { workerKeyEncodings } from "./keys.ts";

export const WORKER_METRICS = Object.freeze({
  /** The worker started: its jobs and pool size. */
  started: "worker.started",
  /** The worker stopped after a signal. */
  stopped: "worker.stopped",
  /** One pass: access status and duration. */
  pass: "worker.pass",
  /** Another process holds this key's signer lease; this one idles. */
  standby: "worker.standby",
  /** The signer gate settled (or kept open) one submission: job and resolution. */
  gate: "worker.gate",
  /** The gate resent an open submission's same bytes. */
  resent: "worker.resent",
  /** Signing is blocked by configuration: reason codes. */
  configBlocked: "worker.config_blocked",
  /** The gas balance is below the funding alert threshold. */
  fundingAlert: "worker.funding_alert",
  /** A job failed outside its records (database or provider): error label. */
  jobError: "worker.job_error",
  /** A failure a job handled by its own rule (a provider read it treats as unknown): job and error label. */
  handledError: "worker.handled_error",
  /** Candidates discovered from `chain_read_v1.coins`. */
  discovered: "registration.discovered",
  /** The index serves another network or deployment. */
  indexBlocked: "registration.index_blocked",
  /** One record's pass: outcome and error class. */
  attempt: "registration.attempt",
  /** A record closed as registered: outcome and detection-to-registration latency. */
  registered: "registration.registered",
  /** Unfinished records by state and the oldest one's age. */
  backlog: "registration.backlog",
  /** Structured log of one record's pass, with its public chain identifiers. */
  record: "registration.record",
  /** MigrationReady launches newly recorded from `chain_read_v1.pools`. */
  migrationDiscovered: "migration.discovered",
  /** The index serves another network or deployment, or this deployment cannot migrate. */
  migrationBlocked: "migration.job_blocked",
  /** One launch's pass: outcome, error class, venue. */
  migrationAttempt: "migration.attempt",
  /** A launch closed as migrated: outcome, venue and detection-to-completion latency. */
  migrationMigrated: "migration.migrated",
  /** Unfinished migration records by state and the oldest one's age. */
  migrationBacklog: "migration.backlog",
  /** One migration pass: launches visited, provider failures among them (saturation), duration. */
  migrationPass: "migration.pass",
  /** Structured log of one launch's pass, with its public chain identifiers. */
  migrationRecord: "migration.record",
  /** Blast curve launches newly recorded by the opening-round keeper (LP-18). */
  openingDiscovered: "opening_round.discovered",
  /** The index serves another network or deployment: the keeper discovers and signs nothing. */
  openingBlocked: "opening_round.job_blocked",
  /** One launch's visit: `step` (`settle`, `deliver`), `outcome`, `errorClass`, `attempts`. */
  openingAttempt: "opening_round.attempt",
  /** A round closed as settled: `by` (`worker`, `external`, `unknown`) and end-to-settlement latency. */
  openingSettled: "opening_round.settled",
  /** One executed delivery transaction: how many bidders it paid. */
  openingDelivered: "opening_round.delivered",
  /** Records by state: due work, overdue settlements, stalled records. */
  openingBacklog: "opening_round.backlog",
  /** One keeper pass: launches visited, provider failures among them, duration. */
  openingPass: "opening_round.pass",
  /** Structured log of one launch's visit, with its public chain identifiers. */
  openingRecord: "opening_round.record",
  /** Blast curve launches newly recorded by the fee-claim job (LP-20). */
  feeClaimDiscovered: "fee_claim.discovered",
  /** The index serves another network or deployment: the job discovers and signs nothing. */
  feeClaimBlocked: "fee_claim.job_blocked",
  /** One claim decision: `kind` (`curve`, `vault`), `outcome`, `errorClass`, value and gas in MIST. */
  feeClaimAttempt: "fee_claim.attempt",
  /** One executed claim: `kind`, `partnered`, the claim's value and its gas cost in MIST. */
  feeClaimClaimed: "fee_claim.claimed",
  /** Records by state and the due backlog. */
  feeClaimBacklog: "fee_claim.backlog",
  /** One fee-claim pass: launches visited, provider failures among them, duration. */
  feeClaimPass: "fee_claim.pass",
  /** Structured log of one launch's visit, with its public chain identifiers. */
  feeClaimRecord: "fee_claim.record",
});

export type WorkerLog = StructuredLog;

/**
 * A log that writes redacted JSON lines. `secrets` are the raw values the
 * process holds (the signer key, the database URL and its password, the node
 * URL); a line that would contain one gets `[redacted]` instead.
 */
export function redactingLog(
  secrets: readonly string[],
  write: (line: string) => void = (line) => console.info(line),
  environment: Readonly<Record<string, string | undefined>> = process.env,
): WorkerLog {
  const log = createStructuredLog(write, secrets);
  return (name, fields = {}) => {
    if (environment.MISSION_CONTROL_METRICS === "off") return;
    log(name, fields);
  };
}

/**
 * The secret strings in a worker environment: values to redact, never to log.
 * Signer keys add their other encodings, webhooks their token-bearing path,
 * and URLs their decoded login and password and the `sslmode=verify-full`
 * spelling the database layer connects with.
 */
export function workerSecrets(environment: Readonly<Record<string, string | undefined>>): string[] {
  const signerKeys = Object.keys(environment).filter((name) => name.endsWith("_SIGNER_KEY"));
  const secrets: string[] = [];
  for (const name of [
    ...signerKeys,
    "REWARDS_PLANNER_DATABASE_URL",
    "REWARDS_BLOB_TOKEN",
    "BLAST_BUYBACK_ALERT_WEBHOOK_URL",
    "WATCHER_DATABASE_URL",
    "BLAST_WORKER_SUI_GRPC_URL",
    "BLAST_WORKER_SUI_GRAPHQL_URL",
    "DATABASE_URL",
    // The keepers' alert webhook (a Discord URL carries its token) and blast-infra's key.
    "BLAST_WORKER_ALERT_WEBHOOK_URL",
    "BLAST_INFRA_API_KEY",
  ]) {
    const value = environment[name]?.trim();
    if (!value) {
      continue;
    }
    secrets.push(value);
    if (signerKeys.includes(name)) {
      secrets.push(...workerKeyEncodings(value));
      continue;
    }
    secrets.push(...urlSecrets(value));
    if (WEBHOOKS.includes(name)) {
      secrets.push(...webhookPath(value));
    }
  }
  return secrets;
}

const WEBHOOKS: readonly string[] = ["BLAST_BUYBACK_ALERT_WEBHOOK_URL", "BLAST_WORKER_ALERT_WEBHOOK_URL"];

function webhookPath(value: string): string[] {
  try {
    const path = new URL(value).pathname;
    return path.length > 1 ? [path] : [];
  } catch {
    return [];
  }
}

function urlSecrets(value: string): string[] {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [];
  }
  // The raw value is already redacted whole; a malformed escape only loses its decoded spelling.
  const secrets = [url.password, url.username].filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  const modes = url.searchParams.getAll("sslmode");
  if (modes.length === 1 && modes[0] === "require") {
    url.searchParams.set("sslmode", "verify-full");
    secrets.push(url.toString());
  }
  return secrets;
}
