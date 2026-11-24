// Curve Buy outcomes: the server-verified conversion (docs/launchpad/telemetry.md).
// A Buy's signed digest is committed as this browser's own just before it is
// submitted, and each completed `Bought` is reported once to the verified-outcome
// route, which verifies it on the node and records it for the event's sender.
// The browser never asserts who bought; neither call ever blocks, delays, or
// changes a trade.

import type { VerifiedOutcomeReport } from "#web/modules/launchpad-telemetry/client.ts";
import type { OutcomeReport } from "@blast/core/modules/launchpad-telemetry/contracts.ts";
import type { SignerSummary } from "../transaction/action-machine.ts";
import type { LaunchpadSigner } from "../transaction/signer.ts";
import type { CurveTradeInput } from "./curve-adapter.ts";

/**
 * The buy controller's `onSigned`: commits the signed Buy's digest and launch
 * (`POST /api/launchpad/outcomes/commitments`). The controller neither waits
 * for it nor lets it throw, so a failed or slow commitment never reaches the
 * signature or the submission.
 */
export function commitSignedBuy(
  commit: (outcome: OutcomeReport) => void,
): (signed: Readonly<{ digest: string; input: CurveTradeInput }>) => void {
  return ({ digest, input }) => commit({ kind: "buy", launchId: input.launchId, txDigest: digest });
}

/**
 * How long a completed Buy's report waits for a Privy signer's access token
 * (a session refresh may go to Privy); past it the report goes without the
 * token, so the outcome is still recorded for its sender.
 */
export const BUY_PRIVY_TOKEN_TIMEOUT_MS = 2_000;

/**
 * Reports one completed Buy to the verified-outcome route
 * (`POST /api/launchpad/outcomes`), fire-and-forget: it never throws or
 * waits, so it cannot change the trade. `accessToken` is the Privy session of
 * the Privy wallet that signed it, if one did: its token goes with the report
 * (the server links this browser's visitor only if that session's wallet is
 * the sender) when it is read within `privyTokenTimeoutMs`; a read that fails,
 * answers none, or stalls never holds the report back.
 */
export function reportCompletedBuy({
  outcome,
  accessToken,
  report,
  privyTokenTimeoutMs = BUY_PRIVY_TOKEN_TIMEOUT_MS,
}: Readonly<{
  outcome: OutcomeReport & Readonly<{ kind: "buy" }>;
  accessToken?: () => Promise<string | null>;
  report: (outcome: VerifiedOutcomeReport) => void;
  privyTokenTimeoutMs?: number;
}>): void {
  const send = (privyToken: string | null) => {
    try {
      report(privyToken ? { ...outcome, privyToken } : outcome);
    } catch {
      // Outcome reporting is optional; the trade is complete either way.
    }
  };
  if (!accessToken) return send(null);
  let sent = false;
  const once = (privyToken: string | null) => {
    if (sent) return;
    sent = true;
    clearTimeout(deadline);
    send(privyToken);
  };
  const deadline = setTimeout(() => once(null), privyTokenTimeoutMs);
  Promise.resolve()
    .then(accessToken)
    .then(once, () => once(null));
}

/**
 * The Privy session of the wallet that signed (`signed`, the review's
 * signer), read from the signer connected now: only a Privy signer has one,
 * and only while that same Privy wallet is connected.
 */
export function signingPrivySession(
  signed: SignerSummary,
  current: LaunchpadSigner | null,
): (() => Promise<string | null>) | undefined {
  if (signed.kind !== "privy" || current?.kind !== "privy" || current.address !== signed.address) return undefined;
  return current.accessToken;
}
