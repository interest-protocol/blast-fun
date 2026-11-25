// Pure helpers for the live market probe: SSE parsing, per-frame lag and percentiles.

/** Splits SSE text into complete events; `rest` is the unfinished tail to prepend next time. */
export function parseSse(text) {
  const blocks = text.replace(/\r\n/g, "\n").split("\n\n");
  const rest = blocks.pop() ?? "";
  const events = [];
  for (const block of blocks) {
    const event = parseSseBlock(block);
    if (event) events.push(event);
  }
  return { events, rest };
}

/** One SSE event block (also one direct-socket message) → `{ event, data, id }`, or null. */
export function parseSseBlock(block) {
  let event = "message";
  let id = null;
  const data = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  return data.length ? { event, data: data.join("\n"), id } : null;
}

/**
 * Lag of one event received at `receivedMs`: receipt minus the chain time the frame carries.
 * Market frames carry `timestamp_ms`; price frames carry each price's `as_of_ms` (newest counts).
 * Hop stamps in `provenance.hops` are returned as offsets from the chain time.
 */
export function frameLag(event, receivedMs) {
  const frame = parseFrame(event.data);
  const chain = frame && chainTime(event.event, frame);
  if (!chain) return null;
  const { chainMs, kind } = chain;
  return { kind, lag_ms: receivedMs - chainMs, chain_ms: chainMs, received_ms: receivedMs, cursor: frame.cursor ?? null, hops: hopOffsets(frame, chainMs) };
}

function parseFrame(data) {
  try {
    const frame = JSON.parse(data);
    return frame && typeof frame === "object" ? frame : null;
  } catch {
    return null;
  }
}

/** The chain time a frame carries and the kind it is counted under, or null. */
function chainTime(event, frame) {
  if (event === "market" && Number.isSafeInteger(frame.timestamp_ms)) {
    return { chainMs: frame.timestamp_ms, kind: `market:${frame.type}` };
  }
  if (event !== "prices" || !Array.isArray(frame.prices) || !frame.prices.length) return null;
  const chainMs = Math.max(...frame.prices.map((price) => Number(price.as_of_ms)).filter(Number.isSafeInteger));
  return Number.isFinite(chainMs) ? { chainMs, kind: event } : null;
}

/** `provenance.hops` holds engine wall-clock stamps; `r2_put_ms` is a duration, kept as is. */
function hopOffsets(frame, chainMs) {
  const hops = {};
  const raw = frame.provenance?.hops && typeof frame.provenance.hops === "object" ? frame.provenance.hops : {};
  for (const [key, value] of Object.entries(raw)) {
    if (Number.isSafeInteger(value)) hops[key] = key === "r2_put_ms" ? value : value - chainMs;
  }
  return hops;
}

/** Nearest-rank percentile of `values` (0 < p ≤ 100); null when empty. */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** Count and p50/p95/p99 lag per kind, plus "all". */
export function summarize(samples) {
  // Headline "market" pools every market frame; prices measure price age, not chain-to-screen.
  const groups = new Map([["market", []]]);
  for (const sample of samples) {
    if (sample.kind.startsWith("market:")) groups.get("market").push(sample.lag_ms);
    if (!groups.has(sample.kind)) groups.set(sample.kind, []);
    groups.get(sample.kind).push(sample.lag_ms);
  }
  return Object.fromEntries([...groups].map(([kind, lags]) => [kind, {
    n: lags.length, p50: percentile(lags, 50), p95: percentile(lags, 95), p99: percentile(lags, 99),
  }]));
}
