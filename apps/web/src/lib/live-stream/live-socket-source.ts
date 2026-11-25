import type { MarketEventSource } from "#web/components/launchpad/market-stream-hub.ts";

/** The browser's stable rollout bucket, 0–99, sent with each ticket request. */
export const LIVE_BUCKET_HEADER = "x-blast-live-bucket";
export const LIVE_TICKET_PATH = "/api/launchpad/market/ticket";
export const LIVE_PROTOCOL = "blast-live.v1";

/** After a per-address refusal or repeated failures, the tab uses the SSE relay this long. */
export const LIVE_FALLBACK_MS = 10 * 60_000;
/** While the socket is off for this browser (204), the tab asks again after this long: one small request per tab per half hour. */
export const LIVE_OFF_MS = 30 * 60_000;
export const LIVE_MAX_FAILURES = 3;
/** Drain (1012) and a full process (4503): the next ticket waits a random 1–30 s so tabs do not return together. */
const SPREAD_CLOSES = new Set([1012, 4503]);
const PER_ADDRESS_REFUSAL = 4429;

export type LiveGrant = Readonly<{ url: string; ticket: string }>;

export type LiveSocketLike = {
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  close(): void;
};

export type LiveSourceDependencies = Readonly<{
  /** null: the socket is off for this browser. Throws when the ticket cannot be read. */
  fetchTicket: () => Promise<LiveGrant | null>;
  openSocket: (url: string, protocols: string[]) => LiveSocketLike;
  openEventSource: (path: string) => MarketEventSource;
  schedule: (run: () => void, ms: number) => () => void;
  now: () => number;
  random: () => number;
}>;

/** Per tab: shared by every source the hub opens. */
export type LiveSourceState = { failures: number; fallbackUntil: number; notBefore: number };

export function liveSourceState(): LiveSourceState {
  return { failures: 0, fallbackUntil: 0, notBefore: 0 };
}

type Listener = (event: { data?: string }) => void;

/** Splits SSE blocks (`event:` and `data:` lines) as EventSource would; comments and empty blocks are skipped. */
export function parseSseBlocks(text: string): { event: string; data: string }[] {
  const blocks: { event: string; data: string }[] = [];
  for (const block of text.split("\n\n")) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data.push(line.slice(6));
      else if (line === "data:") data.push("");
    }
    if (data.length) blocks.push({ event, data: data.join("\n") });
  }
  return blocks;
}

/**
 * A `MarketEventSource` on the direct socket: the same SSE events the relay
 * route sends, so the hub cannot tell them apart. Any close is the hub's
 * "error" and it reconnects as it does for EventSource. The tab falls back to
 * the SSE relay while the socket is off, after a per-address refusal, or
 * after three sockets in a row closed before their first frame.
 */
export function liveMarketSource(path: string, state: LiveSourceState, deps: LiveSourceDependencies): MarketEventSource {
  const listeners = new Map<string, Set<Listener>>();
  let fallback: MarketEventSource | null = null;
  let socket: LiveSocketLike | null = null;
  let cancelWait: (() => void) | null = null;
  let closed = false;

  const emit = (type: string, event: { data?: string }) => {
    for (const listener of [...listeners.get(type) ?? []]) listener(event);
  };
  const openRelay = () => {
    if (closed) return;
    fallback = deps.openEventSource(path);
    for (const [type, set] of listeners) for (const listener of set) fallback.addEventListener(type, listener);
  };
  const fail = (refusedForAddress = false) => {
    if (refusedForAddress || ++state.failures >= LIVE_MAX_FAILURES) {
      state.failures = 0;
      state.fallbackUntil = deps.now() + LIVE_FALLBACK_MS;
    }
  };
  const open = async () => {
    cancelWait = null;
    if (deps.now() < state.fallbackUntil) return openRelay();
    let grant: LiveGrant | null;
    try {
      grant = await deps.fetchTicket();
    } catch {
      if (closed) return;
      fail();
      return emit("error", {});
    }
    if (closed) return;
    if (grant === null) {
      state.fallbackUntil = deps.now() + LIVE_OFF_MS;
      return openRelay();
    }
    let delivered = false;
    const current = deps.openSocket(`${grant.url}${path.slice(path.indexOf("?"))}`, [LIVE_PROTOCOL, `blast-ticket.${grant.ticket}`]);
    socket = current;
    current.onmessage = ({ data }) => {
      if (closed || typeof data !== "string") return;
      delivered = true;
      state.failures = 0;
      for (const block of parseSseBlocks(data)) emit(block.event, { data: block.data });
    };
    current.onclose = ({ code }) => {
      if (socket !== current) return;
      socket = null;
      if (closed) return;
      if (SPREAD_CLOSES.has(code)) state.notBefore = deps.now() + 1_000 + Math.round(deps.random() * 29_000);
      if (code === PER_ADDRESS_REFUSAL) fail(true);
      else if (!delivered) fail();
      emit("error", {});
    };
  };

  const wait = state.notBefore - deps.now();
  if (wait > 0) cancelWait = deps.schedule(() => void open(), wait);
  else void open();

  return {
    addEventListener(type, listener) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(listener);
      fallback?.addEventListener(type, listener);
    },
    close() {
      closed = true;
      cancelWait?.();
      fallback?.close();
      const current = socket;
      socket = null;
      current?.close();
    },
  };
}

/** The browser's WebSocket behind the two handlers the source sets. */
export function browserSocket(url: string, protocols: string[]): LiveSocketLike {
  const ws = new WebSocket(url, protocols);
  const socket: LiveSocketLike = { onmessage: null, onclose: null, close: () => ws.close() };
  ws.onmessage = (event) => socket.onmessage?.(event);
  ws.onclose = (event) => socket.onclose?.(event);
  return socket;
}

const BUCKET_KEY = "blast.live.bucket";

/** This browser's rollout bucket, kept across visits; a fresh one per tab when storage is blocked. */
export function liveBucket(random: () => number = Math.random): number {
  try {
    const stored = localStorage.getItem(BUCKET_KEY);
    if (stored && /^\d{1,2}$/.test(stored)) return Number(stored);
    const bucket = Math.floor(random() * 100);
    localStorage.setItem(BUCKET_KEY, String(bucket));
    return bucket;
  } catch {
    return Math.floor(random() * 100);
  }
}

const TICKET = /^[A-Za-z0-9_-]{1,256}\.[A-Za-z0-9_-]{43}$/;

/** POSTs for a ticket; null on 204 (off for this browser). */
export async function fetchLiveTicket(bucket: number): Promise<LiveGrant | null> {
  const response = await fetch(LIVE_TICKET_PATH, { method: "POST", cache: "no-store", headers: { [LIVE_BUCKET_HEADER]: String(bucket) } });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`ticket ${response.status}`);
  const body = (await response.json()) as { url?: unknown; ticket?: unknown };
  if (typeof body.url !== "string" || !/^wss?:\/\/[^/?#]+\/v1\/socket$/.test(body.url) || typeof body.ticket !== "string" || !TICKET.test(body.ticket)) {
    throw new Error("ticket body");
  }
  return { url: body.url, ticket: body.ticket };
}
