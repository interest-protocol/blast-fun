import { publicErrorResponse } from "@blast/core/lib/http-errors.ts";
import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import {
  DEFAULT_RATE_POLICIES,
  type RateBucket,
  type RateLimitPort,
  type RateLimitSubject,
  type RatePolicy,
} from "@blast/core/lib/web-security/rate-limits.ts";
import {
  GatewayReplayError,
  RedisRateLimitEnforcer,
} from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { routeLimitRefusal } from "@blast/core/modules/web-security/route-limits.ts";
import {
  INTERNAL_READ_PREFIX,
  type GatewayContext,
} from "@blast/core/modules/backend-api/gateway.ts";
import {
  PARTNER_KEY_HEADER,
  partnerResponseHeaders,
  requestedHeaders,
} from "@blast/core/modules/backend-api/partner-http.ts";
import {
  hashPartnerApiKey,
  isPartnerApiKey,
  type PartnerGrant,
  type PartnerKeyPolicy,
} from "@blast/server/modules/partner-api-keys/contracts.ts";
import type {
  RecognitionIdentity,
  RecognitionLimit,
} from "@blast/server/modules/partner-api-keys/recognition-store.ts";
import type { PartnerRecognition } from "@blast/server/modules/partner-api-keys/recognition.ts";
import {
  PARTNER_ENDPOINT_POLICIES,
  partnerRatePolicies,
} from "@blast/server/modules/partner-api-keys/runtime.ts";
import { PartnerScheduler } from "@blast/server/modules/partner-api-keys/scheduler.ts";
import { firstPartyReadCodes } from "@blast/server/modules/partner-api/v1/failures.ts";
import {
  firstPartyEndpointBucket,
  partnerEndpointBucket,
  partnerV1Route,
} from "@blast/server/modules/partner-api/v1/paths.ts";
import { applyPartnerApiHeaders } from "@blast/server/modules/partner-api/v1/response.ts";

import type {
  Admission,
  AdmissionDependencies,
  Admitted,
  Answered,
  Caller,
  FirstPartyCaller,
  Granted,
  PartnerCaller,
} from "./contract.ts";

const OPERATOR_LOGIN_BUCKETS: ReadonlySet<RateBucket> = new Set([
  "admin_login_ip",
  "admin_login_global",
]);

const PARTNER_CODES = {
  rateLimited: "partner_rate_limited",
  unavailable: "partner_api_unavailable",
} as const;

/**
 * The backend's only quota admission. An admitted read spends exactly one quota EVAL, which also
 * spends the gateway proof (first-party) or joins the tenant's operational window (partner, whose
 * recognition EVAL spends the proof first). An operator login attempt spends one EVAL of its two
 * login budgets.
 */
export function createAdmission(dependencies: AdmissionDependencies): Admission {
  const recognition = dependencies.recognition;
  const capacity = recognition?.store.capacity;
  const scheduler = capacity ? new PartnerScheduler(capacity) : null;
  const selectedPolicies = dependencies.policies ?? DEFAULT_RATE_POLICIES;
  const policies = capacity
    ? {
        ...selectedPolicies,
        partner_read_global: {
          ...selectedPolicies.partner_read_global,
          windows: [
            {
              limit:
                capacity.safeRequestsPerMinute -
                Object.values(capacity.reserves).reduce((total, value) => total + value, 0),
              windowSeconds: 60,
            },
          ],
        },
      }
    : selectedPolicies;
  const shared = enforcer(policies);
  // First-party proofs from an extra trusted site spend their nonce and quotas in its own namespace.
  const extraSites = new Map(
    (dependencies.extraNamespaces ?? []).map((namespace) => [
      namespace,
      enforcer(policies, namespace),
    ]),
  );
  const proofStore = (gateway: GatewayContext | undefined) =>
    (gateway && extraSites.get(gateway.namespace)) || shared;
  const enforcersByPolicy = new Map<string, RedisRateLimitEnforcer>();
  const prepaidByEndpoint = new Map<RateBucket, RateLimitPort>();

  return {
    admit,
    claimUnspentProof: (response, gateway) =>
      gatewayProof(proofStore(gateway), gateway).claimUnspent(response),
    recognizesPartners: !!scheduler,
    operatorLoginQuota: quotaPort(async (buckets, subject) => {
      if (buckets.some((bucket) => !OPERATOR_LOGIN_BUCKETS.has(bucket))) {
        throw new TypeError("The operator login quota spends only the login budgets.");
      }
      return shared.consumeAll(buckets, subject);
    }),
  };

  function admit(request: Request, caller: FirstPartyCaller): Promise<Admitted | Answered>;
  function admit(request: Request, caller: PartnerCaller): Promise<Granted | Answered>;
  function admit(request: Request, caller: Caller): Promise<Admitted | Granted | Answered> {
    return caller.kind === "first-party"
      ? admitFirstParty(request, caller.client, caller.gatewayAuthenticated, caller.gateway)
      : grantPartner(request, caller.client, caller.gateway);
  }

  async function admitFirstParty(
    request: Request,
    client: ClientAddress,
    gatewayAuthenticated: boolean,
    gateway: GatewayContext | undefined,
  ): Promise<Admitted | Answered> {
    const proof = gatewayProof(proofStore(gateway), gateway);
    if (!gatewayAuthenticated || request.headers.has(PARTNER_KEY_HEADER)) {
      return answered(
        await proof.claimUnspent(
          publicErrorResponse(
            "gateway_forbidden",
            "This endpoint requires the frontend gateway.",
            403,
          ),
        ),
      );
    }
    const url = new URL(request.url);
    url.pathname = url.pathname.slice(INTERNAL_READ_PREFIX.length);
    const endpoint = firstPartyEndpointBucket(url.pathname);
    if (!endpoint || !["GET", "HEAD"].includes(request.method)) {
      return answered(
        await proof.claimUnspent(
          publicErrorResponse("read_forbidden", "This read is not available.", 403),
        ),
      );
    }
    const canonical = new Request(url, {
      method: request.method,
      headers: request.headers,
      signal: request.signal,
    });
    // Public reporting has its own ceiling and shares the backend read budget with partners.
    const buckets: RateBucket[] =
      endpoint === "defillama_read"
        ? [endpoint, "defillama_public_global", "partner_read_global"]
        : [endpoint];
    const refused = await routeLimitRefusal(client, buckets, {
      limiter: quotaPort(proof.consumeAll),
      ...firstPartyReadCodes(url.pathname),
    });
    if (refused) {
      return answered(await proof.claimUnspent(refused));
    }
    return admitted(canonical, client, endpoint, new Headers());
  }

  /** Recognition, then one fresh primary grant for the presented key. */
  async function grantPartner(
    request: Request,
    client: ClientAddress,
    gateway: GatewayContext | undefined,
  ): Promise<Granted | Answered> {
    if (!recognition || !scheduler) {
      return answered(partnerClassificationRequired());
    }
    if (
      !partnerV1Route(new URL(request.url).pathname) ||
      !["GET", "HEAD", "OPTIONS"].includes(request.method)
    ) {
      return answered(await refusePartnerRoute(request));
    }
    let classifyRelease: (() => void) | undefined;
    try {
      const key = request.headers.get(PARTNER_KEY_HEADER) ?? "";
      if (request.method !== "OPTIONS" && !isPartnerApiKey(key)) {
        // Signed malformed requests still burn their single-use nonce, without map or SQL work.
        if (gateway?.nonce) {
          await shared.claimGatewayNonce(gateway.nonce);
        }
        return answered(partnerFailure("partner_key_invalid"));
      }
      classifyRelease = scheduler.classifier();
      // Recognition's own EVAL spends the gateway proof.
      const decision = await classifyPartnerRequest(
        recognition,
        request,
        client,
        key,
        gateway?.nonce,
        dependencies.namespace,
      );
      classifyRelease();
      classifyRelease = undefined;
      if (decision.kind === "limited") {
        return answered(partnerFailure(limitedRefusal(decision.limit), decision.retryAfter));
      }
      if (decision.kind === "unknown" && request.method !== "OPTIONS") {
        return answered(partnerFailure("partner_key_invalid"));
      }
      if (request.method === "OPTIONS") {
        return answered(await partnerPreflight(request, decision.kind === "origin"));
      }
      const identity = decision.identity;
      if (!identity) {
        return answered(partnerFailure("partner_api_unavailable"));
      }
      // One fresh primary grant belongs only to this request; Redis never supplies policy.
      const grant = await scheduler.run(identity.tenant, identity.keyId, request.signal, () =>
        freshGrant(dependencies, recognition, key, identity),
      );
      if (!grant) {
        return answered(await refuseRevokedKey(request));
      }
      return granted(request, client, recognition, scheduler, identity.tenant, grant);
    } catch (error) {
      if (error instanceof GatewayReplayError) {
        return answered(partnerFailure("gateway_forbidden"));
      }
      return answered(partnerFailure("partner_api_unavailable", 5));
    } finally {
      classifyRelease?.();
    }
  }

  /** A grant holds its tenant's lane until release and spends the request's one quota decision. */
  function granted(
    request: Request,
    client: ClientAddress,
    recognition: PartnerRecognition,
    scheduler: PartnerScheduler,
    tenant: string,
    grant: PartnerGrant,
  ): Granted {
    let decided = false;
    return {
      kind: "granted",
      release: scheduler.lane(tenant, grant.policy.tier === "internal"),
      async consumeQuota() {
        if (decided) {
          throw new Error("Admission already decided this request's quota.");
        }
        decided = true;
        const access = await decidePartnerQuota(request, client, recognition, grant);
        return access.response
          ? answered(await finalizePartnerRefusal(request, access.response, access.headers))
          : admitted(
              request,
              client,
              partnerEndpointBucket(new URL(request.url).pathname)!,
              access.headers,
            );
      },
    };
  }

  /**
   * The grant's origin, then its one commercial, endpoint and operational quota EVAL. Returns the
   * refusal to send, or null, with the access headers every answer carries.
   */
  async function decidePartnerQuota(
    request: Request,
    client: ClientAddress,
    recognition: PartnerRecognition,
    grant: PartnerGrant,
  ): Promise<Readonly<{ response: Response | null; headers: Headers }>> {
    const headers = partnerResponseHeaders(null);
    const refuse = (status: number, code: string, message: string) => ({
      response: publicErrorResponse(code, message, status, { headers }),
      headers,
    });
    try {
      const internal = grant.policy.tier === "internal";
      const origin = request.headers.get("origin");
      if (origin && (internal || !grant.origins.includes(origin))) {
        return refuse(
          403,
          "partner_origin_forbidden",
          "This origin is not enabled for this partner.",
        );
      }
      const endpoint = partnerEndpointBucket(new URL(request.url).pathname)!;
      const buckets: RateBucket[] = internal
        ? [endpoint]
        : ["partner_read", "partner_read_global", endpoint];
      const operational = recognition.responseWindow({ tenant: grant.id, internal });
      const selected = partnerEnforcer(grant.policy);
      const response = await routeLimitRefusal(client, buckets, {
        limiter: quotaPort((charged, subject) =>
          selected.consumeAllWithOperational(
            charged,
            subject,
            operational.window,
            operational.redis,
          ),
        ),
        subject: { apiKeyId: grant.keyId },
        ...PARTNER_CODES,
      });
      return { response, headers: partnerResponseHeaders(origin) };
    } catch {
      // Never log the key, query parameters, or schema error (which can contain values).
      headers.set("Retry-After", "5");
      return refuse(503, "partner_api_unavailable", "Partner access is temporarily unavailable.");
    }
  }

  function admitted(
    request: Request,
    client: ClientAddress,
    endpoint: RateBucket,
    headers: Headers,
  ): Admitted {
    return {
      kind: "admitted",
      request,
      client,
      endpoint,
      prepaid: prepaidPort(endpoint),
      headers,
    };
  }

  /** One stable port per endpoint, so handlers built on it can be reused across reads. */
  function prepaidPort(endpoint: RateBucket): RateLimitPort {
    const existing = prepaidByEndpoint.get(endpoint);
    if (existing) {
      return existing;
    }
    const created: RateLimitPort = {
      async consume(requested) {
        if (requested !== endpoint) {
          throw new Error("Public handler requested an unadmitted endpoint budget.");
        }
        return {
          allowed: true,
          bucket: endpoint,
          policyVersion: policies[endpoint].version,
          retryAfterSeconds: 0,
        };
      },
    };
    prepaidByEndpoint.set(endpoint, created);
    return created;
  }

  function enforcer(
    selected: Readonly<Record<RateBucket, RatePolicy>>,
    namespace = dependencies.namespace,
  ) {
    return new RedisRateLimitEnforcer({
      redis: dependencies.redis,
      namespace,
      operationalNamespace: recognition?.store.namespace,
      subjectPepper: dependencies.subjectPepper,
      policies: selected,
    });
  }

  /** A key's commercial windows; endpoint budgets are counted per key, not per IP. */
  function partnerEnforcer(policy: PartnerKeyPolicy): RedisRateLimitEnforcer {
    const cacheKey = JSON.stringify(policy);
    const existing = enforcersByPolicy.get(cacheKey);
    if (existing) {
      return existing;
    }
    const commercial =
      policy.tier === "internal"
        ? policies
        : {
            ...policies,
            partner_read: partnerRatePolicies(policy).partner_read,
          };
    const endpointPolicies = Object.fromEntries(
      Object.entries(PARTNER_ENDPOINT_POLICIES)
        .filter(([, value]) => value.subjectScope === "api_key")
        .map(([bucket]) => [
          bucket,
          {
            ...commercial[bucket as RateBucket],
            subjectScope: "api_key" as const,
          },
        ]),
    );
    const created = enforcer({ ...commercial, ...endpointPolicies });
    if (enforcersByPolicy.size >= 64) {
      enforcersByPolicy.delete(enforcersByPolicy.keys().next().value!);
    }
    enforcersByPolicy.set(cacheKey, created);
    return created;
  }
}

/**
 * A verified gateway proof is one-use: the request's quota decision spends it, and an answer
 * without one spends it alone.
 */
function gatewayProof(shared: RedisRateLimitEnforcer, gateway: GatewayContext | undefined) {
  let nonce = gateway?.nonce;
  let replayed = false;

  async function consumeAll(buckets: readonly RateBucket[], subject: RateLimitSubject) {
    const pending = nonce;
    // An uncertain Redis result must not retry admission or run the handler.
    nonce = undefined;
    try {
      return await shared.consumeAll(buckets, subject, pending);
    } catch (error) {
      if (error instanceof GatewayReplayError) {
        replayed = true;
      }
      throw error;
    }
  }

  async function claimUnspent(response: Response): Promise<Response> {
    // Invalid paths/keys have no budget decision, but a verified proof remains one-use.
    if (nonce !== undefined) {
      try {
        await shared.claimGatewayNonce(nonce);
      } catch (error) {
        if (error instanceof GatewayReplayError) {
          replayed = true;
        } else {
          return publicErrorResponse(
            "service_unavailable",
            "Admission is temporarily unavailable.",
            503,
            { headers: { "Retry-After": "5" } },
          );
        }
      }
    }
    return replayed
      ? publicErrorResponse("gateway_forbidden", "Gateway proof already consumed.", 403)
      : response;
  }

  return { consumeAll, claimUnspent };
}

/** routeLimitRefusal makes one consumeAll call for non-empty buckets: the request's one EVAL. */
function quotaPort(consumeAll: NonNullable<RateLimitPort["consumeAll"]>): RateLimitPort {
  return { consume: (bucket, subject) => consumeAll([bucket], subject), consumeAll };
}

function answered(response: Response): Answered {
  return { kind: "answered", response };
}

/** Without recognition and its capacity the backend serves no partner read. */
export function partnerClassificationRequired(): Response {
  return publicErrorResponse("partner_api_unavailable", "Partner classification is required.", 503);
}

/** A path outside the partner allowlist, or a method partners cannot use. */
export async function refusePartnerRoute(request: Request): Promise<Response> {
  const headers = partnerResponseHeaders(null);
  if (!partnerV1Route(new URL(request.url).pathname)) {
    return finalizePartnerRefusal(
      request,
      publicErrorResponse(
        "partner_read_forbidden",
        "This endpoint is not available to partners.",
        403,
        { headers },
      ),
      headers,
    );
  }
  headers.set("Allow", "GET, HEAD, OPTIONS");
  return finalizePartnerRefusal(
    request,
    publicErrorResponse("partner_read_only", "Partner access is read-only.", 405, { headers }),
    headers,
  );
}

/** The primary has no active grant for a key recognition knew: revoked since publication. */
function refuseRevokedKey(request: Request): Promise<Response> {
  const headers = partnerResponseHeaders(null);
  return finalizePartnerRefusal(
    request,
    publicErrorResponse(
      "partner_key_invalid",
      PARTNER_FAILURES.partner_key_invalid.message,
      PARTNER_FAILURES.partner_key_invalid.status,
      { headers },
    ),
    headers,
  );
}

/** Partner refusals carry the access headers; a HEAD refusal has no body. */
async function finalizePartnerRefusal(
  request: Request,
  response: Response,
  accessHeaders: Headers,
): Promise<Response> {
  if (request.method === "HEAD") {
    await response.body?.cancel();
  }
  return applyPartnerApiHeaders(
    new Response(request.method === "HEAD" ? null : response.body, {
      status: response.status,
      headers: response.headers,
    }),
    accessHeaders,
  );
}

/**
 * Partner refusals before a grant, with the published messages. Only a limit (429) or an outage
 * (503) is worth retrying, so only those carry `Retry-After`.
 */
const PARTNER_FAILURES = {
  partner_key_invalid: {
    status: 401,
    message: "A valid partner API key is required.",
    retry: false,
  },
  gateway_forbidden: { status: 403, message: "Gateway proof already consumed.", retry: false },
  partner_rate_limited: { status: 429, message: "Partner request limit reached.", retry: true },
  partner_api_unavailable: {
    status: 503,
    message: "Partner access is temporarily unavailable.",
    retry: true,
  },
} as const;

function partnerFailure(code: keyof typeof PARTNER_FAILURES, retryAfter = 1): Response {
  const { status, message, retry } = PARTNER_FAILURES[code];
  return applyPartnerApiHeaders(
    publicErrorResponse(code, message, status, {
      headers: retry ? { "Retry-After": String(retryAfter) } : {},
    }),
    partnerResponseHeaders(null),
  );
}

/** A preflight carries no key; the actual read must authenticate for this origin. */
async function partnerPreflight(request: Request, originEnabled: boolean): Promise<Response> {
  const origin = request.headers.get("origin");
  const requested = requestedHeaders(request);
  if (
    !origin ||
    !["GET", "HEAD"].includes(request.headers.get("access-control-request-method") ?? "") ||
    !requested.includes(PARTNER_KEY_HEADER) ||
    requested.some((header) => header !== PARTNER_KEY_HEADER) ||
    !originEnabled
  ) {
    const headers = partnerResponseHeaders(null);
    return finalizePartnerRefusal(
      request,
      publicErrorResponse("partner_origin_forbidden", "This browser request is not allowed.", 403, {
        headers,
      }),
      headers,
    );
  }
  const headers = partnerResponseHeaders(origin);
  headers.set("Access-Control-Allow-Methods", "GET, HEAD");
  headers.set("Access-Control-Allow-Headers", PARTNER_KEY_HEADER);
  headers.set("Access-Control-Max-Age", "300");
  headers.set("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
  return finalizePartnerRefusal(request, new Response(null, { status: 204, headers }), headers);
}

/** Preflights classify their origin; reads classify the presented key's digest. */
function classifyPartnerRequest(
  recognition: PartnerRecognition,
  request: Request,
  client: ClientAddress,
  key: string,
  nonce: string | undefined,
  nonceNamespace: string,
) {
  return recognition.classify({
    digest: recognition.store.digest(hashPartnerApiKey(key)),
    ...(request.method === "OPTIONS" ? { origin: request.headers.get("origin") ?? "" } : {}),
    ip: client.address,
    nonce,
    nonceNamespace,
  });
}

/** One fresh primary grant; a disagreeing Redis identity requests a repair and refuses. */
async function freshGrant(
  dependencies: AdmissionDependencies,
  recognition: PartnerRecognition,
  key: string,
  identity: RecognitionIdentity,
) {
  const verified = await dependencies.keys.verify(key);
  if (verified && (verified.id !== identity.tenant || verified.keyId !== identity.keyId)) {
    recognition.invalidate();
    throw new Error("Scheduling identity disagrees with primary authorization.");
  }
  return verified;
}

/**
 * Only the shared preflight reserve is service capacity. A caller over its own key
 * or network limit gets 429; nothing here precedes a grant, so no origin is echoed.
 */
function limitedRefusal(limit: RecognitionLimit | undefined) {
  return limit === "preflight" ? "partner_api_unavailable" : "partner_rate_limited";
}
