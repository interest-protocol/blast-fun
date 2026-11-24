// Social-feed UI-09/10: the presales list and sale reads, the hot public reads
// of `/presale` and `/presale/<id>`: `GET /api/social/presales` (each tab and
// sort, and a second keyset page) and `GET /api/social/presales/<id>`. Visitors
// arrive at a constant rate; PRESALES_SALE_SHARE of them open a sale page,
// the rest a list tab. Every 200 must be CDN-cacheable
// (`public, s-maxage=10, stale-while-revalidate=20`) and name its watermark
// (`as_of`). Each request comes from its own synthetic IP, so the per-IP
// `social_read` bucket is not what is measured. No CDN sits in front of
// `next start` here, so every request reaches the app: the uncached origin
// cost on the replica (and blast-infra's projection for terms, kept 5 min).
//
// Start the local fixture app with BLAST_SOCIAL_ENABLED=true and
// BLAST_PRESALE_ENABLED=true, then run from apps/web:
//
//   k6 run -e BASE_URLS=http://127.0.0.1:3917 -e PRESALES_IDS=… loadtest/scenarios/social-presales.js
//
// Env: PRESALES_RATE=200 (requests/s, scaled), PRESALES_HOLD_S=120, PRESALES_IDS (comma-separated presale ids),
// PRESALES_SALE_SHARE=0.5, PRESALES_P95_MS=300, PRESALES_SUCCESS=0.999.
import { check } from "k6";
import http from "k6/http";

import { baseFor, baseOptions, primeGate, duration, envNumber, scaled } from "./lib/k6-common.js";

const ids = (__ENV.PRESALES_IDS || "").split(",").map((value) => value.trim()).filter(Boolean);
const share = ids.length ? envNumber("PRESALES_SALE_SHARE", 0.5) : 0;
const rate = scaled(envNumber("PRESALES_RATE", 200));
const TABS = [
  ["live", "ending"], ["live", "fastest"], ["live", "backed"],
  ["upcoming", "opening"], ["upcoming", "interest"],
  ["ended", "recent"], ["ended", "best"], ["ended", "backed"],
];
const CACHE = "public, s-maxage=10, stale-while-revalidate=20";

export const options = baseOptions({
  scenarios: {
    presales: {
      executor: "constant-arrival-rate",
      exec: "read",
      rate,
      timeUnit: "1s",
      duration: duration(envNumber("PRESALES_HOLD_S", 120)),
      preAllocatedVUs: Math.max(10, Math.ceil(rate / 4)),
      maxVUs: Math.max(50, rate * 2),
    },
  },
  thresholds: {
    checks: [`rate>=${envNumber("PRESALES_SUCCESS", 0.999)}`],
    "http_req_duration{kind:list}": [`p(95)<${envNumber("PRESALES_P95_MS", 300)}`],
    "http_req_duration{kind:sale}": [`p(95)<${envNumber("PRESALES_P95_MS", 300)}`],
  },
});

let n = 0;

export function read() {
  primeGate(baseFor(__VU));
  n += 1;
  const ip = `10.${(__VU >> 8) & 255}.${__VU & 255}.${n & 255}`;
  const headers = { "x-forwarded-for": ip };
  if (Math.random() < share) {
    const id = ids[Math.floor(Math.random() * ids.length)];
    const response = http.get(`${baseFor(__VU)}/api/social/presales/${id}`, {
      headers, tags: { kind: "sale", name: "GET /api/social/presales/{presale_id}" },
    });
    check(response, {
      "sale: 200": (r) => r.status === 200,
      "sale: shared cache": (r) => r.headers["Cache-Control"] === CACHE,
      "sale: as_of": (r) => r.status === 200 && r.json("as_of.checkpoint") >= 0,
    });
    return;
  }
  const [status, sort] = TABS[Math.floor(Math.random() * TABS.length)];
  const first = http.get(`${baseFor(__VU)}/api/social/presales?status=${status}&sort=${sort}&limit=2`, {
    headers, tags: { kind: "list", name: "GET /api/social/presales" },
  });
  check(first, {
    "list: 200": (r) => r.status === 200,
    "list: shared cache": (r) => r.headers["Cache-Control"] === CACHE,
  });
  const cursor = first.status === 200 ? first.json("next_cursor") : null;
  if (cursor) {
    const next = http.get(`${baseFor(__VU)}/api/social/presales?status=${status}&sort=${sort}&limit=2&cursor=${encodeURIComponent(cursor)}`, {
      headers, tags: { kind: "list", name: "GET /api/social/presales (page 2)" },
    });
    check(next, { "list page 2: 200": (r) => r.status === 200 });
  }
}
