import type { RedisCommands } from "@blast/core/lib/redis.ts";
import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import type { IngressTrust } from "@blast/core/lib/web-security/ingress.ts";
import type { GatewayContext } from "@blast/core/modules/backend-api/gateway.ts";
import { PRIVATE_ROUTES } from "@blast/core/modules/backend-api/private-routes.ts";
import type { CronApi } from "./cron.ts";
import type { PrivateApi } from "./private.ts";

/** A web deployment the backend trusts: the origin its relay signs, and its own quota namespace. */
export type TrustedSite = Readonly<{ siteOrigin: string; namespace: string }>;

export const TRANSPORT_LIMITS = Object.freeze({
  headerBytes: 16 * 1024,
  adminBodyBytes: 8 * 1024,
  privateBodyBytes: Math.max(0, ...PRIVATE_ROUTES.map((route) => route.maxBodyBytes)),
  privateDeadlineMs: 30_000,
  deadlineMs: 4_000,
});

/** The transport retains release through actual handler and streamed-body cleanup. */
export type PartnerPreparation = Readonly<
  | { response: Response; handle?: never; release?: never }
  | { response?: never; handle: () => Promise<Response>; release: () => void }
>;

export type BackendHttpOptions = Readonly<{
  handle: (
    request: Request,
    client: ClientAddress,
    gatewayAuthenticated: boolean,
    gateway?: GatewayContext,
  ) => Promise<Response>;
  redis: RedisCommands;
  privateReplayRedis?: RedisCommands;
  namespace: string;
  /** Other trusted sites; their gateway proofs are accepted for first-party reads only. */
  extraSites?: readonly TrustedSite[];
  gatewaySecret: string;
  /** `PRESALE_ADMIN_TOKEN`: the bearer every `operator` route requires before admission. */
  adminToken?: string;
  /** `CRON_SECRET`: the bearer every cron route requires before admission. */
  cronSecret?: string;
  maxInflight?: number;
  maxAdminInflight?: number;
  maxPrivateWorkMs?: number;
  ingress?: IngressTrust;
  ready: () => Promise<boolean>;
  privateApi?: PrivateApi;
  cronApi?: CronApi;
  preparePartner?: (
    request: Request,
    client: ClientAddress,
    gateway?: GatewayContext,
  ) => Promise<PartnerPreparation | null>;
  partnerReservedInflight?: number;
}>;

export type TransportContext = {
  peerAddress: string | null;
  pendingRequests: number;
  authenticatedWork?: (contract: Readonly<{ workBudgetMs?: number }>) => void;
};
