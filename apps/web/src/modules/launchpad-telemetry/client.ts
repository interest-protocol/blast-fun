/**
 * Browser adapter for launchpad telemetry. Safe to import from client
 * components: no Node or database imports. Reporting is fire-and-forget: it
 * returns nothing, never throws, never awaits, and its request cannot change
 * what the page shows or does.
 */

import { parseLaunchId } from "@blast/core/lib/launchpad/launch-id.ts";
import { COIN_VIEW_EVENT, parseOutcomeReport, type CoinViewEvent, type OutcomeReport } from "@blast/core/modules/launchpad-telemetry/contracts.ts";

export const LAUNCHPAD_TELEMETRY_PATH = "/api/launchpad/telemetry";
export const LAUNCHPAD_OUTCOMES_PATH = "/api/launchpad/outcomes";
export const LAUNCHPAD_OUTCOME_COMMITMENTS_PATH = "/api/launchpad/outcomes/commitments";

export interface TelemetryTransport {
  sendBeacon?: (url: string, body: string) => boolean;
  fetch?: (url: string, init: RequestInit) => Promise<unknown>;
}

export interface CoinViewReporter {
  /** Reports a view of a coin the page has shown as tradable, once per page. */
  report(launchId: string): void;
}

export function createCoinViewReporter(transport: TelemetryTransport): CoinViewReporter {
  const reported = new Set<string>();
  return {
    report(launchId) {
      try {
        // Only a canonical launch ID is ever sent.
        if (parseLaunchId(launchId) === null || reported.has(launchId)) return;
        reported.add(launchId);
        // The visitor is the HttpOnly first-party cookie; the body names only the coin.
        const view: CoinViewEvent = { event: COIN_VIEW_EVENT, launchId, surface: "coin-page" };
        const body = JSON.stringify(view);
        if (transport.sendBeacon?.(LAUNCHPAD_TELEMETRY_PATH, body)) return;
        transport
          .fetch?.(LAUNCHPAD_TELEMETRY_PATH, {
            method: "POST",
            body,
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            keepalive: true,
          })
          ?.catch(() => undefined);
      } catch {
        // Telemetry is optional; the page carries on.
      }
    },
  };
}

let browserReporter: CoinViewReporter | undefined;

/**
 * Reports the first view of a tradable coin from the browser. Call it after
 * the page has rendered the coin as tradable (in an effect), never while
 * rendering, and never for a coin that is not tradable.
 */
export function reportCoinView(launchId: string): void {
  try {
    if (typeof window === "undefined") return;
    browserReporter ??= createCoinViewReporter({
      sendBeacon: typeof navigator.sendBeacon === "function"
        ? (url, body) => navigator.sendBeacon(url, body)
        : undefined,
      fetch: typeof fetch === "function" ? (url, init) => fetch(url, init) : undefined,
    });
    browserReporter.report(launchId);
  } catch {
    // Telemetry is optional; the page carries on.
  }
}

/**
 * A completed launch or curve Buy to report. `privyToken` is the reporter's
 * Privy access token when it signed with its Privy embedded wallet: the
 * server links this browser's visitor to the outcome only if that session's
 * wallet is the event's sender. It is sent only as the request's
 * `Authorization: Bearer` header, same-origin.
 */
export type VerifiedOutcomeReport = OutcomeReport & Readonly<{ privyToken?: string }>;

export interface VerifiedOutcomeReporter {
  /** Reports a completed launch or curve Buy for server verification, once per page. */
  report(outcome: VerifiedOutcomeReport): void;
}

// The access-token form the outcomes route accepts (RFC 6750 `b64token`, bounded).
const PRIVY_TOKEN = /^[A-Za-z0-9._~+/=-]{1,8192}$/;

/** The report's exact `{ kind, launchId, txDigest }`; throws on anything else. */
function exactReport({ kind, launchId, txDigest }: OutcomeReport): OutcomeReport {
  return parseOutcomeReport({ kind, launchId, txDigest });
}

/**
 * How long after a 503 (retry-later) answer the one retry waits: uniformly
 * between `min` and `max` ms, so reports refused together do not return
 * together.
 */
export const OUTCOME_RETRY_DELAY_MS = Object.freeze({ min: 3_000, max: 8_000 });

export interface OutcomeRetryOptions {
  random?: () => number;
  setTimer?: (run: () => void, ms: number) => void;
}

function status(response: unknown): number | null {
  const value = (response as { status?: unknown } | null)?.status;
  return typeof value === "number" ? value : null;
}

/**
 * Sends `{ kind, launchId, txDigest }` to `POST /api/launchpad/outcomes`
 * with `fetch` (JSON, same-origin credentials so the visitor cookie goes
 * along, `keepalive` so a navigation does not cancel it), with a valid
 * `privyToken` as its Bearer header. An invalid report is never sent, and
 * each completed event is sent once per page. A 503 (the node, limiter or
 * storage cannot answer now) is retried once after a jittered delay; no other
 * answer is retried, and the server keeps one outcome per event either way.
 */
export function createVerifiedOutcomeReporter(
  transport: Pick<TelemetryTransport, "fetch">,
  options: OutcomeRetryOptions = {},
): VerifiedOutcomeReporter {
  const random = options.random ?? Math.random;
  const setTimer = options.setTimer ?? ((run: () => void, ms: number) => void setTimeout(run, ms));
  const reported = new Set<string>();
  return {
    report(outcome) {
      try {
        const { kind, launchId, txDigest } = exactReport(outcome);
        const key = `${kind}:${launchId}:${txDigest}`;
        if (reported.has(key)) return;
        reported.add(key);
        const body = JSON.stringify({ kind, launchId, txDigest });
        const token = typeof outcome.privyToken === "string" && PRIVY_TOKEN.test(outcome.privyToken) ? outcome.privyToken : null;
        const headers: Record<string, string> = { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
        const send = () =>
          transport.fetch?.(LAUNCHPAD_OUTCOMES_PATH, { method: "POST", body, credentials: "same-origin", headers, keepalive: true });
        send()
          ?.then((response) => {
            if (status(response) !== 503) return;
            const { min, max } = OUTCOME_RETRY_DELAY_MS;
            setTimer(() => {
              try {
                send()?.catch(() => undefined);
              } catch {
                // Telemetry is optional.
              }
            }, Math.round(min + random() * (max - min)));
          })
          .catch(() => undefined);
      } catch {
        // Telemetry is optional; the launch or trade carries on.
      }
    },
  };
}

let outcomeReporter: VerifiedOutcomeReporter | undefined;

/**
 * Reports a completed launch or curve Buy from the browser, fire-and-forget:
 * it returns nothing, never throws and never waits, so it cannot delay or
 * change the action. Call it only after the chain shows the completed event
 * (the launch engine's `completed`, a confirmed Buy); the server verifies it
 * again and records it at most once.
 */
export function reportVerifiedOutcome(outcome: VerifiedOutcomeReport): void {
  try {
    if (typeof window === "undefined") return;
    outcomeReporter ??= createVerifiedOutcomeReporter({
      fetch: typeof fetch === "function" ? (url, init) => fetch(url, init) : undefined,
    });
    outcomeReporter.report(outcome);
  } catch {
    // Telemetry is optional; the action carries on.
  }
}

export interface OutcomeCommitter {
  /** Commits a signed launch's or Buy's digest as this browser's own, once per page. */
  commit(outcome: OutcomeReport): void;
}

/**
 * Sends `{ kind, launchId, txDigest }` to `POST /api/launchpad/outcomes/commitments`
 * with `fetch` (JSON, same-origin credentials so the visitor cookie goes
 * along, `keepalive`). An invalid commitment is never sent and each digest is
 * sent once per page. It is never retried: a commitment counts only if the
 * server receives it before the transaction's checkpoint.
 */
export function createOutcomeCommitter(transport: Pick<TelemetryTransport, "fetch">): OutcomeCommitter {
  const committed = new Set<string>();
  return {
    commit(outcome) {
      try {
        const { kind, launchId, txDigest } = exactReport(outcome);
        const key = `${kind}:${launchId}:${txDigest}`;
        if (committed.has(key)) return;
        committed.add(key);
        transport
          .fetch?.(LAUNCHPAD_OUTCOME_COMMITMENTS_PATH, {
            method: "POST",
            body: JSON.stringify({ kind, launchId, txDigest }),
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            keepalive: true,
          })
          ?.catch(() => undefined);
      } catch {
        // Telemetry is optional; the signature and submission carry on.
      }
    },
  };
}

let outcomeCommitter: OutcomeCommitter | undefined;

/**
 * Commits a signed launch's or curve Buy's digest as this browser visitor's
 * own, fire-and-forget: call it after the wallet signed and just before the
 * transaction is submitted, and never await it. It returns nothing, never
 * throws and never waits, so it cannot delay or change the signature or the
 * submission. The server later links this visitor to the verified outcome if
 * no other visitor committed the same digest before its checkpoint.
 */
export function commitSignedOutcome(outcome: OutcomeReport): void {
  try {
    if (typeof window === "undefined") return;
    outcomeCommitter ??= createOutcomeCommitter({
      fetch: typeof fetch === "function" ? (url, init) => fetch(url, init) : undefined,
    });
    outcomeCommitter.commit(outcome);
  } catch {
    // Telemetry is optional; the action carries on.
  }
}
