/**
 * The first-party API gate's wire protocol, shared by the proxy, the
 * `/api/gate` route and the browser's fetch wrapper. No Node or browser API
 * here, so every side can import it (see docs/security/bot-protection.md).
 */

/** The gate cookie over HTTPS (`__Host-`: Secure, Path=/, no Domain). */
export const GATE_COOKIE_NAME = "__Host-blast_gate";
/** The gate cookie over plain HTTP (local `next dev`), where `__Host-` and Secure cannot be set. */
export const GATE_COOKIE_NAME_INSECURE = "blast_gate";
/** A gate cookie is valid this long after it is issued. */
export const GATE_LIFETIME_SECONDS = 2 * 60 * 60;
/** A page load re-issues a valid gate cookie once it is older than this. */
export const GATE_REFRESH_AFTER_SECONDS = 30 * 60;
/** Same-origin GET that re-issues the gate cookie (allowlisted, rate limited). */
export const GATE_REFRESH_PATH = "/api/gate";
/** Marks a gate refusal (401): `X-Blast-Gate: required`, so a client need not parse the body. */
export const GATE_REFUSAL_HEADER = "x-blast-gate";
export const GATE_REFUSAL_VALUE = "required";
/** The refusal's body: `{"error":"gate_required"}`. */
export const GATE_REQUIRED_ERROR = "gate_required";

/** Whether `response` is the gate's refusal (as opposed to a route's own 401). */
export function isGateRefusal(response: Response): boolean {
  return response.status === 401 && response.headers.get(GATE_REFUSAL_HEADER) === GATE_REFUSAL_VALUE;
}
