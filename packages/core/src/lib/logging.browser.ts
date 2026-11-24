import type { StructuredLog } from "./logging.ts";

export type { LogFields } from "./logging.ts";

/** Browser read clients reuse metrics but have no backend log drain. */
export function createStructuredLog(): StructuredLog {
  return () => {};
}
