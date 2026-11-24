export const publishStorageKey = (draftId: string, creator: string) =>
  `blast:create:publish:v1:${creator}:${draftId}`;

/** Older clients wrote a checkpoint even after dropping the only transaction. */
export function isEmptyPublishCheckpoint(raw: string): boolean {
  try {
    const checkpoint: unknown = JSON.parse(raw);
    if (!checkpoint || typeof checkpoint !== "object" || !("transactions" in checkpoint)) return false;
    const { transactions } = checkpoint;
    return transactions !== null && typeof transactions === "object" && !Array.isArray(transactions) && Object.keys(transactions).length === 0;
  } catch {
    // Keep malformed checkpoints for the publish flow's recovery message.
    return false;
  }
}
