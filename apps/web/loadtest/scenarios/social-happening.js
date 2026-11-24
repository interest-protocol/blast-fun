// Social feed UI-05: Home's live reads (GET /api/social/happening: the right
// column, the live tape, Today on Blast). Each VU is a reader on Home: one
// read at page load, then the page's poll every HAPPENING_POLL_S (±20%) for
// HAPPENING_POLLS_PER_VISIT polls. Every answer is public and cacheable
// (`public, s-maxage=10, stale-while-revalidate=20`), so behind the CDN all
// readers share about one origin read per 10 s; this scenario goes straight to
// the app to measure the origin.
//
// Data: an app (`next start`, social flag on) over the launch-scale database:
// `loadtest/social-scale.ts seed`, then `loadtest/social-happening-scale.ts
// prepare`, with DATABASE_URL / DATABASE_REPLICA_URL at it as blast_web /
// blast_replica. Run from apps/web:
//
//   k6 run -e BASE_URLS=http://127.0.0.1:3917 loadtest/scenarios/social-happening.js
//
// Each VU reads from its own synthetic IP (X-Forwarded-For), as social_read is per IP.
//
// Env: HAPPENING_RATE=50 (visits started per second, scaled by SCALE),
// HAPPENING_RAMP_S=60, HAPPENING_HOLD_S=300, HAPPENING_MAX_VUS=2000,
// HAPPENING_POLLS_PER_VISIT=4, HAPPENING_POLL_S=30, HAPPENING_SUCCESS=0.999,
// HAPPENING_P95_MS=300.
import { check, sleep } from "k6";
import exec from "k6/execution";
import http from "k6/http";
import { Rate } from "k6/metrics";

import { ENV, baseFor, baseOptions, primeGate, duration, envNumber, scaled } from "./lib/k6-common.js";

const ok = new Rate("request_ok");
const rate = scaled(envNumber("HAPPENING_RATE", 50));
const polls = Math.max(0, Math.round(envNumber("HAPPENING_POLLS_PER_VISIT", 4)));
const pollSeconds = envNumber("HAPPENING_POLL_S", 30);
const p95 = envNumber("HAPPENING_P95_MS", 300);
const success = envNumber("HAPPENING_SUCCESS", 0.999);

export const options = baseOptions({
  scenarios: {
    social_happening: {
      executor: "ramping-arrival-rate",
      exec: "visit",
      startRate: 0,
      timeUnit: "1s",
      preAllocatedVUs: Math.min(200, scaled(envNumber("HAPPENING_MAX_VUS", 2_000))),
      maxVUs: scaled(envNumber("HAPPENING_MAX_VUS", 2_000)),
      stages: [
        { duration: duration(envNumber("HAPPENING_RAMP_S", 60)), target: rate },
        { duration: duration(envNumber("HAPPENING_HOLD_S", 300)), target: rate },
      ],
      gracefulStop: "60s",
    },
  },
  thresholds: {
    request_ok: [`rate>=${success}`],
    checks: [`rate>=${success}`],
    "http_req_duration{step:happening_load}": [`p(95)<${p95}`],
    "http_req_duration{step:happening_poll}": [`p(95)<${p95}`],
  },
});

function ipFor(n) {
  const v = (Math.abs(n) + ENV.ipSalt * 7919) % 16_000_000;
  return `10.${(v >> 16) & 255}.${(v >> 8) & 255}.${v & 255}`;
}

function read(base, step, headers) {
  const response = http.get(`${base}/api/social/happening`, { headers, tags: { step }, responseType: "text" });
  const good = check(response, {
    [`${step} 200`]: (r) => r.status === 200,
    [`${step} public cache`]: (r) => /public, s-maxage=10/.test(r.headers["Cache-Control"] || ""),
    [`${step} body`]: (r) => {
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body.tape) && Array.isArray(body.today) && typeof body.last_hour === "object" && typeof body.as_of === "object";
      } catch {
        return false;
      }
    },
  });
  ok.add(good, { step });
}

export function visit() {
  const n = exec.scenario.iterationInTest;
  const base = baseFor(n);
  primeGate(base);
  const headers = { "X-Forwarded-For": ipFor(n), Accept: "application/json" };
  read(base, "happening_load", headers);
  for (let i = 0; i < polls; i += 1) {
    sleep(pollSeconds * (0.8 + Math.random() * 0.4));
    read(base, "happening_poll", headers);
  }
}
