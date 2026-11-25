// Loaded by the Vercel build gate under plain Node (scripts/partner-api-live/runtime.mjs):
// no `server-only`, no `@/` or `#web/` alias, erasable TypeScript only across the import closure.
import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import { optionalSecret, requiredSecret } from "@blast/core/lib/config/secret.ts";
import { gateKeys, rotatingGateKeys, type GateKeys } from "@blast/core/lib/web-security/gate-cookie.ts";
import { configuredSigningChain, type SigningChainConfig } from "@blast/core/modules/launchpad-coin/signing-chain.ts";
import { expectedDeployment, type ExpectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import type { PresaleDeploymentState } from "@blast/core/modules/presale/deployment/contracts.ts";
import { readPresaleDeploymentIdentity } from "@blast/core/modules/presale/deployment/service.ts";
import { concurrencyFromEnvironment } from "@blast/server/lib/concurrency.ts";
import { parseRelayConfig, type RelayConfig } from "@blast/server/private/relay-config.ts";

import { readPresaleConfig, type PresaleConfig } from "../components/presale/config.ts";
import { boostsLinkUrl } from "./launchpad/boosts-link.ts";

type Environment = Readonly<Record<string, string | undefined>>;

/** What the API gate (`web-security/api-gate.ts`) checks requests against. */
export type GateConfig = Readonly<{
  /** `BLAST_GATE_SECRET` (and `BLAST_GATE_SECRET_PREVIOUS`); a per-process key on local runs; null otherwise. */
  keys: GateKeys | null;
  /** `CRON_SECRET`: Vercel Cron's bearer, which skips the gate on maintenance routes. */
  cronSecret: string | null;
}>;

/**
 * The web process's server settings, parsed once (`server-config.ts`
 * `webConfig()`). Production requires the relay values, `BLAST_GATE_SECRET`
 * and `NEXT_PUBLIC_SITE_URL`; everything else is optional and turns its
 * feature off when unset. A set value that does not parse always fails, and
 * the error names only the variable. Exception: the presale settings keep
 * their per-setting "unavailable" state (`readPresaleConfig`).
 * Flags (`launch-flags`, `social-flag`, `experience`, `metrics`)
 * stay live environment reads.
 */
export type WebConfig = Readonly<{
  relay: RelayConfig;
  gate: GateConfig;
  coinShareImageConcurrency: number;
  /** `PRIVY_APP_ID`, trimmed; null turns Privy sign-in off. */
  privyAppId: string | null;
  /** `BLAST_BOOSTS_URL`: a public HTTPS link, or null for no link. */
  boostsUrl: string | null;
  /** `BLAST_NETWORK` with `BLAST_DEPLOYMENT_FINGERPRINT`: both or neither. */
  expectedDeployment: ExpectedDeployment | null;
  /** The released deployment on `BLAST_NETWORK` browsers sign against, or null. */
  signingChain: SigningChainConfig | null;
  presaleDeployment: PresaleDeploymentState;
  presale: PresaleConfig;
  /** `NODE_ENV` is development: the CSP allows the dev server's eval and websocket. */
  development: boolean;
  /** The direct market socket, or null when it is off and tabs have no live stream. */
  liveSocket: LiveSocketConfig | null;
}>;

/**
 * `BLAST_LIVE_SOCKET_URL`: the hints process's `wss://…/v1/socket`. Unset is
 * the kill switch: no tab streams. Tickets are signed with the hints gateway
 * secret, so the socket needs the hints upstream.
 */
export type LiveSocketConfig = Readonly<{ url: string; origin: string }>;

export function parseWebConfig(environment: Environment): WebConfig {
  const relay = parseRelayConfig(environment);
  const { production } = deploymentIdentity(environment);

  return {
    relay,
    gate: gateConfig(environment, production),
    coinShareImageConcurrency: concurrencyFromEnvironment(environment, "BLAST_COIN_SHARE_IMAGE_CONCURRENCY", 2, 8),
    privyAppId: environment.PRIVY_APP_ID?.trim() || null,
    boostsUrl: boostsLinkUrl(environment.BLAST_BOOSTS_URL),
    expectedDeployment: expectedDeployment(environment),
    signingChain: configuredSigningChain(environment),
    presaleDeployment: readPresaleDeploymentIdentity(environment),
    presale: readPresaleConfig(environment),
    development: environment.NODE_ENV === "development",
    liveSocket: liveSocketConfig(environment, relay),
  };
}

function liveSocketConfig(environment: Environment, relay: RelayConfig): LiveSocketConfig | null {
  const raw = environment.BLAST_LIVE_SOCKET_URL?.trim();
  if (!raw) return null;
  const url = URL.canParse(raw) ? new URL(raw) : null;
  const local = url?.protocol === "ws:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (!url || (url.protocol !== "wss:" && !local) || url.pathname !== "/v1/socket" || url.search || url.hash || url.username || url.password) {
    throw new Error("BLAST_LIVE_SOCKET_URL must be a wss:// URL ending in /v1/socket.");
  }
  if (relay.hints === null) throw new Error("BLAST_LIVE_SOCKET_URL needs BLAST_BACKEND_HINTS_ORIGIN and its gateway secret.");
  return { url: url.href, origin: url.origin };
}

function gateConfig(environment: Environment, production: boolean): GateConfig {
  const current = production
    ? requiredSecret(environment, "BLAST_GATE_SECRET")
    : optionalSecret(environment, "BLAST_GATE_SECRET");
  const previous = optionalSecret(environment, "BLAST_GATE_SECRET_PREVIOUS");

  return {
    // Without a secret, local runs get a per-process key and hosted builds refuse gated requests.
    keys: current === null ? gateKeys(environment) : rotatingGateKeys(current, previous),
    cronSecret: optionalSecret(environment, "CRON_SECRET"),
  };
}
