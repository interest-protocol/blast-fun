import { publicJson } from "@blast/core/lib/http-errors.ts";
// Development only: lands a dev page's completed fixture transaction on the
// dev server's fixture node (LAUNCHPAD_FIXTURE_CHAIN_ORIGIN), so the outcomes
// route can verify it. The browser posts same-origin to this server, which
// forwards the transaction; the page's CSP never needs the fixture origin.
// Served at `/dev/launchpad/launch/fixture-transactions`, which answers 404
// in production without loading this module.

import { sameOrigin } from "@blast/server/modules/launchpad-telemetry/http.ts";
import { outcomeTransactionFromWire, outcomeTransactionWire } from "../../../../../../packages/core/test/fixtures/modules/launchpad-telemetry/outcome-fixtures.ts";

/** A fixture transaction is a few hundred bytes; this bounds a dev request. */
const LANDING_BODY_LIMIT = 64 * 1_024;
const LANDING_TIMEOUT_MS = 2_000;

function respond(status: number, body: Readonly<Record<string, string>>): Response {
  return publicJson(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * `POST` a fixture transaction (`outcomeTransactionWire`): 200 `landed`;
 * 403 `origin`; 400 `malformed`; 413 `too-large`; 503 `no-fixture-node`
 * when no fixture node is configured; 502 `fixture-node-unavailable` when it
 * does not take the transaction.
 */
export function createFixtureLandingHandler({
  fixtureOrigin,
  expectedOrigin,
  fetch: fetcher = fetch,
}: Readonly<{ fixtureOrigin: string | null; expectedOrigin: string; fetch?: typeof fetch }>): (request: Request) => Promise<Response> {
  return async (request) => {
    if (!sameOrigin(request, expectedOrigin)) return respond(403, { reason: "origin" });
    const text = await request.text();
    if (text.length > LANDING_BODY_LIMIT) return respond(413, { reason: "too-large" });
    let wire: Record<string, unknown>;
    try {
      wire = outcomeTransactionWire(outcomeTransactionFromWire(JSON.parse(text) as Record<string, unknown>));
    } catch {
      return respond(400, { reason: "malformed" });
    }
    if (!fixtureOrigin) return respond(503, { reason: "no-fixture-node" });
    try {
      const response = await fetcher(new URL("/__fixture/transactions", fixtureOrigin), {
        method: "POST",
        body: JSON.stringify(wire),
        signal: AbortSignal.timeout(LANDING_TIMEOUT_MS),
      });
      if (!response.ok) return respond(502, { reason: "fixture-node-unavailable" });
    } catch {
      return respond(502, { reason: "fixture-node-unavailable" });
    }
    return respond(200, { result: "landed" });
  };
}
