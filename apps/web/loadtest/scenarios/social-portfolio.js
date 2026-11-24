// Social-feed UI-07: the opt-in public portfolio read (OA-10),
// `GET /api/social/profiles/<callsign>/portfolio`, a hot public read once
// profiles show the gold card. Visitors open profiles at a constant arrival
// rate; PORTFOLIO_PUBLIC_SHARE of them land on a portfolio its owner made
// public (200, CDN-cacheable `public, s-maxage=10`, never stale: OA-30), the
// rest on one that is private (403 `portfolio_private`, `no-store`). Each
// request comes from its own synthetic IP, so the per-IP `social_read` bucket
// (600/min) is not what is measured. No CDN sits in front of `next start`
// here, so every request reaches the app: this is the uncached origin cost
// (the replica reads, the cost-basis ledger included, and the fullnode
// balance fan-out, which the egress guard answers locally).
//
// Start the local fixture app with BLAST_SOCIAL_ENABLED=true and
// BLAST_PRESALE_ENABLED=true, then run from apps/web:
//
//   k6 run -e BASE_URLS=http://127.0.0.1:3917 loadtest/scenarios/social-portfolio.js
//
// Env: PORTFOLIO_RATE=200 (requests/s, scaled), PORTFOLIO_HOLD_S=120,
// PORTFOLIO_PUBLIC=new_3,new_6 (callsigns with a public portfolio, comma
// separated), PORTFOLIO_PRIVATE=new_1,new_2, PORTFOLIO_PUBLIC_SHARE=0.5,
// PORTFOLIO_P95_MS=300, PORTFOLIO_SUCCESS=0.999.
import { check } from "k6";
import http from "k6/http";

import { baseFor, baseOptions, primeGate, duration, envNumber, scaled } from "./lib/k6-common.js";

const list = (name, fallback) => (__ENV[name] || fallback).split(",").map((value) => value.trim()).filter(Boolean);
const publicCallsigns = list("PORTFOLIO_PUBLIC", "new_3,new_6,new_9,new_12");
const privateCallsigns = list("PORTFOLIO_PRIVATE", "new_1,new_2,new_4,new_5");
const share = envNumber("PORTFOLIO_PUBLIC_SHARE", 0.5);
const rate = scaled(envNumber("PORTFOLIO_RATE", 200));

export const options = baseOptions({
  scenarios: {
    portfolio: {
      executor: "constant-arrival-rate",
      exec: "read",
      rate,
      timeUnit: "1s",
      duration: duration(envNumber("PORTFOLIO_HOLD_S", 120)),
      preAllocatedVUs: Math.max(10, Math.ceil(rate / 4)),
      maxVUs: Math.max(50, rate * 2),
    },
  },
  thresholds: {
    checks: [`rate>=${envNumber("PORTFOLIO_SUCCESS", 0.999)}`],
    "http_req_duration{kind:public}": [`p(95)<${envNumber("PORTFOLIO_P95_MS", 300)}`],
    "http_req_duration{kind:private}": [`p(95)<${envNumber("PORTFOLIO_P95_MS", 300)}`],
  },
});

let n = 0;

export function read() {
  primeGate(baseFor(__VU));
  n += 1;
  const isPublic = Math.random() < share;
  const pool = isPublic ? publicCallsigns : privateCallsigns;
  const callsign = pool[Math.floor(Math.random() * pool.length)];
  const ip = `10.${(__VU >> 8) & 255}.${__VU & 255}.${n & 255}`;
  const response = http.get(`${baseFor(__VU)}/api/social/profiles/${encodeURIComponent(callsign)}/portfolio`, {
    headers: { "x-forwarded-for": ip },
    tags: { kind: isPublic ? "public" : "private", name: "GET /api/social/profiles/{callsign}/portfolio" },
  });
  if (isPublic) {
    check(response, {
      "public: 200": (r) => r.status === 200,
      "public: shared 10 s, never stale (OA-30)": (r) => r.headers["Cache-Control"] === "public, s-maxage=10",
    });
  } else {
    check(response, {
      "private: 403 portfolio_private": (r) => r.status === 403 && r.json("error.code") === "portfolio_private",
      "private: no-store": (r) => r.headers["Cache-Control"] === "no-store",
    });
  }
}
