const queuedChunks = 64;
const maxChunkBytes = 1_024;
// Application relay queue payload only; runtime, socket and proxy buffers are additional.
const queuePayloadBudgetBytes = 32 * 1_024 * 1_024;

/** Connected streams use a separate bounded lane from ordinary request work. */
export const ACTIVITY_HINT_STREAM_BUDGET = Object.freeze({
  defaultClients: 200,
  maxClients: Math.floor(
    queuePayloadBudgetBytes / (queuedChunks * maxChunkBytes),
  ),
  queuePayloadBudgetBytes,
  queuedChunks,
  maxChunkBytes,
  maxUpstreamFrameChars: 65_536,
  heartbeatMs: 15_000,
  lifetimeMs: 270_000,
});
