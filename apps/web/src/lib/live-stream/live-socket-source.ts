import type { MarketEventSource } from "#web/components/launchpad/market-stream-hub.ts";

export const LIVE_TICKET_PATH = "/api/launchpad/market/ticket";
export const LIVE_PROTOCOL = "blast-live.v1";

/** After a per-address refusal or repeated failures, the tab asks for no ticket this long (times 1–1.5, see `spreadWait`): one minute, so a refused tab streams again soon. */
export const LIVE_BACKOFF_MS = 60_000;
/** While the socket is off (the ticket route answers 204), the tab asks again after this long (times 1–1.5): one small request per tab per half hour. */
export const LIVE_OFF_MS = 30 * 60_000;
export const LIVE_MAX_FAILURES = 3;
/** A ticket not answered by then is a failure, like a socket that never speaks. */
export const LIVE_TICKET_TIMEOUT_MS = 10_000;

/** A long wait stretched by a random 0–50%, so tabs that failed together do not return together. */
export function spreadWait(ms: number, random: () => number): number {
  return Math.round(ms * (1 + random() / 2));
}
/** Drain (1012) and a full process (4503): the next ticket waits a random 1–9 s so tabs do not return together (under the hub's 10 s hello deadline). */
const SPREAD_CLOSES = new Set([1012, 4503]);
const PER_ADDRESS_REFUSAL = 4429;

export type LiveGrant = Readonly<{ url: string; ticket: string }>;

export type LiveSocketLike = {
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  close(): void;
  /** False unless the socket is open. */
  send(text: string): boolean;
};

export type LiveSourceDependencies = Readonly<{
  /** null: the socket is off. Throws when the ticket cannot be read. */
  fetchTicket: () => Promise<LiveGrant | null>;
  openSocket: (url: string, protocols: string[]) => LiveSocketLike;
  schedule: (run: () => void, ms: number) => () => void;
  now: () => number;
  random: () => number;
}>;

/** Per tab: shared by every source the tab opens. `offUntil`: no ticket is asked for before this. */
export type LiveSourceState = { failures: number; offUntil: number; notBefore: number };

export function liveSourceState(): LiveSourceState {
  return { failures: 0, offUntil: 0, notBefore: 0 };
}

type Listener = (event: { data?: string }) => void;

/** Splits the socket's SSE blocks (`event: ` and `data: ` lines, `\n` endings); other lines and empty blocks are skipped. */
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
 * A `MarketEventSource` on the direct socket, which frames its events as SSE
 * blocks. Any close is an `error`, and the caller reconnects with its backoff.
 * While the socket is off, after a per-address refusal, or after three sockets
 * in a row closed before their first frame, the tab asks for no ticket for a
 * while: each source opened then sends `refused`, whose data is the wait in
 * milliseconds, and the tab has no stream until it ends.
 */
export function liveMarketSource(path: string, state: LiveSourceState, deps: LiveSourceDependencies): MarketEventSource {
  const listeners = new Map<string, Set<Listener>>();
  let socket: LiveSocketLike | null = null;
  let cancelWait: (() => void) | null = null;
  let closed = false;
  /** This attempt asked for a ticket but its socket sent nothing yet: a close now, by either side or at the caller's deadline, counts as a failure. */
  let silent = false;

  const emit = (type: string, event: { data?: string }) => {
    for (const listener of [...listeners.get(type) ?? []]) listener(event);
  };
  const refuse = () => {
    if (!closed) emit("refused", { data: String(Math.max(0, state.offUntil - deps.now())) });
  };
  const fail = (refusedForAddress = false) => {
    if (refusedForAddress || ++state.failures >= LIVE_MAX_FAILURES) {
      state.failures = 0;
      state.offUntil = deps.now() + spreadWait(LIVE_BACKOFF_MS, deps.random);
    }
  };
  const open = async () => {
    cancelWait = null;
    if (deps.now() < state.offUntil) {
      // The caller adds its listeners after this source returns.
      await Promise.resolve();
      return refuse();
    }
    silent = true;
    let grant: LiveGrant | null;
    try {
      grant = await deps.fetchTicket();
    } catch {
      if (closed) return;
      silent = false;
      fail();
      return emit("error", {});
    }
    if (closed) return;
    if (grant === null) {
      silent = false;
      state.offUntil = deps.now() + spreadWait(LIVE_OFF_MS, deps.random);
      return refuse();
    }
    let current: LiveSocketLike;
    try {
      current = deps.openSocket(`${grant.url}${path.slice(path.indexOf("?"))}`, [LIVE_PROTOCOL, `blast-ticket.${grant.ticket}`]);
    } catch {
      silent = false;
      fail();
      return emit("error", {});
    }
    socket = current;
    /** Render's edge delivers custom close codes as 1005, so the server names its code in a last `close` frame. */
    let named: number | null = null;
    current.onmessage = ({ data }) => {
      if (closed || typeof data !== "string") return;
      for (const block of parseSseBlocks(data)) {
        if (block.event === "close") {
          named = closeCode(block.data);
          continue;
        }
        // A pong answers our own clock ping, and `connecting` comes before the upstream answers: neither proves the stream works.
        if (block.event !== "pong" && !(block.event === "status" && isConnecting(block.data))) {
          silent = false;
          state.failures = 0;
        }
        emit(block.event, { data: block.data });
      }
    };
    current.onclose = (event) => {
      const code = named ?? event.code;
      if (socket !== current) return;
      socket = null;
      if (closed) return;
      if (SPREAD_CLOSES.has(code)) state.notBefore = deps.now() + 1_000 + Math.round(deps.random() * 8_000);
      if (code === PER_ADDRESS_REFUSAL) fail(true);
      else if (silent) fail();
      silent = false;
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
    },
    close(failed) {
      // The caller gave up on a socket that never spoke (a hello or heartbeat deadline): a hung network counts as a failure too.
      if (failed && silent && !closed) fail();
      silent = false;
      closed = true;
      cancelWait?.();
      const current = socket;
      socket = null;
      current?.close();
    },
    send: (text) => !closed && socket?.send(text) === true,
  };
}

function isConnecting(data: string): boolean {
  try {
    return (JSON.parse(data) as { state?: unknown }).state === "connecting";
  } catch {
    return false;
  }
}

function closeCode(data: string): number | null {
  try {
    const { code } = JSON.parse(data) as { code?: unknown };
    return Number.isInteger(code) ? (code as number) : null;
  } catch {
    return null;
  }
}

/** The browser's WebSocket behind the two handlers the source sets. */
export function browserSocket(url: string, protocols: string[]): LiveSocketLike {
  const ws = new WebSocket(url, protocols);
  const socket: LiveSocketLike = {
    onmessage: null,
    onclose: null,
    close: () => ws.close(),
    /** False unless the socket is open; the clock pings stop on false. */
    send: (text: string) => ws.readyState === WebSocket.OPEN && (ws.send(text), true),
  };
  ws.onmessage = (event) => socket.onmessage?.(event);
  ws.onclose = (event) => socket.onclose?.(event);
  return socket;
}

const TICKET = /^[A-Za-z0-9_-]{1,256}\.[A-Za-z0-9_-]{43}$/;

/** POSTs for a ticket; null on 204 (the socket is off). Throws after `timeoutMs` without an answer. */
export async function fetchLiveTicket(timeoutMs = LIVE_TICKET_TIMEOUT_MS): Promise<LiveGrant | null> {
  const response = await fetch(LIVE_TICKET_PATH, { method: "POST", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`ticket ${response.status}`);
  const body = (await response.json()) as { url?: unknown; ticket?: unknown };
  if (typeof body.url !== "string" || !/^wss?:\/\/[^/?#]+\/v1\/socket$/.test(body.url) || typeof body.ticket !== "string" || !TICKET.test(body.ticket)) {
    throw new Error("ticket body");
  }
  return { url: body.url, ticket: body.ticket };
}

let tabState: LiveSourceState | null = null;

/** A source on the browser's socket. Every source in the tab shares one failure count and wait. */
export function browserLiveSource(path: string, onSocket?: (socket: ReturnType<typeof browserSocket>) => void): MarketEventSource {
  return liveMarketSource(path, (tabState ??= liveSourceState()), {
    fetchTicket: () => fetchLiveTicket(),
    openSocket: (url, protocols) => {
      const socket = browserSocket(url, protocols);
      onSocket?.(socket);
      return socket;
    },
    schedule: (run, ms) => {
      const timer = window.setTimeout(run, ms);
      return () => window.clearTimeout(timer);
    },
    now: Date.now,
    random: Math.random,
  });
}
