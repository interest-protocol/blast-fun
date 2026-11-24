import type { PrivyOnboardingProof } from "../../../../../../packages/core/src/lib/privy-adapter/types.ts";
import type { RateLimitSubject } from "../../../../../../packages/core/src/lib/web-security/rate-limits.ts";

export const SECURITY_FIXTURES = Object.freeze({
  admission: { ip: "203.0.113.10", admissionId: "admission-fixture" },
  callsign: { attemptId: "attempt-fixture" },
  completion: { attemptId: "attempt-fixture" },
  recovery: {
    ip: "203.0.113.11",
    address: `0x${"1".repeat(64)}`,
  },
  session: { sessionId: "session-fixture" },
  telemetry: { admissionId: "admission-fixture" },
  wallet: {
    ip: "203.0.113.10",
    address: `0x${"2".repeat(64)}`,
  },
} as const satisfies Record<string, RateLimitSubject>);

export const SYNTHETIC_NORMALIZED_OAUTH_PROOF: PrivyOnboardingProof = {
  identity: {
    authProvider: "privy",
    avatarReference: "https://images.example.test/pilot.png",
    callsignSuggestion: "NOVA_7",
    displayNameSuggestion: "Nova Seven",
    handle: "nova7",
    privyDid: "did:privy:oauth-fixture",
    proofReference: "privy-session-fixture",
    socialProvider: "x",
    verifiedAtEpochSeconds: 1_790_000_000,
    xSubject: "x-subject-fixture",
  },
  wallet: {
    address: `0x${"2".repeat(64)}`,
    chain: "sui",
    created: false,
    custodyProvider: "privy",
    privyDid: "did:privy:oauth-fixture",
    providerWalletReference: "wallet-fixture",
  },
};
