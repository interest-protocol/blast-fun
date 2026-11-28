import { timed, type MetricFields } from "@blast/core/lib/metrics.ts";

/** One in ten successful steps is logged; a failed step always is (`timed`). */
export const READ_STEP_SAMPLE_RATE = 0.1;

/**
 * Times one step of a slow read as a `social.read_step` line: `read` names
 * the answer, `step` the database round or query inside it, `fields` short
 * labels such as the window. The route kit's `social.route` line times the
 * whole answer; these say which step is slow. One metric name and rate for
 * every read, so one log query compares them.
 */
export function readStep<Result>(read: string, step: string, operation: () => Promise<Result>, fields: MetricFields = {}): Promise<Result> {
  return timed("social.read_step", operation, { ...fields, read, step }, { sampleRate: READ_STEP_SAMPLE_RATE });
}

export type ReadSteps = <Result>(name: string, operation: () => Promise<Result>) => Promise<Result>;

/** `readStep` bound to one read and its labels: `const step = readSteps("happening")`. */
export function readSteps(read: string, fields: MetricFields = {}): ReadSteps {
  return function step<Result>(name: string, operation: () => Promise<Result>): Promise<Result> {
    return readStep(read, name, operation, fields);
  };
}
