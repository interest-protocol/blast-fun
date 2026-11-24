/** An indexing gap requires service recovery, not repeated wallet requests. */
export class VestingCapabilityUnavailable extends Error {}

export function retryVestingRead(failures: number, error: Error): boolean {
  return !(error instanceof VestingCapabilityUnavailable) && failures < 2;
}
