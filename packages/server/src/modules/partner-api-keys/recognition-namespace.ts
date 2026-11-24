/** Replicas of one registry share recognition even when their request quotas differ. */
export function partnerRecognitionNamespace(
  override: string | undefined,
  quotaNamespace: string,
): string {
  if (override === undefined) return quotaNamespace;
  if (!/^[a-f0-9]{64}$/.test(override))
    throw new Error("Invalid partner recognition namespace.");
  return override;
}
