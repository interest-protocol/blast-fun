import { BLAST_DEPLOYMENTS, deploymentFingerprint } from "@interest-protocol/blast-sdk/deployments";

import type { SigningChainConfig } from "@blast/core/modules/launchpad-coin/signing-chain.ts";

import type { WebConfig } from "#web/lib/web-config.ts";

export type TradeUnavailable = Readonly<{ status: "unavailable"; reason: string }>;
export type TradeAvailability = TradeUnavailable | Readonly<{ status: "available"; config: SigningChainConfig }>;

/** What a surface outside the coin page needs to mount the curve rail: the request's availability and the shell's Privy app and CSP nonce. */
export type CurveTradeSetup = Readonly<{
  availability: TradeAvailability;
  connection: Readonly<{ privyAppId: string | null; nonce: string }>;
}>;

/** Visibility is request-scoped; every trade still verifies the actual deployment on chain before signing. */
export function serverTradeAvailability(
  config: Pick<WebConfig, "expectedDeployment" | "signingChain">,
  tradingAllowed = false,
): TradeAvailability {
  const expected = config.expectedDeployment;
  const released = expected ? BLAST_DEPLOYMENTS[expected.network] : undefined;
  if (!expected || !released || deploymentFingerprint(released) !== expected.deployment) {
    return { status: "unavailable", reason: "Trading opens once this app serves a released Blast deployment. Nothing can be signed here yet." };
  }
  if (!tradingAllowed) return { status: "unavailable", reason: "Trading is not enabled for this session." };
  const chain = config.signingChain;
  return chain ? { status: "available", config: chain } : { status: "unavailable", reason: "Trading is unavailable on this network." };
}

/** Opening-round execution remains deferred independently of spot trading. */
export function serverOpeningAvailability(activity: string): TradeUnavailable {
  return { status: "unavailable", reason: `${activity} is not enabled here yet.` };
}
