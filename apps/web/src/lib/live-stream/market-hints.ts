import { parseInfraProvenance } from "@blast/core/modules/launchpad-contract/provenance.ts";

type HintSocket = {
  send(text: string): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
};
/**
 * The market stream's handshake: while it has no hello, hint clients wait for it (it reconnects with its own backoff).
 * `onDemandLost`: told when the tab stops requesting hints, so a stream kept open only for hints can close.
 */
type Carrier = { hello: string | null; pong: string | null; onDemandLost?: () => void };
type Notice = Readonly<{ type: "changed" | "disconnected" }> | Readonly<{ type: "frame"; data: string }>;
let carrier: Carrier | null = null;
let hintDemand = false;
const listeners = new Set<(notice: Notice) => void>();
const announce = (notice: Notice) => {
  for (const listener of [...listeners]) listener(notice);
};

/** The tab's hint client still needs a carrier while hidden or waiting to retry. */
export function hasHintDemand(): boolean {
  return hintDemand;
}

export function setHintDemand(needed: boolean): void {
  if (hintDemand === needed) return;
  hintDemand = needed;
  if (!needed) carrier?.onDemandLost?.();
}

/** The chart carries activity hints too. No activity history or cursor is cached here. */
export function beginMarketHints(onDemandLost?: () => void) {
  const owner: Carrier = { hello: null, pong: null, onDemandLost };
  carrier = owner;
  announce({ type: "changed" });
  return {
    frame(data: string): void {
      if (carrier !== owner || data.length > 1_024) return;
      try {
        const hint = JSON.parse(data) as Record<string, unknown>;
        if (hint.type === "hello") {
          if (parseInfraProvenance(hint.provenance).network !== "mainnet") return;
          const first = owner.hello === null;
          owner.hello = data;
          owner.pong = null;
          // Close the activity-only socket once the market carrier is usable.
          if (first) announce({ type: "changed" });
        } else if (hint.type === "pong" && owner.hello !== null) {
          owner.pong = data;
        } else if (!owner.pong || !["activity", "presale_lifecycle", "metadata"].includes(String(hint.type))) return;
        announce({ type: "frame", data });
      } catch { /* Invalid hints cannot change transport ownership or paint data. */ }
    },
    /** The market stream dropped, paused or was refused and will start again: hint clients wait for its next hello. */
    disconnected(): void {
      if (carrier !== owner) return;
      owner.hello = owner.pong = null;
      announce({ type: "disconnected" });
    },
    stop(): void {
      if (carrier !== owner) return;
      carrier = null;
      announce({ type: "changed" });
    },
  };
}

/**
 * How long a hint client with no market stream waits before it opens the activity-only socket. A page whose
 * market stream starts a moment after its hint client (Home subscribes its prices once its rows render)
 * then opens one socket, not an activity-only one closed before it connects.
 */
export const ACTIVITY_ONLY_GRACE_MS = 1_000;

/**
 * While the tab has a market stream, hints ride it, and a client waits for its hello however long it takes:
 * the tab never holds two sockets. The activity-only socket opens only while no market stream exists.
 */
export function marketHintTransport(
  url: string,
  fallback: (url: string) => HintSocket,
  wait: (run: () => void) => void = (run) => void setTimeout(run, ACTIVITY_ONLY_GRACE_MS),
): HintSocket {
  let underlying: HintSocket | null = null;
  let closed = false;
  /** The carrier this socket reads; null on the activity-only socket, undefined while still choosing. */
  let selected: Carrier | null | undefined;
  const socket: HintSocket = {
    send: () => undefined,
    close: () => {
      if (closed) return;
      closed = true;
      listeners.delete(notice);
      underlying?.close();
      underlying = null;
    },
    onmessage: null,
    onclose: null,
  };
  const disconnect = () => {
    if (closed) return;
    const notify = socket.onclose;
    socket.close();
    notify?.();
  };
  /** `notice`: the carrier's hello just arrived, and its frame follows; otherwise the handshake is replayed. */
  const choose = (cause: "open" | "wait" | "notice") => {
    if (closed || selected !== undefined || (carrier !== null && carrier.hello === null)) return;
    if (carrier?.hello) {
      const owner = carrier;
      selected = owner;
      if (cause === "notice") return;
      // Dependencies assign the logical socket's callbacks after this function returns.
      queueMicrotask(() => {
        if (closed || carrier !== owner || !owner.hello) return;
        socket.onmessage?.({ data: owner.hello });
        if (owner.pong) socket.onmessage?.({ data: owner.pong });
      });
      return;
    }
    selected = null;
    try {
      underlying = fallback(url);
      underlying.onmessage = (event) => socket.onmessage?.(event);
      underlying.onclose = disconnect;
    } catch (error) {
      if (cause !== "open") return disconnect();
      socket.close();
      throw error;
    }
  };
  const notice = (event: Notice) => {
    if (closed) return;
    if (selected === undefined) {
      if (event.type !== "frame") choose("notice");
    } else if (event.type === "frame") {
      if (selected !== null && carrier === selected) socket.onmessage?.({ data: event.data });
    } else if (selected === null ? carrier !== null : selected !== carrier || !carrier.hello) {
      // A market stream began (close the activity-only socket and wait for its hello), or the carrier dropped or changed.
      disconnect();
    }
  };
  listeners.add(notice);
  if (carrier) choose("open");
  // A market stream that starts within the grace (a chart or price list mounting beside this client) is waited for.
  else wait(() => choose("wait"));
  return socket;
}
