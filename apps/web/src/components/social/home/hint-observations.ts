import { track } from "@vercel/analytics";

import type { MetricFields } from "@blast/core/lib/metrics.ts";

const SAMPLE_RATE = 0.02;
const WINDOW_MS = 60_000;
const MAX_EVENTS = 20;
type Properties = Record<string, string | number | boolean>;

function surface(value: unknown): value is "feed_new" | "happening" | "queries" | "blast-ticker" | "home" | "blast-lanes" {
  return value === "feed_new" || value === "happening" || value === "queries" || value === "blast-ticker" || value === "home" || value === "blast-lanes";
}

function cause(value: unknown): value is "hint" | "connect" | "resync" {
  return value === "hint" || value === "connect" || value === "resync";
}

function properties(fields: MetricFields): Properties | null {
  switch (fields.event) {
    case "connect":
      return { event: "connect" };
    case "reconnect":
      return typeof fields.failures === "number" && Number.isInteger(fields.failures) && fields.failures >= 0 && fields.failures <= 1_000_000
        ? { event: "reconnect", failures: fields.failures } : null;
    case "hint":
      return fields.kind === "activity" || fields.kind === "presale_lifecycle"
        ? { event: "hint", kind: fields.kind } : null;
    case "refetch":
      return surface(fields.surface) && cause(fields.cause)
        ? { event: "refetch", surface: fields.surface, cause: fields.cause } : null;
    case "painted":
      return surface(fields.surface) && typeof fields.ms === "number" && Number.isFinite(fields.ms) && fields.ms >= 0 && fields.ms <= 300_000
        ? { event: "refresh_completed", surface: fields.surface, ms: Math.round(fields.ms), freshness: "unverified" } : null;
    case "unavailable":
      return fields.reason === "socket" || fields.reason === "hello" || fields.reason === "network" || fields.reason === "subscribe"
        ? { event: "unavailable", reason: fields.reason } : null;
    default:
      return null;
  }
}

/** Sampled observations, capped per tab: no retry queue and no implied fresh-data proof. */
export function createHintObservationReporter() {
  const emitted: number[] = [];
  let lastTime = 0;
  return (name: string, fields: MetricFields): void => {
    try {
      if (typeof window === "undefined" || name !== "social.activity_hints") return;
      const data = properties(fields);
      if (data === null) return;
      const time = performance.now();
      if (!Number.isFinite(time) || time < lastTime) return;
      lastTime = time;
      while (emitted.length > 0 && time - emitted[0] >= WINDOW_MS) emitted.shift();
      if (emitted.length >= MAX_EVENTS) return;
      const draw = Math.random();
      if (!Number.isFinite(draw) || draw < 0 || draw >= SAMPLE_RATE) return;
      emitted.push(time);
      track("social_hint_observation", { ...data, sampleRate: SAMPLE_RATE, capPerMinute: MAX_EVENTS });
    } catch {
      // Clock, sampling and analytics failures never own hints or refreshes.
    }
  };
}

export const recordBrowserHintObservation = createHintObservationReporter();
