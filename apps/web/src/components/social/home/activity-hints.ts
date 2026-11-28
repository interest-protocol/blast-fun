/**
 * The blast-infra `activity` hint (T-035) as a freshness source (R3-26): Home's
 * live surfaces are signalled after a new commit, claim or lifecycle row,
 * with the existing reader gates controlling when they look.
 *
 * - **The live socket.** The browser reads hints from the direct market
 *   socket (`activity=true`): the market stream's own connection while a
 *   screen holds one, else an activity-only socket. The hints process
 *   subscribes to infra with its private key; the adapter feeds this
 *   client's existing handshake and reconnects.
 * - **Mainnet only.** The engine's `hello` must name Sui mainnet in its
 *   `provenance`, or the socket closes and the page stays on its poll.
 * - **Subscribe, then confirm.** After `hello` the client sends
 *   `{"op":"subscribe","topics":["activity"]}` and a `ping`; blast-infra
 *   answers a connection's operations in order, so the `pong` means every
 *   later row will be hinted. Only then does each surface look (`connect`),
 *   because the topic has no snapshot and no resume: a connect or reconnect
 *   learns what it missed only by reading again. An `error` before the `pong`
 *   (an engine without the topic) closes the socket until the surfaces start
 *   over (the next page that wants freshness tries again).
 * - **A hint is a signal, not data.** Every `activity`, `presale_lifecycle`
 *   and `metadata` frame becomes "look now" and nothing else: the surfaces read
 *   their own routes (`GET /api/social/feed/new`, `GET /api/social/happening`,
 *   the coin page). A frame's fields select affected reads and drop a repeat
 *   (`activity_id`, a lifecycle row's `presale_id` and `state`, or a coin
 *   identity change's `coin` and `cursor`, which the relay takes from the
 *   engine's `feed`); a frame of any other shape is still just a signal, so
 *   neither a malformed nor a malicious message can paint anything.
 *   `resync_required` is a look too (`resync`).
 * - **One exception: Home's buy cue** (cue only, never data). A trade hint's
 *   quote atoms, quote coin and dollars (bounded by `hintOf`) reach raw hint
 *   listeners (`subscribeHints`) after the repeat check and before any
 *   coalescer, so Home flashes a priced buy on its row without a read. The
 *   cue is decoration: never a balance, a price or an input to a trade.
 * - **Coalesced per surface:** at most one look per `HINT_GAP_MS`; a burst
 *   looks once at once and once at the end of the second. Each reader's own
 *   5 s floor stays (`hintedGap`).
 * - **Spread across tabs:** one hint reaches every tab at the same moment, so
 *   a browser tab delays an activity, connect or resync look by up to
 *   `HINT_SPREAD_MS` (`spreadMs`), and every tab's reads do not land on the
 *   origin together. Lifecycle and coin identity hints still look at once.
 * - **Background tabs** release their stream and reconnect timers. Returning
 *   tabs reconnect and refresh missed activity and lifecycle reads.
 * - **Reconnect** after any close with full-jitter backoff (a uniform wait
 *   under a ceiling that doubles from 1 s, capped at 30 s), started over once
 *   a socket stayed live `STABLE_MS`.
 *
 * Browser observations use the site's sampled, bounded analytics adapter.
 * A completed refresh is freshness-unverified; it does not prove the hinted
 * update reached the screen. Injected sinks retain the legacy event contract.
 */

import type { MetricFields } from "@blast/core/lib/metrics.ts";
import { compareEventCursors } from "@blast/core/modules/launchpad-contract/cursor.ts";
import { parseInfraProvenance } from "@blast/core/modules/launchpad-contract/provenance.ts";
import { DEPLOYMENT_NETWORKS } from "@blast/core/web/launchpad-read.ts";
import { MARKET_STREAM_BUDGET, MARKET_STREAM_PATH } from "@blast/core/modules/launchpad-contract/market-stream.ts";
import { HELLO_DEADLINE_MS, type MarketEventSource } from "#web/components/launchpad/market-stream-hub.ts";
import { browserLiveSource } from "#web/lib/live-stream/live-socket-source.ts";
import { ACTIVITY_ONLY_GRACE_MS, marketHintTransport, setHintDemand } from "#web/lib/live-stream/market-hints.ts";
import { hintOf, type Hint } from "@blast/core/modules/live/hint-frames.ts";

import { anyFreshness, NEW_POSTS_POLL_MS, pollingFreshness, type FeedFreshnessSource, type FreshnessHint, type FreshnessSignal } from "./feed-freshness";
import { recordBrowserHintObservation } from "./hint-observations";

/** blast-infra's public hint topic. */
export const ACTIVITY_TOPIC = "activity";
/** At most one look per surface per this long, whatever the burst. */
export const HINT_GAP_MS = 1_000;
/** The first reconnect waits under this; each further failure doubles the ceiling. */
export const RECONNECT_BASE_MS = 1_000;
/** No reconnect waits longer. */
export const RECONNECT_CAP_MS = 30_000;
/** A socket live this long was healthy: the next drop starts the backoff over. */
export const STABLE_MS = 10_000;
/** A browser tab spreads its plain looks over this long (`spreadMs`). */
export const HINT_SPREAD_MS = 1_000;
/** How many hinted rows are remembered to drop a repeat. */
const REMEMBERED = 512;
export const ACTIVITY_HINTS_METRIC = "social.activity_hints";

/** The part of a WebSocket the client uses. */
export interface HintSocket {
  send(text: string): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
}

/** What the client needs of the browser; tests pass fakes. */
export type ActivityHintsDependencies = Readonly<{
  url: string;
  /** May throw (a URL the browser refuses): the client then stays off. */
  createSocket: (url: string) => HintSocket;
  now: () => number;
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** Uniform in [0, 1). */
  random: () => number;
  /** A plain look waits a uniform share of this long (default 0: at once). */
  spreadMs?: number;
  visible: () => boolean;
  /** Installed while subscribed; the browser's visibility owns connection lifetime. */
  onVisibilityChange?: (listener: () => void) => () => void;
  /** Reports whether surfaces still need hints, including while the transport is suspended or retrying. */
  setDemand?: (needed: boolean) => void;
  metric: (name: string, fields: MetricFields) => void;
}>;

/** The wait before reconnect number `failures + 1`: full jitter under a doubling ceiling capped at 30 s. */
export function reconnectDelay(failures: number, random: () => number): number {
  const ceiling = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** Math.min(failures, 15));
  return Math.floor(Math.min(Math.max(random(), 0), 1) * ceiling);
}

/** The row a hint names, to drop a repeat; null when the frame does not say. */
function hintKey(frame: Readonly<Record<string, unknown>>): string | null {
  if (frame.type === "activity") return typeof frame.activity_id === "string" ? `a:${frame.activity_id}` : null;
  if (frame.type === "metadata") return typeof frame.cursor === "string" ? `m:${frame.cursor}` : null;
  return typeof frame.presale_id === "string" && typeof frame.state === "string" ? `l:${frame.presale_id}:${frame.state}` : null;
}

/** What of a hint selects reads. */
type Selected = Pick<FreshnessHint, "presaleId" | "lifecycle" | "coinType" | "catchUp" | "reconnect" | "trade">;

function selectedBy(hint: Hint | null): Selected {
  switch (hint?.type) {
    case "activity": {
      const checkpoint = Number(hint.activity_id.split(":", 1)[0]);
      if (!hint.kind || !Number.isSafeInteger(checkpoint)) return {};
      return { trade: {
        presaleId: hint.presale_id,
        coinType: hint.coin_type,
        checkpoint,
        cursor: hint.activity_id,
        kind: hint.kind,
        ...(hint.actor ? { actor: hint.actor } : {}),
        // Home's buy cue (cue only, never data), as `hintOf` bounded them.
        ...(hint.quote_atoms ? { quoteAtoms: hint.quote_atoms } : {}),
        ...(hint.quote_type ? { quoteType: hint.quote_type } : {}),
        ...(hint.usd ? { usd: hint.usd } : {}),
      } };
    }
    case "presale_lifecycle":
      return { presaleId: hint.presale_id, lifecycle: hint.state };
    case "metadata":
      return { coinType: hint.coin };
    default:
      return {};
  }
}

function detach(socket: HintSocket): void {
  socket.onmessage = null;
  socket.onclose = null;
}

/** One surface's subscription and its coalescer. */
type HintFilter = (hint: FreshnessHint) => boolean;
type Surface = {
  name: string;
  signal: FreshnessSignal;
  accepts: HintFilter | undefined;
  last: number;
  kept: { handle: unknown; hint: FreshnessHint } | null;
};

/** The tab's one hint socket, shared by every surface that wants freshness. */
export class ActivityHints {
  readonly #deps: ActivityHintsDependencies;
  readonly #surfaces = new Set<Surface>();
  #socket: HintSocket | null = null;
  /** The current socket waits for `hello`, then for the `pong` that confirms the subscribe, then is live. */
  #phase: "hello" | "subscribing" | "live" = "hello";
  #liveSince: number | null = null;
  /** Closes since the backoff last started over. */
  #failures = 0;
  /** A socket was live since the first surface subscribed: the next live one is a reconnect. */
  #connected = false;
  #retry: unknown = null;
  #offVisibility: (() => void) | null = null;
  #catchUp = false;
  /** The engine refused (not mainnet, no topic) or the browser did: no reconnect until the surfaces start over. */
  #refused = false;
  readonly #seen = new Set<string>();
  readonly #connectionListeners = new Set<() => void>();
  readonly #hintListeners = new Set<(hint: FreshnessHint) => void>();

  /**
   * Every new hint as it arrives: after the repeat check, before any surface's filter or coalescer, so no hint in
   * a burst is lost. For a cue only (Home's buy cue), never data. It does not open the socket: a surface does.
   */
  subscribeHints = (listener: (hint: FreshnessHint) => void): (() => void) => {
    this.#hintListeners.add(listener);
    return () => { this.#hintListeners.delete(listener); };
  };

  connected = (): boolean => this.#socket !== null && this.#phase === "live";
  subscribeConnection = (signal: () => void): (() => void) => {
    this.#connectionListeners.add(signal);
    return () => { this.#connectionListeners.delete(signal); };
  };

  #connectionChanged(): void {
    for (const signal of this.#connectionListeners) signal();
  }

  constructor(dependencies: ActivityHintsDependencies) {
    this.#deps = dependencies;
  }

  /** A surface's subscription: the socket opens with the first and closes with the last. */
  subscribe(name: string, signal: FreshnessSignal, accepts?: HintFilter): () => void {
    const surface: Surface = { name, signal, accepts, last: Number.NEGATIVE_INFINITY, kept: null };
    this.#surfaces.add(surface);
    if (this.#surfaces.size === 1) {
      this.#refused = false;
      this.#deps.setDemand?.(true);
      this.#catchUp = this.#deps.onVisibilityChange !== undefined && !this.#deps.visible();
      this.#offVisibility = this.#deps.onVisibilityChange?.(() => this.#visibilityChanged()) ?? null;
      this.#connect();
    }
    return () => {
      if (!this.#surfaces.delete(surface)) return;
      if (surface.kept) this.#deps.clearTimeout(surface.kept.handle);
      surface.kept = null;
      if (this.#surfaces.size === 0) this.#shut();
    };
  }

  /** Whether a socket is open or a reconnect waits: false once the last surface left. */
  active(): boolean {
    return this.#socket !== null || this.#retry !== null;
  }

  /** Whether no surface is subscribed. */
  idle(): boolean {
    return this.#surfaces.size === 0;
  }

  #metric(fields: MetricFields): void {
    try { this.#deps.metric(ACTIVITY_HINTS_METRIC, fields); } catch { /* Observations do not own connection or refresh work. */ }
  }

  #connect(): void {
    this.#retry = null;
    if (this.#surfaces.size === 0 || this.#refused || this.#socket !== null || !this.#deps.visible()) return;
    let socket: HintSocket;
    try {
      socket = this.#deps.createSocket(this.#deps.url);
    } catch {
      return this.#refuse("socket");
    }
    this.#socket = socket;
    this.#phase = "hello";
    this.#liveSince = null;
    socket.onmessage = (event) => this.#receive(socket, event.data);
    socket.onclose = () => this.#closed(socket);
  }

  #closed(socket: HintSocket): void {
    detach(socket);
    if (this.#socket !== socket) return;
    this.#socket = null;
    this.#connectionChanged();
    if (this.#surfaces.size === 0 || this.#refused || !this.#deps.visible()) return;
    if (this.#liveSince !== null && this.#deps.now() - this.#liveSince >= STABLE_MS) this.#failures = 0;
    const delay = reconnectDelay(this.#failures, this.#deps.random);
    this.#failures += 1;
    const retry = this.#deps.setTimeout(() => {
      if (this.#retry === retry) this.#connect();
    }, delay);
    this.#retry = retry;
  }

  #receive(socket: HintSocket, data: unknown): void {
    if (this.#socket !== socket) return;
    let frame: unknown;
    try {
      frame = JSON.parse(String(data));
    } catch {
      return;
    }
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return;
    const message = frame as Readonly<Record<string, unknown>>;
    switch (message.type) {
      case "hello":
        return this.#hello(socket, message);
      case "pong":
        if (this.#phase === "subscribing") this.#live();
        return;
      case "error":
        if (this.#phase === "subscribing") this.#refuse("subscribe");
        return;
      case "resync_required":
        if (this.#phase !== "hello") this.#look("resync");
        return;
      case "activity":
      case "presale_lifecycle":
      case "metadata":
        if (this.#phase !== "hello") this.#hint(message);
        return;
      default:
        return;
    }
  }

  #hello(socket: HintSocket, hello: Readonly<Record<string, unknown>>): void {
    if (this.#phase !== "hello") return;
    let network: string | null;
    try {
      network = parseInfraProvenance(hello.provenance).network;
    } catch {
      return this.#refuse("hello");
    }
    if (network === null || !(DEPLOYMENT_NETWORKS as readonly string[]).includes(network)) return this.#refuse("network");
    this.#phase = "subscribing";
    socket.send(JSON.stringify({ op: "subscribe", topics: [ACTIVITY_TOPIC] }));
    socket.send(JSON.stringify({ op: "ping" }));
  }

  #live(): void {
    this.#phase = "live";
    this.#liveSince = this.#deps.now();
    const reconnect = this.#connected;
    this.#metric(reconnect ? { event: "reconnect", failures: this.#failures } : { event: "connect" });
    this.#connected = true;
    this.#connectionChanged();
    const catchUp = this.#catchUp;
    this.#catchUp = false;
    this.#look("connect", { ...(catchUp ? { catchUp: true } : {}), ...(reconnect ? { reconnect: true } : {}) });
  }

  #hint(frame: Readonly<Record<string, unknown>>): void {
    const key = hintKey(frame);
    if (key !== null) {
      if (this.#seen.has(key)) return;
      this.#seen.add(key);
      if (this.#seen.size > REMEMBERED) this.#seen.delete(this.#seen.values().next().value as string);
    }
    this.#metric({ event: "hint", kind: String(frame.type) });
    // A malformed hint is still a look; only a well-formed one selects reads.
    const selected = selectedBy(hintOf(frame));
    if (this.#deps.visible() && this.#hintListeners.size > 0) {
      const hint: FreshnessHint = Object.freeze({ atMs: this.#deps.now(), cause: "hint", ...selected });
      for (const listener of this.#hintListeners) {
        try { listener(hint); } catch { /* A cue's failure never costs a surface its look. */ }
      }
    }
    this.#look("hint", selected);
  }

  /** Tells every surface to look, through its coalescer. */
  #look(cause: FreshnessHint["cause"], selected: Selected = {}): void {
    if (!this.#deps.visible()) return;
    const hint: FreshnessHint = Object.freeze({ atMs: this.#deps.now(), cause, ...selected });
    for (const surface of this.#surfaces) {
      if (!surface.accepts || surface.accepts(hint)) this.#offer(surface, hint);
    }
  }

  /** At most one look per `HINT_GAP_MS`: now if the gap passed, else once at its end. */
  #offer(surface: Surface, hint: FreshnessHint): void {
    // A phase change must reach the query cache even inside an activity burst.
    if (surface.name === "queries" && hint.presaleId) return this.#tell(surface, hint);
    // So must a coin's identity change reach every surface: a coalesced look would carry
    // the burst's first hint, and the coin page acts on its own coin's hint alone.
    if (hint.coinType) return this.#tell(surface, hint);
    if (surface.kept) {
      // A scoped trade reader can share the latest checkpoint's cached read.
      const keptTrade = surface.kept.hint.trade;
      if (surface.accepts && hint.trade && (!keptTrade || compareEventCursors(hint.trade.cursor, keptTrade.cursor) > 0)) {
        surface.kept.hint = hint;
      }
      return;
    }
    const gap = surface.last + HINT_GAP_MS - this.#deps.now();
    const spread = this.#deps.spreadMs ?? 0;
    const wait = gap > 0 || spread === 0 ? gap : Math.floor(Math.min(Math.max(this.#deps.random(), 0), 1) * spread);
    if (wait <= 0) return this.#tell(surface, hint);
    const kept = { hint, handle: this.#deps.setTimeout(() => {
      if (surface.kept !== kept) return;
      surface.kept = null;
      if (this.#surfaces.has(surface)) this.#tell(surface, kept.hint);
    }, wait) };
    surface.kept = kept;
  }

  #tell(surface: Surface, hint: FreshnessHint): void {
    if (!this.#deps.visible()) return;
    surface.last = this.#deps.now();
    this.#metric({ event: "refetch", surface: surface.name, cause: hint.cause });
    surface.signal(hint);
  }

  /** The engine or the browser refused: close, and stay on the poll until the surfaces start over. */
  #refuse(reason: "socket" | "hello" | "network" | "subscribe"): void {
    this.#refused = true;
    this.#deps.setDemand?.(false);
    this.#metric({ event: "unavailable", reason });
    const socket = this.#socket;
    this.#socket = null;
    this.#connectionChanged();
    if (socket) {
      detach(socket);
      socket.close();
    }
  }

  #visibilityChanged(): void {
    if (this.#deps.visible()) {
      if (this.#retry === null) this.#connect();
      return;
    }
    this.#catchUp = true;
    this.#suspend();
    for (const surface of this.#surfaces) {
      if (surface.kept) this.#deps.clearTimeout(surface.kept.handle);
      surface.kept = null;
      surface.last = Number.NEGATIVE_INFINITY;
    }
  }

  /** Suspension keeps subscriptions and refusal/backoff state for visible recovery. */
  #suspend(): void {
    if (this.#retry !== null) this.#deps.clearTimeout(this.#retry);
    this.#retry = null;
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      detach(socket);
      socket.close();
      this.#connectionChanged();
    }
    this.#phase = "hello";
    this.#liveSince = null;
  }

  /** The last surface left: no socket, no timer, nothing remembered. */
  #shut(): void {
    this.#deps.setDemand?.(false);
    this.#offVisibility?.();
    this.#offVisibility = null;
    this.#suspend();
    this.#failures = 0;
    this.#connected = false;
    this.#catchUp = false;
    this.#seen.clear();
  }
}

/** One surface's view of the hint socket, as a freshness source. */
export function activityHints(surface: string, hints: ActivityHints, accepts?: HintFilter): FeedFreshnessSource {
  return { name: "activity", subscribe: (signal) => hints.subscribe(surface, signal, accepts), hints: hints.subscribeHints };
}

/**
 * The socket's hint events as a hint socket. The hints process subscribes and pings upstream, so `send` does
 * nothing. Like the market hub, it gives up on a socket with no first frame within the hello deadline or no
 * frame within the heartbeat timeout after it: a half-open socket closes and the client reconnects.
 */
export function socketHintStream(source: MarketEventSource, schedule: (run: () => void, ms: number) => () => void): HintSocket {
  let ended = false;
  let cancel: (() => void) | null = null;
  const stop = (failed: boolean) => {
    ended = true;
    cancel?.();
    cancel = null;
    source.close(failed);
  };
  const end = (failed = false) => {
    if (ended) return;
    stop(failed);
    socket.onclose?.();
  };
  const expect = (ms: number) => {
    if (ended) return;
    cancel?.();
    cancel = schedule(() => end(true), ms);
  };
  const socket: HintSocket = { send: () => undefined, close: () => { if (!ended) stop(false); }, onmessage: null, onclose: null };
  expect(HELLO_DEADLINE_MS);
  source.addEventListener("heartbeat", () => expect(MARKET_STREAM_BUDGET.heartbeatTimeoutMs));
  source.addEventListener("hint", (event) => {
    expect(MARKET_STREAM_BUDGET.heartbeatTimeoutMs);
    socket.onmessage?.({ data: event.data });
  });
  // A drop, or a socket that is off or backing off: the client retries with its own backoff, and the source
  // answers at once without a ticket until its wait ends.
  source.addEventListener("error", () => end());
  source.addEventListener("refused", () => end());
  return socket;
}

/** The activity-only query on the market socket. */
export const ACTIVITY_SOCKET_PATH = `${MARKET_STREAM_PATH}?activity=true`;

let tabHints: ActivityHints | null = null;

/** A tab's client of `createSocket`'s streams. */
function tabClient(createSocket: ActivityHintsDependencies["createSocket"]): ActivityHints {
  return new ActivityHints({
    url: ACTIVITY_SOCKET_PATH,
    createSocket,
    now: Date.now,
    setTimeout: (run, ms) => window.setTimeout(run, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    random: Math.random,
    spreadMs: HINT_SPREAD_MS,
    setDemand: setHintDemand,
    visible: () => document.visibilityState !== "hidden",
    onVisibilityChange: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    metric: recordBrowserHintObservation,
  });
}

/** One hint socket per tab, opened by the first subscriber. */
export function tabActivityHints(): ActivityHints | null {
  if (typeof window === "undefined" || typeof WebSocket === "undefined") return null;
  // The chart's market stream carries the tab's hints while a coin page holds one.
  return (tabHints ??= tabClient((url) => marketHintTransport(url, (path) => socketHintStream(browserLiveSource(path), (run, ms) => {
    const timer = window.setTimeout(run, ms);
    return () => window.clearTimeout(timer);
  }), (run) => void window.setTimeout(run, ACTIVITY_ONLY_GRACE_MS))));
}

/**
 * A live surface's freshness: `anyFreshness(activityHints(…), pollingFreshness(…))`
 * when the tab has a hint socket, the poll alone otherwise. `surface` names it
 * in the metrics.
 */
export function liveFreshness(surface: string, pollMs = NEW_POSTS_POLL_MS, accepts?: HintFilter): FeedFreshnessSource {
  const hints = tabActivityHints();
  const poll = pollingFreshness(pollMs);
  return hints === null ? poll : anyFreshness(activityHints(surface, hints, accepts), poll);
}

/**
 * Observes a successful hinted refresh at the next frame, not proof that its
 * response contains the hinted update. The observation reports refresh completion.
 */
export function recordHintPainted(
  surface: string,
  hint: FreshnessHint | undefined,
): void {
  try {
    if (hint?.cause !== "hint") return;
    const frame = (run: () => void) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => run()) : run());
    frame(() => {
      try { recordBrowserHintObservation(ACTIVITY_HINTS_METRIC, { event: "painted", surface, ms: Math.max(0, Date.now() - hint.atMs) }); } catch { /* Observation failures cannot change refresh results. */ }
    });
  } catch { /* A frame scheduler or observation clock may be unavailable. */ }
}
