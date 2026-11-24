import { parseInfraProvenance } from "@blast/core/modules/launchpad-contract/provenance.ts";

type HintSocket = {
  send(text: string): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  unavailable?: boolean;
};
/** `lost`: the market stream dropped or missed its hello deadline; hint clients use the legacy stream until a new hello. */
type Carrier = { hello: string | null; pong: string | null; lost: boolean };
type Notice = Readonly<{ type: "changed" | "disconnected" }> | Readonly<{ type: "frame"; data: string }>;
let carrier: Carrier | null = null;
const listeners = new Set<(notice: Notice) => void>();
const announce = (notice: Notice) => {
  for (const listener of [...listeners]) listener(notice);
};

/** The chart carries activity hints too. No activity history or cursor is cached here. */
export function beginMarketHints() {
  const owner: Carrier = { hello: null, pong: null, lost: false };
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
          owner.lost = false;
          // Close the legacy connection once the market carrier is usable.
          if (first) announce({ type: "changed" });
        } else if (hint.type === "pong" && owner.hello !== null) {
          owner.pong = data;
        } else if (!owner.pong || !["activity", "presale_lifecycle", "metadata"].includes(String(hint.type))) return;
        announce({ type: "frame", data });
      } catch { /* Invalid hints cannot change transport ownership or paint data. */ }
    },
    disconnected(): void {
      if (carrier !== owner) return;
      owner.hello = owner.pong = null;
      owner.lost = true;
      announce({ type: "disconnected" });
    },
    /** The market stream paused and will start again: hint clients wait for its next hello. */
    waiting(): void {
      if (carrier !== owner) return;
      owner.hello = owner.pong = null;
      owner.lost = false;
      announce({ type: "disconnected" });
    },
    stop(): void {
      if (carrier !== owner) return;
      carrier = null;
      announce({ type: "changed" });
    },
  };
}

const pending = (owner: Carrier | null) => owner !== null && owner.hello === null && !owner.lost;

/**
 * Prefer the market stream's connection; healthy legacy hints remain available during market outages.
 * While a market stream is starting, the legacy stream opens only if its hello misses the deadline.
 */
export function marketHintTransport(url: string, fallback: (url: string) => HintSocket): HintSocket {
  let underlying: HintSocket | null = null;
  let closed = false;
  /** The carrier this socket reads; null on the legacy stream, undefined while still choosing. */
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
    if (closed || selected !== undefined || pending(carrier)) return;
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
      if (cause === "open") {
        socket.close();
        throw error;
      }
      socket.unavailable = true;
      disconnect();
    }
  };
  const notice = (event: Notice) => {
    if (closed) return;
    if (selected === undefined) {
      if (event.type !== "frame") choose("notice");
    } else if (event.type === "frame") {
      if (selected !== null && carrier === selected) socket.onmessage?.({ data: event.data });
    } else if (selected !== (carrier?.hello ? carrier : null)) disconnect();
  };
  listeners.add(notice);
  if (carrier) choose("open");
  // A market stream that starts in this same task (a chart mounting beside this client) is waited for.
  else queueMicrotask(() => choose("wait"));
  return socket;
}
