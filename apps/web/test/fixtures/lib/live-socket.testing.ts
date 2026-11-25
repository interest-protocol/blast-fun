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

  send(): void {}
}

/** Replaces the global WebSocket, calling `opened` with each new socket; `restore` puts the previous one back. */
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
      if (previous) Object.defineProperty(globalThis, "WebSocket", previous);
      else Reflect.deleteProperty(globalThis, "WebSocket");
    },
  };
}
