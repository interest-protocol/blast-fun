import { publicErrorMessage } from "#web/lib/errors.ts";

/** External exception text is never public diagnostic copy. */
export function describeError(error: unknown): string {
  return publicErrorMessage(error, "The external service could not complete this request. Retry shortly.", "service_unavailable");
}
