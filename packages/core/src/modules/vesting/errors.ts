export type VestingReadFailure =
  | "not_found"
  | "unavailable"
  | "unsupported"
  | "index_unavailable"
  | "authority_unavailable";

/** Public error vocabulary shared by the backend and its thin SSR adapter. */
export class VestingReadError extends Error {
  readonly reason: VestingReadFailure;

  constructor(reason: VestingReadFailure) {
    super(reason);
    this.reason = reason;
  }
}
