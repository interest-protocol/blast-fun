/**
 * One-line JSON metrics that Vercel runtime logs and log drains can parse.
 * Fields hold numbers, booleans, and short labels only: never tokens, codes,
 * cookies, wallet addresses, or provider payloads.
 */
import { createStructuredLog, type LogFields } from "#metric-log";

export type MetricFields = LogFields;

const log = createStructuredLog();

export type MetricOptions = Readonly<{
  /** Fraction of successful samples to keep (0–1). Failures are always kept. */
  sampleRate?: number;
}>;

function enabled(): boolean {
  // In a browser (the Holders read reuses the `/v1` client there) no log drain
  // collects the line: visitors' consoles get nothing.
  if (typeof window !== "undefined") return false;
  return process.env.MISSION_CONTROL_METRICS !== "off";
}

export function recordMetric(name: string, fields: MetricFields = {}): void {
  if (!enabled()) return;
  log(name, fields);
}

/** Best-effort observations never own the result, error, or lifetime of work. */
export function observeMetric(name: string, fields: MetricFields = {}, options: MetricOptions = {}): void {
  try {
    if (!enabled()) return;
    const sampleRate = options.sampleRate ?? 1;
    if (sampleRate < 1 && !(Math.random() < sampleRate)) return;
    recordMetric(name, { ...fields, ...(sampleRate < 1 ? { sampleRate } : {}) });
  } catch { /* A sampler or log sink failure must not affect the observed work. */ }
}

/**
 * A stable label for an error that is safe to log: a PostgreSQL SQLSTATE, a
 * module error code, or the error class name. Messages are never included.
 */
export function errorLabel(error: unknown): string {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code)) return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && /^[A-Za-z0-9_]{1,64}$/.test(name)) return name;
  }
  return "unknown";
}

export async function timed<Result>(
  name: string,
  operation: () => Promise<Result>,
  fields: MetricFields = {},
  options: MetricOptions = {},
): Promise<Result> {
  const started = performance.now();
  try {
    const result = await operation();
    const sampleRate = options.sampleRate ?? 1;
    if (sampleRate >= 1 || Math.random() < sampleRate) {
      recordMetric(name, {
        ...fields,
        durationMs: Math.round(performance.now() - started),
        outcome: "ok",
        ...(sampleRate < 1 ? { sampleRate } : {}),
      });
    }
    return result;
  } catch (error) {
    recordMetric(name, {
      ...fields,
      durationMs: Math.round(performance.now() - started),
      error: errorLabel(error),
      outcome: "error",
    });
    throw error;
  }
}
