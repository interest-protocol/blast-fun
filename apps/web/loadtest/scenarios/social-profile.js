// Social-feed UI-06: the public profile reads, the hot reads behind every
// `/@<callsign>` view: the identity (`GET /api/social/profiles/<callsign>`),
// the calls and track record (`…/calls`, the default section) and the first
// items and theses pages. Visitors open profiles at a constant arrival rate;
// UNKNOWN_SHARE of requests ask for a callsign no account holds (a 404 that
// first checks the primary for a Mission Control member, the lazy-account
// path). Each request comes from its own synthetic IP, so the per-IP
// `social_read` bucket (600/min) is not what is measured. No CDN sits in
// front of `next start` here, so every request reaches the app: this is the
// uncached origin cost (replica reads; the CDN serves repeats for 10 s).
//
// Start the local fixture app with BLAST_SOCIAL_ENABLED=true, then run from apps/web:
//
//   k6 run -e BASE_URLS=http://127.0.0.1:3917 loadtest/scenarios/social-profile.js
//
// Env: PROFILE_RATE=200 (requests/s, scaled), PROFILE_HOLD_S=120,
// PROFILE_CALLSIGNS=acct_3,acct_4,… (comma separated), UNKNOWN_SHARE=0.05,
// PROFILE_P95_MS=300, PROFILE_SUCCESS=0.999.
import { check } from "k6";
import http from "k6/http";

import { baseFor, baseOptions, primeGate, duration, envNumber, scaled } from "./lib/k6-common.js";

const callsigns = (__ENV.PROFILE_CALLSIGNS || "acct_3,acct_4,acct_5,acct_6,acct_7,acct_8,acct_9,acct_13,member_7,member_701")
  .split(",").map((value) => value.trim()).filter(Boolean);
const unknownShare = envNumber("UNKNOWN_SHARE", 0.05);
const rate = scaled(envNumber("PROFILE_RATE", 200));
const P95 = envNumber("PROFILE_P95_MS", 300);
const PUBLIC_CACHE = "public, s-maxage=10, stale-while-revalidate=20";
const PARTS = [["identity", ""], ["calls", "/calls"], ["items", "/items"], ["theses", "/theses"]];

export const options = baseOptions({
  scenarios: {
    profile: {
      executor: "constant-arrival-rate",
      exec: "read",
      rate,
      timeUnit: "1s",
      duration: duration(envNumber("PROFILE_HOLD_S", 120)),
      preAllocatedVUs: Math.max(10, Math.ceil(rate / 4)),
      maxVUs: Math.max(50, rate * 2),
    },
  },
  thresholds: {
    checks: [`rate>=${envNumber("PROFILE_SUCCESS", 0.999)}`],
    ...Object.fromEntries(PARTS.map(([part]) => [`http_req_duration{part:${part}}`, [`p(95)<${P95}`]])),
    "http_req_duration{part:unknown}": [`p(95)<${P95}`],
  },
});

let n = 0;

export function read() {
  primeGate(baseFor(__VU));
  n += 1;
  const ip = `10.${(__VU >> 8) & 255}.${__VU & 255}.${n & 255}`;
  if (Math.random() < unknownShare) {
    const response = http.get(`${baseFor(__VU)}/api/social/profiles/nobody_${n % 997}`, {
      headers: { "x-forwarded-for": ip },
      tags: { part: "unknown", name: "GET /api/social/profiles/{callsign} (unknown)" },
    });
    check(response, {
      "unknown: 404 not_found": (r) => r.status === 404 && r.json("error.code") === "not_found",
      "unknown: no-store": (r) => r.headers["Cache-Control"] === "no-store",
    });
    return;
  }
  const callsign = callsigns[Math.floor(Math.random() * callsigns.length)];
  const [part, suffix] = PARTS[Math.floor(Math.random() * PARTS.length)];
  const response = http.get(`${baseFor(__VU)}/api/social/profiles/${encodeURIComponent(callsign)}${suffix}`, {
    headers: { "x-forwarded-for": ip },
    tags: { part, name: `GET /api/social/profiles/{callsign}${suffix}` },
  });
  check(response, {
    [`${part}: 200`]: (r) => r.status === 200,
    [`${part}: shared cache`]: (r) => r.headers["Cache-Control"] === PUBLIC_CACHE,
    [`${part}: as_of`]: (r) => r.json("as_of.checkpoint") > 0,
  });
}
