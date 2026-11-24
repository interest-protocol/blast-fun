import type { PresaleRateBucket } from "@blast/core/lib/web-security/rate-limits.ts";
import type { PresaleRoute } from "../contracts/routes.ts";

/**
 * Who called: a Privy account by DID, an agent API key (by its identifier,
 * never the key), or an outside Sui wallet's sign-in session (Slush and the
 * other wallets) by its address.
 */
export type PresalePrincipal =
  | Readonly<{ kind: "account"; did: string }>
  | Readonly<{ kind: "api_key"; keyId: string; did: string | null }>
  | Readonly<{ kind: "wallet"; address: string; did: null }>;

/**
 * - `none`: the Authorization header is not read;
 * - `optional`: a valid Privy token gives the account, anything else is anonymous (CL-22);
 * - `account`: a valid Privy token is required (`unauthorized` otherwise);
 * - `account_or_api_key`: a valid Privy token, or a valid agent API key in
 *   `X-Blast-Api-Key`, is required;
 * - `account_or_wallet`: a valid Privy token, or else a live outside-wallet
 *   session cookie on a same-origin request, is required.
 */
export type PresaleAuthMode = "none" | "optional" | "account" | "account_or_api_key" | "account_or_wallet";

export type PresaleRouteSpec = Readonly<{
  /** The published route (contracts `PRESALE_ROUTES`): its error list bounds what the route answers. */
  name: PresaleRoute;
  auth: PresaleAuthMode;
  /**
   * The bucket (or buckets, counted in order; the first full one refuses)
   * every request counts in, before the deployment check and the handler.
   */
  bucket?: PresaleRateBucket | readonly PresaleRateBucket[];
  /** `verified`: the deployment identity, checked against the node, before the handler. */
  deployment?: "none" | "verified";
}>;

/** Resolves an agent API key (the `X-Blast-Api-Key` value) to its identifier, or null when it is not an active key. */
export type AgentApiKeyVerifier = (token: string) => Promise<Readonly<{ keyId: string; did: string | null }> | null>;
