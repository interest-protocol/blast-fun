/**
 * The blast-infra `activity` hint (T-035) as a freshness source (R3-26): Home's
 * live surfaces are signalled after a new commit, claim or lifecycle row,
 * with the existing reader gates controlling when they look.
 *
 * - **Same-origin stream.** The browser reads `/api/social/activity/hints`
 *   over SSE. The server subscribes to infra with its private key; the
 *   stream adapter feeds this client's existing handshake and reconnects.
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
import { gatedEventSource } from "#web/lib/live-stream/gated-event-source.ts";
import { marketHintTransport } from "#web/lib/live-stream/market-hints.ts";
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
  /** Set before `onclose` when no retry can succeed (no service to ask): the client stays on its poll. */
  unavailable?: boolean;
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
type Selected = Pick<FreshnessHint, "presaleId" | "lifecycle" | "coinType" | "catchUp" | "trade">;

function selectedBy(hint: Hint | null): Selected {
  switch (hint?.type) {
    case "activity": {
      const checkpoint = Number(hint.activity_id.split(":", 1)[0]);
      return hint.kind && Number.isSafeInteger(checkpoint)
        ? { trade: { presaleId: hint.presale_id, coinType: hint.coin_type, checkpoint, cursor: hint.activity_id } }
        : {};
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
  /** The refusal came from the socket closing as unavailable (a gate refusal or a busy relay): the tab's return tries once more. */
  #socketRefused = false;
  readonly #seen = new Set<string>();
  readonly #connectionListeners = new Set<() => void>();

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
      this.#socketRefused = false;
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
    if (socket.unavailable && !this.#refused) {
      this.#refused = true;
      this.#socketRefused = true;
      this.#metric({ event: "unavailable", reason: "socket" });
    }
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
    this.#metric(this.#connected ? { event: "reconnect", failures: this.#failures } : { event: "connect" });
    this.#connected = true;
    this.#connectionChanged();
    const catchUp = this.#catchUp;
    this.#catchUp = false;
    this.#look("connect", catchUp ? { catchUp: true } : {});
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
    this.#look("hint", selectedBy(hintOf(frame)));
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
    this.#socketRefused = false;
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
      if (this.#socketRefused) this.#refused = this.#socketRefused = false;
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
  return { name: "activity", subscribe: (signal) => hints.subscribe(surface, signal, accepts) };
}

/** The relay subscribes and pings upstream; the browser transport is read-only. */
export function hintEventStream(url: string): HintSocket {
  const source = gatedEventSource(url);
  const socket: HintSocket = {
    send: () => undefined,
    close: () => {
      source.close();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", resume);
    },
    onmessage: null,
    onclose: null,
  };
  // Hints ignored while hidden are recovered even when no later chain event arrives.
  const resume = () => {
    if (document.visibilityState !== "hidden") socket.onmessage?.({ data: JSON.stringify({ type: "resync_required" }) });
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", resume);
  source.addEventListener("message", (event) => socket.onmessage?.(event as MessageEvent));
  source.addEventListener("error", () => {
    socket.close();
    socket.onclose?.();
  });
  // Refused even after one gate refresh: the client stays on its poll until its surfaces start over.
  source.addEventListener("refused", () => {
    socket.unavailable = true;
    socket.close();
    socket.onclose?.();
  });
  return socket;
}

let tabHints: ActivityHints | null = null;

/** A tab's client of `createSocket`'s streams. */
function tabClient(createSocket: ActivityHintsDependencies["createSocket"]): ActivityHints {
  return new ActivityHints({
    url: "/api/social/activity/hints",
    createSocket,
    now: Date.now,
    setTimeout: (run, ms) => window.setTimeout(run, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    random: Math.random,
    spreadMs: HINT_SPREAD_MS,
    visible: () => document.visibilityState !== "hidden",
    onVisibilityChange: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    metric: recordBrowserHintObservation,
  });
}

/** One same-origin stream per tab, opened by the first subscriber. */
export function tabActivityHints(): ActivityHints | null {
  if (typeof window === "undefined" || typeof EventSource === "undefined") return null;
  // The chart's market stream carries the tab's hints while a coin page holds one.
  return (tabHints ??= tabClient((url) => marketHintTransport(url, hintEventStream)));
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
