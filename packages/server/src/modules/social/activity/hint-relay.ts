import { observeMetric } from "@blast/core/lib/metrics.ts";
import { hintOf } from "@blast/core/modules/live/hint-frames.ts";
import { ACTIVITY_HINT_STREAM_BUDGET } from "@blast/core/modules/backend-api/stream-budget.ts";
import type { WebSocket } from "undici";
import { publicErrorResponse } from "@blast/core/lib/http-errors.ts";
import { hintWebResponse, type HintSink, type HintSubscription } from "../../../lib/hint-subscription.ts";

import { parseInfraProvenance } from "@blast/core/modules/launchpad-contract/provenance.ts";

/** Only the upstream operations this read-only relay needs. */
export interface RelaySocket {
  send(text: string): void;
  close(): void;
  onmessage:
    | ((event: Parameters<NonNullable<WebSocket["onmessage"]>>[0]) => void)
    | null;
  onclose:
    | ((event: Parameters<NonNullable<WebSocket["onclose"]>>[0]) => void)
    | null;
  onerror:
    | ((event: Parameters<NonNullable<WebSocket["onerror"]>>[0]) => void)
    | null;
}

const encoder = new TextEncoder();
const event = (body: unknown) =>
  encoder.encode(`data: ${JSON.stringify(body)}\n\n`);
const PONG = event({ type: "pong" });
const HEARTBEAT = encoder.encode(": keepalive\n\n");
export const ACTIVITY_HINT_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-store",
  "x-accel-buffering": "no",
} as const;

/** One private infra subscription per server process, fanned out to bounded SSE streams. */
// shortcut: sharing is per process, use a dedicated fan-out service if function scaling reaches infra's socket limit.
export class ActivityHintRelay {
  readonly #connect: () => RelaySocket;
  readonly #clients = new Map<HintSink, () => void>();
  #socket: RelaySocket | null = null;
  #hello: Uint8Array | null = null;
  #ready = false;
  #feedPending = false;
  #handshake: ReturnType<typeof setTimeout> | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(connect: () => RelaySocket) {
    this.#connect = connect;
  }

  stream(request: Request): Response {
    return hintWebResponse(
      request.signal,
      (sink) => this.subscribe(request, sink),
      ACTIVITY_HINT_HEADERS,
      { highWaterMark: ACTIVITY_HINT_STREAM_BUDGET.queuedChunks },
    );
  }

  subscribe(request: Request, sink?: HintSink): HintSubscription {
    if (request.signal.aborted)
      return publicErrorResponse(
        "request_cancelled",
        "The request was cancelled.",
        499,
      );
    if (this.#clients.size >= ACTIVITY_HINT_STREAM_BUDGET.maxClients)
      return publicErrorResponse(
        "service_unavailable",
        "This service is temporarily unavailable. Please retry.",
        503,
      );
    if (!sink) return null;
    // Reconnect before the route's 300 s function deadline.
    const deadline = setTimeout(() => stop(), ACTIVITY_HINT_STREAM_BUDGET.lifetimeMs);
    const stop = () => {
      if (!this.#clients.delete(sink)) return;
      clearTimeout(deadline);
      sink.close();
      if (this.#clients.size === 0) this.#disconnect();
    };
    this.#clients.set(sink, stop);
    if (this.#heartbeat === null) {
      const heartbeat = setInterval(() => {
        if (this.#heartbeat === heartbeat) this.#broadcast(HEARTBEAT);
      }, ACTIVITY_HINT_STREAM_BUDGET.heartbeatMs);
      this.#heartbeat = heartbeat;
    }
    if (this.#hello) this.#send(sink, this.#hello);
    if (this.#ready) this.#send(sink, PONG);
    if (!this.#socket) this.#open();
    return stop;
  }

  #send(
    sink: HintSink,
    data: Uint8Array,
  ): void {
    // Covers every emitted frame, including cached hello and heartbeats.
    if (data.byteLength > ACTIVITY_HINT_STREAM_BUDGET.maxChunkBytes) {
      this.#end("oversized_output");
      return;
    }
    // A slow reader must not grow the process's queue without a bound.
    if (!sink.send(data)) this.#clients.get(sink)?.();
  }

  #broadcast(data: Uint8Array): void {
    for (const sink of this.#clients.keys()) this.#send(sink, data);
  }

  #open(): void {
    try {
      const socket = this.#connect();
      this.#socket = socket;
      this.#handshake = setTimeout(() => this.#end("handshake_timeout"), 10_000);
      socket.onclose = () => {
        if (this.#socket === socket) this.#end("upstream_closed");
      };
      socket.onerror = () => {
        if (this.#socket === socket) this.#end("upstream_error");
      };
      socket.onmessage = ({ data }) => {
        if (this.#socket === socket) this.#receive(socket, data);
      };
    } catch {
      this.#end("connect_failed");
    }
  }

  #receive(socket: RelaySocket, data: unknown): void {
    if (
      typeof data !== "string" ||
      data.length > ACTIVITY_HINT_STREAM_BUDGET.maxUpstreamFrameChars
    )
      return this.#end("invalid_frame");
    try {
      const decoded: unknown = JSON.parse(data);
      if (
        decoded === null ||
        typeof decoded !== "object" ||
        Array.isArray(decoded)
      )
        return;
      const frame = decoded as Readonly<Record<string, unknown>>;
      switch (frame.type) {
        case "hello":
          if (!this.#hello) this.#greet(socket, frame);
          return;
        case "pong":
          return this.#pong(socket);
        case "error":
          if (!this.#feedPending) return this.#end("upstream_refused");
          observeMetric("social.hint_relay", { outcome: "unavailable", reason: "feed_refused", clients: this.#clients.size });
          this.#feedPending = false;
          return;
        case "reconnect":
        case "resync_required":
          return this.#end(frame.type);
        case "activity":
        case "presale_lifecycle":
        case "metadata":
          if (this.#ready) this.#hint(frame);
      }
    } catch {
      this.#end("invalid_frame");
    }
  }

  #greet(socket: RelaySocket, frame: Readonly<Record<string, unknown>>): void {
    if (
      frame.protocol !== 1 ||
      parseInfraProvenance(frame.provenance).network !== "mainnet"
    )
      return this.#end("invalid_handshake");
    // Whitelist the handshake: never forward engine diagnostics or arbitrary payloads.
    this.#hello = event({ type: "hello", provenance: frame.provenance });
    this.#broadcast(this.#hello);
    socket.send(JSON.stringify({ op: "subscribe", topics: ["activity"] }));
    socket.send(JSON.stringify({ op: "ping" }));
  }

  #pong(socket: RelaySocket): void {
    if (!this.#hello) return;
    if (this.#ready) {
      this.#feedPending = false;
      return;
    }
    this.#ready = true;
    if (this.#handshake) clearTimeout(this.#handshake);
    this.#handshake = null;
    this.#broadcast(PONG);
    this.#feedPending = true;
    socket.send(JSON.stringify({ op: "subscribe", topics: ["feed"] }));
    socket.send(JSON.stringify({ op: "ping" }));
  }

  #hint(frame: Readonly<Record<string, unknown>>): void {
    const hint = hintOf(frame);
    if (hint) this.#broadcast(event(hint));
  }

  #end(reason: "oversized_output" | "handshake_timeout" | "upstream_closed" | "upstream_error" | "connect_failed" | "invalid_frame" | "upstream_refused" | "feed_refused" | "reconnect" | "resync_required" | "invalid_handshake"): void {
    observeMetric("social.hint_relay", { outcome: "unavailable", reason, clients: this.#clients.size });
    for (const stop of [...this.#clients.values()]) stop();
    this.#disconnect();
  }

  #disconnect(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    if (this.#handshake) clearTimeout(this.#handshake);
    this.#handshake = null;
    const socket = this.#socket;
    this.#socket = null;
    this.#hello = null;
    this.#ready = false;
    this.#feedPending = false;
    if (socket) {
      socket.onclose = socket.onerror = socket.onmessage = null;
      socket.close();
    }
  }
}
