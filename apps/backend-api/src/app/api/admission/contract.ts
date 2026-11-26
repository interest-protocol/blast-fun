import type { RedisCommands } from "@blast/core/lib/redis.ts";
import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import type {
  RateBucket,
  RateLimitPort,
  RatePolicy,
} from "@blast/core/lib/web-security/rate-limits.ts";
import type { GatewayContext } from "@blast/core/modules/backend-api/gateway.ts";
import type { PartnerKeyReader } from "@blast/server/modules/partner-api-keys/contracts.ts";
import type { PartnerRecognition } from "@blast/server/modules/partner-api-keys/recognition.ts";

export type AdmissionDependencies = Readonly<{
  keys: PartnerKeyReader;
  recognition?: PartnerRecognition;
  redis: RedisCommands;
  namespace: string;
  /** Extra trusted sites' namespaces; only first-party read proofs may carry one. */
  extraNamespaces?: readonly string[];
  subjectPepper: string;
  /** Override policies only in isolated local fixtures; runtime uses the registry. */
  policies?: Readonly<Record<RateBucket, RatePolicy>>;
}>;

/** A read from the signed frontend gateway; direct calls in fixtures may carry no proof. */
export type FirstPartyCaller = Readonly<{
  kind: "first-party";
  client: ClientAddress;
  gatewayAuthenticated: boolean;
  gateway?: GatewayContext;
}>;

/** A read presenting a partner key, signed by the gateway or sent directly. */
export type PartnerCaller = Readonly<{
  kind: "partner";
  client: ClientAddress;
  gateway?: GatewayContext;
}>;

export type Caller = FirstPartyCaller | PartnerCaller;

/**
 * The request passed its one quota decision. `endpoint` is already paid: the read handler draws it
 * again only from `prepaid`, one port per endpoint that never reaches Redis.
 */
export type Admitted = Readonly<{
  kind: "admitted";
  /** The read to serve; a first-party read is canonicalized to its partner v1 path. */
  request: Request;
  client: ClientAddress;
  endpoint: RateBucket;
  prepaid: RateLimitPort;
  /** Partner CORS headers every answer carries; empty for first-party reads. */
  headers: Headers;
}>;

/** Admission answered without running a handler: every refusal, and a partner preflight. */
export type Answered = Readonly<{ kind: "answered"; response: Response }>;

/**
 * A partner key passed recognition and the primary granted it, and the request holds its tenant's
 * lane until `release`. The transport registers `release` before `consumeQuota` makes the request's
 * one quota decision; a second call throws.
 */
export type Granted = Readonly<{
  kind: "granted";
  release: () => void;
  consumeQuota(): Promise<Admitted | Answered>;
}>;

/**
 * The backend's quota admission. Redis is the authority and fails closed. Transport permits,
 * budgets and the private nonce burn are capacity and replay, not quota, and stay in the transport.
 */
export type Admission = Readonly<{
  /** A first-party read is admitted in one step; a partner read is granted, then consumes quota. */
  admit(request: Request, caller: FirstPartyCaller): Promise<Admitted | Answered>;
  admit(request: Request, caller: PartnerCaller): Promise<Granted | Answered>;
  /**
   * Claims a gateway proof that no quota decision spent. Returns `response`, or the 403 replay or
   * 503 unknown-outcome answer that replaces it.
   */
  claimUnspentProof(response: Response, gateway?: GatewayContext): Promise<Response>;
  /** Partner reads need recognition and its capacity; without them they are unavailable. */
  recognizesPartners: boolean;
  /**
   * The operator login route's quota: `admin_login_ip` and `admin_login_global` in one EVAL. It
   * refuses any other bucket.
   */
  operatorLoginQuota: RateLimitPort;
}>;
