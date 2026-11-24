import { safeRouteHandler } from "@blast/core/lib/http-errors.ts";
import { publicErrorResponse } from "@blast/core/lib/http-errors.ts";
import { randomUUID } from "node:crypto";

import { errorLabel, recordMetric } from "@blast/core/lib/metrics.ts";
import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";

import { LaunchpadTelemetryRejection, parseCoinViewEvent } from "@blast/core/modules/launchpad-telemetry/contracts.ts";
import type { LaunchpadTelemetryEmitter } from "@blast/server/modules/launchpad-telemetry/emitter.ts";
import {
  LAUNCHPAD_TELEMETRY_BODY_DEADLINE_MS,
  LAUNCHPAD_TELEMETRY_BODY_LIMIT,
  boundedText,
  sameOrigin,
  visitorCookie,
  visitorIdFromRequest,
} from "@blast/server/modules/launchpad-telemetry/http.ts";

// Public API of the coin-view route, shared with the outcomes route (`http.ts`).
export {
  LAUNCHPAD_TELEMETRY_BODY_DEADLINE_MS,
  LAUNCHPAD_TELEMETRY_BODY_LIMIT,
  VISITOR_COOKIE_NAME,
  visitorIdFromRequest,
} from "@blast/server/modules/launchpad-telemetry/http.ts";

/**
 * Whether the coin is tradable now, as the coin page decides it from chain
 * identity and the fresh launch object: `unavailable` when that cannot be
 * known now.
 */
export type TradableCheck = (launchId: string) => Promise<"tradable" | "not-tradable" | "unavailable">;

export interface LaunchpadTelemetryRouteDependencies {
  emitter: LaunchpadTelemetryEmitter;
  /** Checked after the rate bucket and before a visitor is minted or a view recorded. */
  verifyTradable: TradableCheck;
  /** The site's canonical origin; a request with another `Origin` is refused. */
  expectedOrigin: string;
  createVisitorId?: () => string;
  bodyDeadlineMs?: number;
}

function respond(status: number, mintedVisitor?: string): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (mintedVisitor) {
    headers.set("Set-Cookie", visitorCookie(mintedVisitor));
  }
  if (status >= 400) {
    const codes: Readonly<Record<number, string>> = { 503: "LAUNCHPAD_TELEMETRY_UNAVAILABLE", 429: "RATE_LIMITED", 403: "ORIGIN_INVALID", 413: "PAYLOAD_TOO_LARGE", 408: "REQUEST_TIMEOUT" };
    const code = codes[status] ?? "LAUNCHPAD_TELEMETRY_INVALID";
    return publicErrorResponse(code, status === 503 ? "Telemetry is temporarily unavailable." : "The telemetry request could not be accepted.", status, { headers });
  }
  return new Response(null, { status, headers });
}

async function readView(
  request: Request,
  expectedOrigin: string,
  deadlineMs: number,
): Promise<{ view: ReturnType<typeof parseCoinViewEvent> } | { refused: Response }> {
  if (!sameOrigin(request, expectedOrigin)) return { refused: respond(403) };
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > LAUNCHPAD_TELEMETRY_BODY_LIMIT) return { refused: respond(413) };
  const read = await boundedText(request, LAUNCHPAD_TELEMETRY_BODY_LIMIT, deadlineMs);
  if ("refused" in read) return { refused: respond(read.refused) };
  let view;
  try {
    view = parseCoinViewEvent(JSON.parse(read.text));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof LaunchpadTelemetryRejection) {
      return { refused: respond(400) };
    }
    throw error;
  }

  return { view };
}

/**
 * `POST /api/launchpad/telemetry`: the browser reports a first view of a
 * tradable coin. Only coin views are accepted here; outcomes are recorded by
 * the server flows that verified them. In order:
 *
 * 1. Another site, a sibling subdomain or a foreign `Origin`: 403.
 * 2. The body is bounded in size (413) and time (408), parsed exactly and
 *    never echoed (400). Nothing so far touches the database.
 * 3. The client IP's rate bucket (`launchpad_telemetry`): 429 when full,
 *    503 when the limiter cannot answer. Nothing is minted or recorded.
 * 4. The coin must be a Blast launch the page shows as tradable now: 400
 *    when it is not (unknown, foreign, opening round, migration-ready, no
 *    venue), 503 when that cannot be verified. Nothing is minted or recorded.
 * 5. The visitor is the first-party opaque cookie, minted on first use, and
 *    the view is recorded: 204 stored (or already counted), 503 when storage
 *    is unavailable or telemetry stepped aside for the product.
 *
 * The browser adapter ignores every answer.
 */
export function createLaunchpadTelemetryRouteHandler(
  dependencies: LaunchpadTelemetryRouteDependencies,
): (request: Request, client: ClientAddress) => Promise<Response> {
  const createVisitorId = dependencies.createVisitorId ?? randomUUID;
  const deadlineMs = dependencies.bodyDeadlineMs ?? LAUNCHPAD_TELEMETRY_BODY_DEADLINE_MS;
  return safeRouteHandler(async (request: Request, client: ClientAddress) => {
    const read = await readView(request, dependencies.expectedOrigin, deadlineMs);
    if ("refused" in read) return read.refused;
    const { view } = read;

    const admission = await dependencies.emitter.admitCoinView(client.rateKey);
    if (admission === "limited") return respond(429);
    if (admission === "dropped") return respond(503);

    let tradable: Awaited<ReturnType<TradableCheck>>;
    try {
      tradable = await dependencies.verifyTradable(view.launchId);
    } catch (error) {
      recordMetric("launchpad.telemetry", { event: "coin_view", result: "dropped", reason: errorLabel(error) });
      return respond(503);
    }
    if (tradable !== "tradable") {
      const result = tradable === "unavailable" ? "dropped" : "rejected";
      recordMetric("launchpad.telemetry", { event: "coin_view", result, reason: tradable });
      return respond(tradable === "unavailable" ? 503 : 400);
    }

    const existing = visitorIdFromRequest(request);
    const visitor = existing ?? createVisitorId();
    const minted = existing ? undefined : visitor;
    const result = await dependencies.emitter.recordCoinView(visitor, view);
    if (result === "rejected") return respond(400, minted);
    if (result === "dropped") return respond(503, minted);
    return respond(204, minted);
  });
}
