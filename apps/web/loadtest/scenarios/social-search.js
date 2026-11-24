// Social-feed UI-12: search, the hot public read behind the search sheet
// (`GET /api/social/search?q=`). Visitors type terms one keystroke at a time
// (the sheet reads each settled prefix): suggestions on open, then 1, 2, 3+
// characters of a term drawn from SEARCH_TERMS (callsigns, names, sale names
// and symbols, and a miss). Every 200 must be CDN-cacheable
// (`public, s-maxage=10, stale-while-revalidate=20`), say which term it
// answers and name its watermark (`as_of`); no answer may carry more than 5
// presales or 6 people. Each visitor has its own synthetic IP, so the
// per-IP `social_read` bucket (600/min) is not what is measured. No CDN sits
// in front of `next start` here, so every request reaches the replica: the
// uncached origin cost.
//
// Start the local fixture app with BLAST_SOCIAL_ENABLED=true and
// BLAST_PRESALE_ENABLED=true, then run from apps/web:
//
//   k6 run -e BASE_URLS=http://127.0.0.1:3917 loadtest/scenarios/social-search.js
//
// Env: SEARCH_RATE=100 (sessions/s, scaled), SEARCH_HOLD_S=120, SEARCH_TERMS (comma-separated),
// SEARCH_P95_MS=200, SEARCH_SUCCESS=0.999.
import { check } from "k6";
import http from "k6/http";

import { baseFor, baseOptions, primeGate, duration, envNumber, scaled } from "./lib/k6-common.js";

const terms = (__ENV.SEARCH_TERMS || "luca,mira,kai,romano,meridian,tidal,mrdn,kestrel,nova,zzzz").split(",").map((value) => value.trim()).filter(Boolean);
const rate = scaled(envNumber("SEARCH_RATE", 100));
const CACHE = "public, s-maxage=10, stale-while-revalidate=20";

export const options = baseOptions({
  scenarios: {
    search: {
      executor: "constant-arrival-rate",
      exec: "session",
      rate,
      timeUnit: "1s",
      duration: duration(envNumber("SEARCH_HOLD_S", 120)),
      preAllocatedVUs: Math.max(10, Math.ceil(rate / 2)),
      maxVUs: Math.max(50, rate * 4),
    },
  },
  thresholds: {
    checks: [`rate>=${envNumber("SEARCH_SUCCESS", 0.999)}`],
    "http_req_duration{kind:suggestions}": [`p(95)<${envNumber("SEARCH_P95_MS", 200)}`],
    "http_req_duration{kind:term}": [`p(95)<${envNumber("SEARCH_P95_MS", 200)}`],
  },
});

let n = 0;

function read(headers, query, kind) {
  const url = query ? `${baseFor(__VU)}/api/social/search?q=${encodeURIComponent(query)}` : `${baseFor(__VU)}/api/social/search`;
  const response = http.get(url, { headers, tags: { kind, name: "GET /api/social/search" } });
  check(response, {
    [`${kind}: 200`]: (r) => r.status === 200,
    [`${kind}: shared cache`]: (r) => r.headers["Cache-Control"] === CACHE,
    [`${kind}: answers the term`]: (r) => r.status === 200 && r.json("query") === query,
    [`${kind}: bounded`]: (r) => r.status === 200 && r.json("presales").length <= 5 && r.json("people").length <= 6,
    [`${kind}: as_of`]: (r) => r.status === 200 && r.json("as_of.checkpoint") >= 0,
  });
}

// One sheet: opened (suggestions), then the term typed out; the sheet reads each settled prefix.
export function session() {
  primeGate(baseFor(__VU));
  n += 1;
  const headers = { "x-forwarded-for": `10.${(__VU >> 8) & 255}.${__VU & 255}.${n & 255}` };
  read(headers, "", "suggestions");
  const term = terms[Math.floor(Math.random() * terms.length)];
  for (let length = 1; length <= term.length; length += 1) read(headers, term.slice(0, length), "term");
}
