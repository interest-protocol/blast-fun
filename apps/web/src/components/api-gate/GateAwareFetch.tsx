"use client";

import { installGateAwareFetch } from "#web/lib/api-gate-client.ts";

// Runs when this module loads in the browser, before any component's effect
// can fetch: every same-origin /api call then gets the gate's credentials rule
// and its one retry after a `gate_required` 401 (docs/security/bot-protection.md).
if (typeof window !== "undefined") installGateAwareFetch();

/** Renders nothing; the root layout includes it so its module loads on every page. */
export function GateAwareFetch(): null {
  return null;
}
