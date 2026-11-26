/**
 * Chain-to-screen timing for live market frames (plan PR 1.2). One tab in a
 * hundred measures; each minute it sends p50/p95 per hop in one beacon.
 *
 * - Engine hops come from `provenance.hops` (protocol.md section 4), and the
 *   relay adds `relay_ms`.
 * - Browser receipt and paint (after `requestAnimationFrame`) are on the
 *   browser clock. They join the server clocks through the socket's
 *   ping/pong: the sample with the smallest round trip gives the offset.
 *   Without an offset yet the cross-clock hops are skipped.
 */

export const LIVE_TIMING_PATH = "/api/launchpad/market/timing";
export const TIMING_SAMPLE_RATE = 0.01;
export const TIMING_REPORT_MS = 60_000;
/** Pings at 1, 6 and 11 s after a socket opens, then once a minute: the server closes on two within a second, so a stalled pair must not reach it together. */
const PING_DELAYS_MS = [1_000, 5_000, 5_000];
/** A socket still connecting is retried this often, at most `PING_RETRIES` times. */
const PING_RETRY_MS = 1_000;
const PING_RETRIES = 15;
const PING_EVERY_MS = 60_000;
/** A hop longer than this is a replayed or stale frame, not a live one. */
const MAX_HOP_MS = 120_000;
const MAX_SAMPLES = 1_000;

export const TIMING_SEGMENTS = ["intake", "market", "reader", "hints", "wire", "paint", "chain"] as const;
export type TimingSegment = (typeof TIMING_SEGMENTS)[number];
export type HopStats = Readonly<{ n: number; p50: number; p95: number }>;
export type TimingReport = Readonly<{
  transport: "socket";
  offset_rtt_ms: number | null;
  hops: Partial<Record<TimingSegment, HopStats>>;
}>;

/** Nearest-rank percentile of an ascending list. */
export function percentile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

/** Keeps the ping/pong sample with the smallest round trip: its offset is off by at most rtt/2. */
export class ClockOffset {
  #best: { rtt: number; offset: number } | null = null;

  sample(sentMs: number, serverMs: number, receivedMs: number): void {
    const rtt = receivedMs - sentMs;
    if (!(rtt >= 0) || !Number.isFinite(serverMs)) return;
    if (this.#best && this.#best.rtt <= rtt) return;
    this.#best = { rtt, offset: serverMs - (sentMs + rtt / 2) };
  }

  /** Server time minus browser time, or null before the first pong. */
  get offset(): number | null {
    return this.#best?.offset ?? null;
  }

  get rtt(): number | null {
    return this.#best?.rtt ?? null;
  }
}

type Stamps = Readonly<{ timestampMs: unknown; hops: unknown }>;

/** Per-hop durations of one frame; `offset` is server minus browser time. */
export function frameSegments(stamps: Stamps, receiptMs: number, paintMs: number, offset: number | null): Partial<Record<TimingSegment, number>> {
  const hops = stamps.hops && typeof stamps.hops === "object" ? (stamps.hops as Record<string, unknown>) : {};
  const at = (key: string) => (typeof hops[key] === "number" ? (hops[key] as number) : null);
  const span = (from: number | null, to: number | null) => (from === null || to === null ? null : to - from);
  const server = (browserMs: number) => (offset === null ? null : browserMs + offset);
  const timestamp = typeof stamps.timestampMs === "number" ? stamps.timestampMs : null;
  const values: Record<TimingSegment, number | null> = {
    intake: span(at("arrived_ms"), at("intake_committed_ms")),
    market: span(at("intake_committed_ms"), at("written_ms")),
    reader: span(at("written_ms"), at("picked_ms")),
    hints: span(at("picked_ms"), at("relay_ms")),
    wire: span(at("relay_ms"), server(receiptMs)),
    paint: paintMs - receiptMs,
    chain: span(timestamp, server(paintMs)),
  };
  const segments: Partial<Record<TimingSegment, number>> = {};
  for (const segment of TIMING_SEGMENTS) {
    const value = values[segment];
    if (value !== null && Number.isFinite(value) && value >= 0 && value <= MAX_HOP_MS) segments[segment] = Math.round(value);
  }
  return segments;
}

const stats = (value: unknown): value is HopStats => {
  if (!value || typeof value !== "object") return false;
  const { n, p50, p95 } = value as Record<string, unknown>;
  const ms = (x: unknown) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= MAX_HOP_MS;
  return Number.isInteger(n) && (n as number) > 0 && (n as number) <= MAX_SAMPLES && ms(p50) && ms(p95) && Object.keys(value).length === 3;
};

/** The beacon body, or null: only known hops, small integers, nothing else. */
export function parseTimingReport(body: unknown): TimingReport | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { transport, offset_rtt_ms: rtt, hops } = body as Record<string, unknown>;
  if (transport !== "socket") return null;
  if (rtt !== null && !(Number.isInteger(rtt) && (rtt as number) >= 0 && (rtt as number) <= 60_000)) return null;
  if (!hops || typeof hops !== "object" || Array.isArray(hops)) return null;
  const entries = Object.entries(hops);
  if (!entries.length || entries.some(([key, value]) => !(TIMING_SEGMENTS as readonly string[]).includes(key) || !stats(value))) return null;
  return { transport, offset_rtt_ms: rtt as number | null, hops: hops as TimingReport["hops"] };
}

export type TimingSocket = Readonly<{ send(text: string): boolean }>;

export type LiveTimingDependencies = Readonly<{
  now: () => number;
  schedule: (run: () => void, ms: number) => void;
  afterPaint: (run: () => void) => void;
  /** Hidden tabs do not paint: their frames would record the hidden time as paint. */
  visible: () => boolean;
  send: (path: string, body: string) => void;
}>;

/** One tab's recorder; sampling is the caller's choice. */
export function createLiveTiming(deps: LiveTimingDependencies) {
  let clock = new ClockOffset();
  const samples = new Map<TimingSegment, number[]>();
  let socket: TimingSocket | null = null;

  const ping = (current: TimingSocket, step: number, retries = 0) => {
    if (socket !== current) return;
    if (!current.send(JSON.stringify({ op: "ping", t: deps.now() }))) {
      if (retries < PING_RETRIES) deps.schedule(() => ping(current, step, retries + 1), PING_RETRY_MS);
      return;
    }
    deps.schedule(() => ping(current, step + 1), PING_DELAYS_MS[step + 1] ?? PING_EVERY_MS);
  };
  const report = () => {
    deps.schedule(report, TIMING_REPORT_MS);
    const hops: Partial<Record<TimingSegment, HopStats>> = {};
    for (const [segment, values] of samples) {
      if (!values.length) continue;
      values.sort((a, b) => a - b);
      hops[segment] = { n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
    }
    samples.clear();
    if (!Object.keys(hops).length) return;
    const rtt = clock.rtt;
    deps.send(LIVE_TIMING_PATH, JSON.stringify({ transport: "socket", offset_rtt_ms: rtt === null ? null : Math.round(rtt), hops }));
  };
  deps.schedule(report, TIMING_REPORT_MS);

  return {
    /** A new socket carries this tab's stream; it gets the clock pings. */
    socket(next: TimingSocket): void {
      socket = next;
      // Another instance, a sleep or a clock step: the old offset may no longer hold.
      clock = new ClockOffset();
      deps.schedule(() => ping(next, 0), PING_DELAYS_MS[0]!);
    },
    pong(data: string | undefined): void {
      try {
        const { t, server_ms: serverMs } = JSON.parse(data ?? "") as { t?: unknown; server_ms?: unknown };
        if (typeof t === "number" && typeof serverMs === "number") clock.sample(t, serverMs, deps.now());
      } catch { /* a malformed pong is just not a sample */ }
    },
    market(data: string | undefined): void {
      if (!deps.visible()) return;
      const receipt = deps.now();
      let stamps: Stamps;
      try {
        const frame = JSON.parse(data ?? "") as { timestamp_ms?: unknown; provenance?: { hops?: unknown } };
        stamps = { timestampMs: frame.timestamp_ms, hops: frame.provenance?.hops };
      } catch {
        return;
      }
      deps.afterPaint(() => {
        if (!deps.visible()) return;
        for (const [segment, value] of Object.entries(frameSegments(stamps, receipt, deps.now(), clock.offset)) as [TimingSegment, number][]) {
          let list = samples.get(segment);
          if (!list) samples.set(segment, (list = []));
          if (list.length < MAX_SAMPLES) list.push(value);
        }
      });
    },
  };
}

