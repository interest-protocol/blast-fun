const maxChunkBytes = 1_024;
// 64 queued hint chunks per client under a 64 MiB relay queue budget: 1,024 clients per relay.
const maxClients = Math.floor((64 * 1_024 * 1_024) / (64 * maxChunkBytes));

/** Live market sockets per hints process; the configured stream count sets the cap. */
export const ACTIVITY_HINT_STREAM_BUDGET = Object.freeze({
  defaultClients: 200,
  maxClients,
  maxChunkBytes,
});
