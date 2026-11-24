// Run parameters and scaling for the social k6 scenarios.
import http from "k6/http";

function number(name, fallback) {
  const raw = __ENV[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function loopbackUrl(value, name) {
  const match = /^http:\/\/(127\.0\.0\.1|localhost):(\d{2,5})$/.exec(value);
  if (!match) throw new Error(`${name} must be http://127.0.0.1:<port> (got ${value})`);
  return value;
}

const baseUrls = (__ENV.BASE_URLS || "http://127.0.0.1:3917")
  .split(",")
  .map((value) => loopbackUrl(value.trim(), "BASE_URLS"));

export const ENV = Object.freeze({
  scale: number("SCALE", 1),
  durationScale: number("DURATION_SCALE", 1),
  baseUrls,
  ipSalt: number("IP_SALT", 0),
});

/** Scales a user/arrival count by SCALE (never below `minimum`). */
export function scaled(value, minimum = 1) {
  return Math.max(minimum, Math.round(value * ENV.scale));
}

/** Scales a duration in seconds by DURATION_SCALE. */
export function seconds(value, minimum = 1) {
  return Math.max(minimum, Math.round(value * ENV.durationScale));
}

export const duration = (value) => `${seconds(value)}s`;

/** Spreads synthetic browsers across app instances (APP_INSTANCES > 1). */
export function baseFor(n) {
  return ENV.baseUrls[Math.abs(n) % ENV.baseUrls.length];
}

export const TREND_STATS = ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)", "count"];

export function baseOptions(extra) {
  return {
    discardResponseBodies: false,
    summaryTrendStats: TREND_STATS,
    setupTimeout: "120s",
    teardownTimeout: "120s",
    ...extra,
  };
}

export { number as envNumber };

const gatePrimed = new Set();

/**
 * Loads one page per VU, as a browser does before it calls the API, so the
 * VU's cookie jar holds the API gate cookie (docs/security/bot-protection.md)
 * and every later `/api/*` request carries it. Cookies are per host, not per
 * port, so one page covers every app instance. Not counted in any step.
 */
export function primeGate(base) {
  if (gatePrimed.has(base)) return;
  const response = http.get(`${base}/privacy`, {
    headers: { Accept: "text/html", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none" },
    tags: { step: "gate", name: "GET page (gate cookie)" },
    responseType: "none",
  });
  if (response.status === 200) gatePrimed.add(base);
}
