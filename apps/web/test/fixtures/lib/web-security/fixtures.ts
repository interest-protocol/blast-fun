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

