/** Small JSON bodies remain fail-fast; capped image uploads allow 4 MiB at 400 KiB/s. */
export function privateBodyDeadlineMs(maxBodyBytes: number): number {
  return maxBodyBytes > 65_536 ? 10_000 : 1_000;
}
