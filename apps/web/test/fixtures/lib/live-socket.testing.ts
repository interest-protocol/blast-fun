import { resetTabMarketStream } from "#web/components/launchpad/market-stream-hub.ts";
import { LIVE_TICKET_PATH } from "#web/lib/live-stream/live-socket-source.ts";

/**
 * Tests only: the browser's direct market socket without a network. Install
 * it, answer `LIVE_TICKET_PATH` with `liveTicket()` from the test's fetch, and
 * drive each socket with `emit` (one SSE block, as the socket frames them).
 */

export { LIVE_TICKET_PATH };

export const LIVE_SOCKET_URL = "wss://live.blast.test/v1/socket";

export function liveTicket(): Response {
  return Response.json({ url: LIVE_SOCKET_URL, ticket: `t.${"a".repeat(43)}` });
}

export class FakeLiveSocket {
  static readonly OPEN = 1;
  readyState = FakeLiveSocket.OPEN;
  closed = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  readonly url: string;

  constructor(url: string, sockets: FakeLiveSocket[]) {
    this.url = url;
    sockets.push(this);
  }

  /** The query the tab asked the socket for. */
  get query(): URLSearchParams {
    return new URL(this.url).searchParams;
  }

  emit(event: string, data: unknown = {}): void {
    this.onmessage?.({ data: `event: ${event}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n` });
  }

  /** The connection drops; a socket that was not current any more is ignored by its source. */
  drop(code = 1006): void {
    this.closed = true;
    this.onclose?.({ code });
  }

  close(): void {
    this.closed = true;
  }

  /** Every frame the tab sent, in order. */
  readonly sent: string[] = [];

  send(text: string): void {
    this.sent.push(text);
  }

  /** The `set` frames the tab sent, parsed. */
  sets(): { seq: number; pools: string[]; price_coins: string[]; presale: string | null }[] {
    return this.sent.map((text) => JSON.parse(text) as { op?: string }).filter((frame) => frame.op === "set") as ReturnType<FakeLiveSocket["sets"]>;
  }

  /** Answers the newest `set` with the topics it asked for. */
  answerSet(): void {
    const { seq, pools, price_coins, presale } = this.sets().at(-1)!;
    this.emit("set", { seq, ok: true, held: { pools, price_coins, presale } });
  }
}

/**
 * Replaces the global WebSocket, calling `opened` with each new socket; `restore` puts the previous one
 * back and ends the tab's stream, which would otherwise linger into the next test.
 */
export function installLiveSocket(opened?: (socket: FakeLiveSocket) => void): { sockets: FakeLiveSocket[]; restore(): void } {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const sockets: FakeLiveSocket[] = [];
  class WebSocket extends FakeLiveSocket {
    constructor(url: string) {
      super(url, sockets);
      opened?.(this);
    }
  }
  Object.defineProperty(globalThis, "WebSocket", { value: WebSocket, configurable: true, writable: true });
  return {
    sockets,
    restore() {
      resetTabMarketStream();
      if (previous) Object.defineProperty(globalThis, "WebSocket", previous);
      else Reflect.deleteProperty(globalThis, "WebSocket");
    },
  };
}
