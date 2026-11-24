import { deploymentIdentity } from "../../lib/config/deployment-identity.ts";

/**
 * The database endpoints of the shared Neon deployment. One Neon project, one
 * production branch and one logical database hold the chain tables (written by
 * blast-infra) and the web app's tables. The web app reaches it three ways:
 *
 * - `DATABASE_URL`: the primary's pooled endpoint, for writes and
 *   consistency-sensitive, social and moderation reads;
 * - `DATABASE_REPLICA_URL`: the read replica's pooled endpoint, for chain joins;
 * - `DATABASE_MIGRATION_URL`: the primary's direct endpoint, for migrations,
 *   as a login other than the runtime one;
 * - `WATCHER_DATABASE_URL`: the primary's pooled endpoint for the operational
 *   worker's own process, as the watcher login (never the web app's).
 *
 * Each accessor fails closed: a missing endpoint, or one that names another
 * endpoint kind, database or region, throws. Nothing falls back to another
 * endpoint. Messages name variables only; a URL may carry a password.
 */

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Where production runs: every production endpoint must be in this Neon
 * region, beside the Vercel region. Compute sizing lives in the Neon console
 * (docs/mission-control/capacity.md, "Shared Neon runtime").
 */
export const NEON_REGION = "aws-us-east-1";
export const VERCEL_REGION = "iad1";

function isNeonHost(host: string): boolean {
  return host.toLowerCase().endsWith(".neon.tech");
}

/** Whether a connection string names a Neon endpoint (checked by its host only). */
export function isNeonUrl(value: string): boolean {
  try {
    return isNeonHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

interface Endpoint {
  readonly url: string;
  readonly neon: boolean;
  /** The Neon endpoint id, without `-pooler`. */
  readonly endpointId: string;
  readonly pooled: boolean;
  /** `<cloud>-<region>`, such as `aws-us-east-1`, for a Neon host. */
  readonly region: string | null;
  readonly host: string;
  readonly port: string;
  readonly database: string;
  readonly login: string;
}

/**
 * Production endpoint rules apply wherever the deployment identity says
 * production: Vercel production, a production worker, or a production backend.
 */
function isProduction(environment: Environment): boolean {
  return deploymentIdentity(environment).production;
}

export function databaseEndpoint(name: string, raw: string | undefined, environment: Environment): Endpoint | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a PostgreSQL URL.`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${name} must be a PostgreSQL URL.`);
  }
  if (["host", "hostaddr", "port", "user", "password"].some((key) => url.searchParams.has(key))) {
    throw new Error(`${name} must use the URL authority for connection identity.`);
  }
  const host = url.hostname.toLowerCase();
  const neon = isNeonHost(host);
  const modes = url.searchParams.getAll("sslmode");
  // Older sealed provider URLs use require. Pin the connection sent to pg to
  // full certificate/hostname verification instead of relying on its changing
  // interpretation of require. Other modes and ambiguous settings fail closed.
  const legacyTls = neon && modes.length === 1 && modes[0] === "require";
  if (legacyTls) url.searchParams.set("sslmode", "verify-full");
  const labels = host.split(".");
  const first = labels[0] ?? "";
  const endpoint: Endpoint = {
    url: legacyTls ? url.toString() : value,
    neon,
    endpointId: first.replace(/-pooler$/, ""),
    pooled: first.endsWith("-pooler"),
    region: neon && labels.length >= 5
      ? `${labels[labels.length - 3]}-${labels[labels.length - 4]}`
      : null,
    host: neon ? labels.slice(1).join(".") : host,
    port: url.port || "5432",
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    login: decodeURIComponent(url.username),
  };

  assertEndpoint(name, endpoint, url, environment);
  return endpoint;
}

function assertEndpoint(name: string, endpoint: Endpoint, url: URL, environment: Environment): void {
  const neon = endpoint.neon;
  if (isProduction(environment)) {
    if (!neon) throw new Error(`${name} must be a Neon endpoint in production.`);
    if (endpoint.region !== NEON_REGION) {
      throw new Error(
        `${name} must be in Neon region ${NEON_REGION}, beside Vercel ${VERCEL_REGION}.`,
      );
    }
  }
  if (neon) {
    if (url.searchParams.has("uselibpqcompat")) {
      throw new Error(`${name} must not set uselibpqcompat.`);
    }
    const modes = url.searchParams.getAll("sslmode");
    if (modes.length !== 1 || modes[0] !== "verify-full") {
      throw new Error(`${name} must set sslmode=verify-full.`);
    }
    if (!endpoint.login) throw new Error(`${name} must name a database login.`);
  }
}

/** Pool constructors also enforce Neon TLS when an operator passes a direct URL. */
export function databaseConnectionUrl(value: string): string {
  const endpoint = databaseEndpoint("Database URL", value, {});
  if (!endpoint) throw new Error("Database URL is required.");
  return endpoint.url;
}

export function requirePooled(name: string, endpoint: Endpoint): void {
  if (endpoint.neon && !endpoint.pooled) {
    throw new Error(`${name} must use the Neon pooled endpoint (host ending in -pooler).`);
  }
}

function primary(environment: Environment): Endpoint {
  const endpoint = databaseEndpoint("DATABASE_URL", environment.DATABASE_URL, environment);
  if (!endpoint) {
    throw new Error("DATABASE_URL is required: the Neon primary's pooled endpoint.");
  }
  requirePooled("DATABASE_URL", endpoint);
  return endpoint;
}

/** The primary's pooled endpoint: writes and consistency-sensitive reads. */
export function primaryPooledUrl(environment: Environment = process.env): string {
  return primary(environment).url;
}

/** Identify the server shared by pooled and direct URLs. Roles can also require a matching port. */
export function sameDatabaseHost(left: Endpoint, right: Endpoint): boolean {
  return left.neon === right.neon && left.host === right.host &&
    (!left.neon || left.endpointId === right.endpointId);
}

/** Fresh partner grants use a separate login on exactly the primary, never a replica. */
export function partnerVerifierPooledUrl(environment: Environment = process.env): string {
  const main = primary(environment);
  const name = "PARTNER_VERIFIER_DATABASE_URL";
  const verifier = databaseEndpoint(name, environment[name], environment);
  if (!verifier) throw new Error(`${name} is required for partner verification.`);
  requirePooled(name, verifier);
  if (!sameDatabaseHost(verifier, main) || verifier.port !== main.port) {
    throw new Error(`${name} must name the primary behind DATABASE_URL.`);
  }
  if (verifier.database !== main.database)
    throw new Error(`${name} must name the same database as DATABASE_URL.`);
  if (!verifier.login || verifier.login === main.login)
    throw new Error(`${name} must use a different login than DATABASE_URL.`);
  // A role override would evade the login boundary, including on local fixtures.
  if (new URL(verifier.url).searchParams.has("options"))
    throw new Error(`${name} must not override the database role through connection options.`);
  return verifier.url;
}

/**
 * The read replica's pooled endpoint, for chain joins. Never the primary: a
 * replica that is missing or names the primary is a configuration error, not
 * a reason to put terminal read load on the primary.
 */
export function replicaPooledUrl(environment: Environment = process.env): string {
  const main = primary(environment);
  const replica = databaseEndpoint("DATABASE_REPLICA_URL", environment.DATABASE_REPLICA_URL, environment);
  if (!replica) {
    throw new Error("DATABASE_REPLICA_URL is required for chain reads: the Neon read replica's pooled endpoint.");
  }
  requirePooled("DATABASE_REPLICA_URL", replica);
  const samePrimary = replica.neon
    ? sameDatabaseHost(replica, main)
    : replica.url === main.url;
  if (samePrimary) {
    throw new Error("DATABASE_REPLICA_URL must name the read replica, not the primary.");
  }
  if (replica.neon !== main.neon || replica.region !== main.region || (replica.neon && replica.host !== main.host)) {
    throw new Error("DATABASE_REPLICA_URL must be in the primary's region and Neon project.");
  }
  if (replica.database !== main.database) {
    throw new Error("DATABASE_REPLICA_URL must name the same database as DATABASE_URL.");
  }
  return replica.url;
}

/**
 * The primary's direct endpoint for migrations: `DATABASE_MIGRATION_URL`, or
 * a `DATABASE_URL` that is itself direct (a local database, or a one-off
 * `DATABASE_URL=<direct> npm run db:migrate`). A transaction-mode pooler does
 * not keep the migration's session advisory lock on one backend.
 */
export function migrationDatabaseUrl(environment: Environment = process.env): string {
  const migration = databaseEndpoint("DATABASE_MIGRATION_URL", environment.DATABASE_MIGRATION_URL, environment);
  const runtime = databaseEndpoint("DATABASE_URL", environment.DATABASE_URL, environment);
  if (!migration) {
    if (!runtime) throw new Error("DATABASE_MIGRATION_URL or DATABASE_URL is required to migrate.");
    if (runtime.neon && runtime.pooled) {
      throw new Error("DATABASE_MIGRATION_URL is required: DATABASE_URL is the Neon pooler.");
    }
    return runtime.url;
  }
  if (migration.neon && migration.pooled) {
    throw new Error("DATABASE_MIGRATION_URL must use the Neon primary's direct endpoint, not its pooler.");
  }
  if (!runtime) return migration.url;
  assertMigrationPrimary(migration, runtime);
  return migration.url;
}

function assertMigrationPrimary(migration: Endpoint, runtime: Endpoint): void {
  requirePooled("DATABASE_URL", runtime);
  if (!sameDatabaseHost(migration, runtime) || (!migration.neon && migration.port !== runtime.port)) {
    throw new Error("DATABASE_MIGRATION_URL must name the primary behind DATABASE_URL.");
  }
  if (migration.database !== runtime.database) {
    throw new Error("DATABASE_MIGRATION_URL must name the same database as DATABASE_URL.");
  }
  if (migration.neon && migration.login === runtime.login) {
    throw new Error("DATABASE_MIGRATION_URL must use a different login than DATABASE_URL.");
  }
}

/**
 * The operational worker's endpoint: the primary's pooled endpoint in
 * `WATCHER_DATABASE_URL`, as the watcher login (`blast_watch`, holding only
 * `blast_watcher`). Never the replica: what the worker acts on must see the
 * latest commit. The web app never reads this variable; when the worker's
 * environment also carries `DATABASE_URL`, the two logins must differ.
 */
export function watcherPooledUrl(environment: Environment = process.env): string {
  const watcher = databaseEndpoint("WATCHER_DATABASE_URL", environment.WATCHER_DATABASE_URL, environment);
  if (!watcher) {
    throw new Error("WATCHER_DATABASE_URL is required: the Neon primary's pooled endpoint as the watcher login.");
  }
  requirePooled("WATCHER_DATABASE_URL", watcher);
  const runtime = databaseEndpoint("DATABASE_URL", environment.DATABASE_URL, environment);
  if (watcher.neon && runtime?.neon && runtime.login === watcher.login) {
    throw new Error("WATCHER_DATABASE_URL must use its own login, not the web runtime's.");
  }
  return watcher.url;
}
