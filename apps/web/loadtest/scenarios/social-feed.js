// Social feed: the home feed's hot public reads (UI-02/03, T-007, T-012).
// Each VU is a reader on the home page: it loads the first For You page,
// scrolls one to three pages deeper, opens one post's permalink read, then
// polls "new items since" every NEW_POLL_S (±20%) for SOCIAL_POLLS_PER_VISIT
// polls before the next visit. Every request is a public, cacheable read
// (`public, s-maxage=10, stale-while-revalidate=20`), so with a CDN in front
// most would never reach the app; this scenario goes straight to the app to
// measure the origin.
//
// Data: an app (`next start`, social flag on) over a seeded launch-scale
// database: `SOCIAL_SCALE_DATABASE_URL=... node --no-warnings
// --experimental-strip-types loadtest/social-scale.ts seed`, then
// DATABASE_URL / DATABASE_REPLICA_URL at that database as blast_web /
// blast_replica. Run from apps/web:
//
//   k6 run -e BASE_URLS=http://127.0.0.1:3917 loadtest/scenarios/social-feed.js
//
// Each VU reads from its own synthetic IP (X-Forwarded-For) so the
// social_read bucket (600 per minute per IP) is per reader, as in production.
//
// Env: SOCIAL_RATE=50 (visits started per second, scaled by SCALE),
// SOCIAL_RAMP_S=60, SOCIAL_HOLD_S=300, SOCIAL_MAX_VUS=2000,
// SOCIAL_POLLS_PER_VISIT=4, NEW_POLL_S=30, SOCIAL_DEEP_PAGES=3,
// SOCIAL_SUCCESS=0.999, SOCIAL_P95_MS=500 (first page and new-count p95).
import { check, sleep } from "k6";
import exec from "k6/execution";
import http from "k6/http";
import { Rate } from "k6/metrics";

import { ENV, baseFor, baseOptions, primeGate, duration, envNumber, scaled } from "./lib/k6-common.js";

const ok = new Rate("request_ok");
const rate = scaled(envNumber("SOCIAL_RATE", 50));
const polls = Math.max(0, Math.round(envNumber("SOCIAL_POLLS_PER_VISIT", 4)));
const deepPages = Math.max(0, Math.round(envNumber("SOCIAL_DEEP_PAGES", 3)));
const pollSeconds = envNumber("NEW_POLL_S", 30);
const p95 = envNumber("SOCIAL_P95_MS", 500);
const success = envNumber("SOCIAL_SUCCESS", 0.999);

export const options = baseOptions({
  scenarios: {
    social_feed: {
      executor: "ramping-arrival-rate",
      exec: "visit",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: Math.min(200, scaled(envNumber("SOCIAL_MAX_VUS", 2_000))),
      maxVUs: scaled(envNumber("SOCIAL_MAX_VUS", 2_000)),
      stages: [
        { duration: duration(envNumber("SOCIAL_RAMP_S", 60)), target: rate },
        { duration: duration(envNumber("SOCIAL_HOLD_S", 300)), target: rate },
      ],
      gracefulStop: "60s",
    },
  },
  thresholds: {
    request_ok: [`rate>=${success}`],
    checks: [`rate>=${success}`],
    "http_req_duration{step:feed_first}": [`p(95)<${p95}`],
    "http_req_duration{step:feed_new}": [`p(95)<${p95}`],
    "http_req_duration{step:feed_deep}": ["p(95)>=0"],
    "http_req_duration{step:item}": ["p(95)>=0"],
  },
});

function ipFor(n) {
  const v = (Math.abs(n) + ENV.ipSalt * 7919) % 16_000_000;
  return `10.${(v >> 16) & 255}.${(v >> 8) & 255}.${v & 255}`;
}

function get(base, path, step, headers) {
  const response = http.get(`${base}${path}`, { headers, tags: { step }, responseType: "text" });
  const good = check(response, {
    [`${step} 200`]: (r) => r.status === 200,
    [`${step} public cache`]: (r) => /public/.test(r.headers["Cache-Control"] || ""),
  });
  ok.add(good, { step });
  if (!good) return null;
  try {
    return JSON.parse(response.body);
  } catch {
    return null;
  }
}

export function visit() {
  const n = exec.scenario.iterationInTest;
  const base = baseFor(n);
  primeGate(base);
  const headers = { "X-Forwarded-For": ipFor(n), Accept: "application/json" };

  const first = get(base, "/api/social/feed?tab=for_you", "feed_first", headers);
  if (!first) return;
  let cursor = first.next_cursor;
  for (let page = 0; page < deepPages && cursor; page += 1) {
    const next = get(base, `/api/social/feed?tab=for_you&cursor=${encodeURIComponent(cursor)}`, "feed_deep", headers);
    cursor = next ? next.next_cursor : null;
  }
  const items = first.items || [];
  if (items.length > 0) {
    const item = items[n % items.length];
    get(base, `/api/social/items/${encodeURIComponent(item.entry_id)}`, "item", headers);
  }

  // The newest post shown is where "new since" counts from (T-012).
  const since = items.reduce((newest, item) => Math.max(newest, item.occurred_at_ms), 0);
  for (let poll = 0; poll < polls; poll += 1) {
    sleep(pollSeconds * (0.8 + Math.random() * 0.4));
    get(base, `/api/social/feed/new?since=${since}`, "feed_new", headers);
  }
}
