import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import { requiredSecret, requiredValue } from "@blast/core/lib/config/secret.ts";
import { trustedUrl } from "@blast/core/lib/config/trusted-origin.ts";
import { normalizeSiteOrigin } from "@blast/core/lib/site-origin.ts";
import { quotaNamespace } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { ACTIVITY_HINT_STREAM_BUDGET } from "@blast/core/modules/backend-api/stream-budget.ts";
import type { TrustedSite } from "../../transport/contracts.ts";

export type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Each backend role's gateway secret, and the one signer key it may hold: creator claims sign
 * offchain account attestations on the API; transaction signers remain worker-only.
 */
const ROLES = {
  api: { gatewaySecret: "BLAST_BACKEND_GATEWAY_SECRET", signerKey: "CREATOR_CLAIM_SIGNER_KEY" },
  hints: { gatewaySecret: "BLAST_BACKEND_HINTS_GATEWAY_SECRET", signerKey: null },
} as const;

/** Standalone hosting must reproduce the existing Vercel quota identity exactly. */
export function backendTransportConfig(environment: Environment, role: keyof typeof ROLES) {
  for (const name of Object.keys(environment)) {
    if (
      name !== ROLES[role].signerKey &&
      name.endsWith("_SIGNER_KEY") &&
      environment[name]?.trim()
    ) {
      throw new Error(`${name} must be absent from a public read backend.`);
    }
  }
  const identity = deploymentIdentity(environment);
  const maxPrivateWorkMs = privateWorkCap(environment);
  const namespace = quotaNamespace(environment.BLAST_REDIS_NAMESPACE, identity);
  if (
    !identity.localRun &&
    (!environment.BLAST_DEPLOYMENT_TARGET ||
      (!identity.production && !environment.BLAST_DEPLOYMENT_BRANCH) ||
      environment.BLAST_BACKEND_EXPECTED_QUOTA_NAMESPACE !== namespace)
  ) {
    throw new Error(
      "Backend quota identity requires BLAST_DEPLOYMENT_TARGET, a branch outside production, and the expected namespace.",
    );
  }
  requiredValue(environment, "BLAST_QUOTA_REDIS_URL");
  requiredSecret(environment, "RATE_LIMIT_SUBJECT_PEPPER");
  const gatewaySecret = requiredSecret(environment, ROLES[role].gatewaySecret);
  const port = Number(environment.PORT ?? "8080");
  const hostname = environment.BLAST_BACKEND_LISTEN_HOST ?? "0.0.0.0";
  if (!["127.0.0.1", "::1", "0.0.0.0", "::"].includes(hostname)) {
    throw new Error("Invalid backend listen host.");
  }
  const maxInflight = Number(environment.BLAST_BACKEND_MAX_INFLIGHT ?? "64");
  const maxAdminInflight = Number(environment.BLAST_BACKEND_MAX_ADMIN_INFLIGHT ?? "4");
  const maxHintStreams = Number(
    environment.BLAST_BACKEND_MAX_HINT_STREAMS ?? ACTIVITY_HINT_STREAM_BUDGET.defaultClients,
  );
  if (
    !Number.isInteger(maxHintStreams) ||
    maxHintStreams < 1 ||
    maxHintStreams > ACTIVITY_HINT_STREAM_BUDGET.maxClients
  ) {
    throw new Error("Invalid live stream capacity.");
  }
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !Number.isInteger(maxInflight) ||
    maxInflight < 1 ||
    maxInflight > 256
  ) {
    throw new Error("Invalid backend port or in-flight limit.");
  }
  if (
    !Number.isInteger(maxAdminInflight) ||
    maxAdminInflight < 1 ||
    maxAdminInflight > 16 ||
    maxAdminInflight > maxInflight
  ) {
    throw new Error("Invalid backend admin in-flight limit.");
  }
  return {
    namespace,
    extraSites: extraSites(environment, namespace),
    localRun: identity.localRun,
    port,
    hostname,
    maxInflight,
    maxAdminInflight,
    maxHintStreams,
    maxPrivateWorkMs,
    gatewaySecret,
  };
}

/**
 * `BLAST_BACKEND_MAX_PRIVATE_WORK_MS`: an optional cap on private work, so the drain (the cap plus
 * 10 s) fits a 300-second host shutdown.
 */
function privateWorkCap(environment: Environment): number | undefined {
  const configured = environment.BLAST_BACKEND_MAX_PRIVATE_WORK_MS;
  if (configured === undefined) {
    return undefined;
  }
  const cap = Number(configured);
  if (!Number.isInteger(cap) || cap < 180_000 || cap > 280_000) {
    throw new Error("Invalid backend private work cap; expected 180000–280000 milliseconds.");
  }
  return cap;
}

const EXTRA_SITES = "BLAST_BACKEND_EXTRA_SITES";
const MAX_EXTRA_SITES = 4;

/**
 * `BLAST_BACKEND_EXTRA_SITES`: optional JSON list of other web deployments this backend trusts,
 * for example `[{"origin":"https://dev.blast.fun","target":"dev","branch":"dev"}]`. Each site's
 * namespace is the one its own web relay signs (this backend's `BLAST_REDIS_NAMESPACE` with that
 * site's target and branch), so its replay keys and quotas never share the primary site's.
 * Errors name the variable, never its value.
 */
function extraSites(environment: Environment, namespace: string): readonly TrustedSite[] {
  const raw = environment[EXTRA_SITES]?.trim();
  if (!raw) {
    return [];
  }
  const invalid = () =>
    new Error(
      `${EXTRA_SITES} must be a JSON array of at most ${MAX_EXTRA_SITES} {"origin","target","branch"} entries, each a distinct non-production site.`,
    );
  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (!Array.isArray(entries) || !entries.length || entries.length > MAX_EXTRA_SITES) {
    throw invalid();
  }
  const primaryOrigin = normalizeSiteOrigin(environment.NEXT_PUBLIC_SITE_URL);
  const origins = new Set([primaryOrigin]);
  const namespaces = new Set([namespace]);
  return entries.map((entry: unknown) => {
    const { origin, target, branch, ...rest } = (
      entry && typeof entry === "object" ? entry : {}
    ) as Record<string, unknown>;
    if (
      Object.keys(rest).length ||
      typeof origin !== "string" ||
      typeof target !== "string" ||
      typeof branch !== "string" ||
      !target ||
      !branch ||
      target === "production"
    ) {
      throw invalid();
    }
    // The web relay signs its origin as text; only an exact, bare origin can ever match.
    if (trustedUrl(EXTRA_SITES, origin, { shape: "origin", http: "loopback" }).origin !== origin) {
      throw invalid();
    }
    const site = {
      siteOrigin: origin,
      namespace: quotaNamespace(environment.BLAST_REDIS_NAMESPACE, { target, branch }),
    };
    if (origins.has(site.siteOrigin) || namespaces.has(site.namespace)) {
      throw invalid();
    }
    origins.add(site.siteOrigin);
    namespaces.add(site.namespace);
    return site;
  });
}
