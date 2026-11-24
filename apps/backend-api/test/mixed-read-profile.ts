import { performance } from "node:perf_hooks";

type Attempt = Readonly<{ status: number | null; error?: "transport" | "validation" }>;
type Totals = {
  attempts: number;
  valid: number;
  statuses: Record<string, number>;
  errors: Record<string, number>;
};
type Group = { totals: Totals; samples: number[]; maxMs: number; sumMs: number };

function increment(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function recordLatency(group: Group, elapsed: number, limit: number, random: () => number) {
  group.sumMs += elapsed;
  group.maxMs = Math.max(group.maxMs, elapsed);
  if (group.samples.length < limit) {
    group.samples.push(elapsed);
  } else {
    const selected = Math.floor(random() * group.totals.attempts);
    if (selected < limit) {
      group.samples[selected] = elapsed;
    }
  }
}

/** Bounded fixture telemetry; every attempt counts, percentiles use a reservoir. */
export async function mixedReadProfile(input: {
  durationMs: number;
  labels: readonly string[];
  sampleLimit?: number;
  thinkTimeMs?: number;
  request: (worker: number) => Promise<Attempt>;
  clock?: () => number;
  random?: () => number;
  pause?: (ms: number) => Promise<void>;
}) {
  const sampleLimit = input.sampleLimit ?? 2_048;
  const thinkTimeMs = input.thinkTimeMs ?? 0;
  if (
    !Number.isInteger(input.durationMs) ||
    input.durationMs < 1 ||
    input.durationMs > 120_000 ||
    !input.labels.length ||
    input.labels.length > 8 ||
    !Number.isInteger(sampleLimit) ||
    sampleLimit < 1 ||
    sampleLimit > 4_096 ||
    !Number.isInteger(thinkTimeMs) ||
    thinkTimeMs < 0 ||
    thinkTimeMs > 120_000
  ) {
    throw new RangeError("Mixed fixture duration, clients and telemetry must stay bounded.");
  }
  const clock = input.clock ?? (() => performance.now());
  const random = input.random ?? Math.random;
  const pause =
    input.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = clock();
  const groups = new Map<string, Group>();
  for (const label of input.labels) {
    groups.set(label, {
      totals: { attempts: 0, valid: 0, statuses: {}, errors: {} },
      samples: [],
      maxMs: 0,
      sumMs: 0,
    });
  }
  await Promise.all(
    input.labels.map(async (label, worker) => {
      const group = groups.get(label)!;
      while (clock() - started < input.durationMs) {
        const before = clock();
        let answer: Attempt;
        try {
          answer = await input.request(worker);
        } catch {
          answer = { status: null, error: "transport" };
        }
        const elapsed = Math.max(0, clock() - before);
        const totals = group.totals;
        totals.attempts++;
        if (answer.status !== null) {
          increment(totals.statuses, String(answer.status));
        }
        const error = answer.error ?? (answer.status === 200 ? null : "http_status");
        if (error) {
          increment(totals.errors, error);
        } else {
          totals.valid++;
        }
        recordLatency(group, elapsed, sampleLimit, random);
        const remaining = input.durationMs - (clock() - started);
        if (thinkTimeMs && remaining > 0) {
          await pause(Math.min(thinkTimeMs, remaining));
        }
      }
    }),
  );
  return {
    requestedDurationMs: input.durationMs,
    elapsedMs: clock() - started,
    thinkTimeMs,
    clients: input.labels.length,
    groups: Object.fromEntries(
      [...groups].map(([label, group]) => {
        const sorted = group.samples.toSorted((a, b) => a - b);
        const percentile = (fraction: number) =>
          sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
        return [
          label,
          {
            ...group.totals,
            latency: {
              sampleCount: sorted.length,
              reservoirLimit: sampleLimit,
              p50Ms: percentile(0.5),
              p95Ms: percentile(0.95),
              p99Ms: percentile(0.99),
              maxMs: group.maxMs,
              meanMs: group.totals.attempts ? group.sumMs / group.totals.attempts : null,
            },
          },
        ];
      }),
    ),
  };
}
