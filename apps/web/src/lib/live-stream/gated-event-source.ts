import { refreshGate } from "#web/lib/api-gate-client.ts";

/** The part of a browser `EventSource` this module drives. */
export type EventSourceLike = Pick<EventSource, "addEventListener" | "close" | "readyState">;

export type GatedEventSourceDependencies = {
  create: (url: string) => EventSourceLike;
  refresh: () => Promise<boolean>;
};

/** `EventSource.CLOSED`, which a server-side import cannot read from the global. */
const CLOSED = 2;

const browser: GatedEventSourceDependencies = {
  create: (url) => new EventSource(url),
  refresh: refreshGate,
};

/**
 * A same-origin stream that recovers from the API gate's 401 (a tab open past
 * the cookie's two hours). EventSource never shows the status: a refused open
 * is an `error` with the source CLOSED before any `open`. That runs
 * `GET /api/gate` once and reopens the stream once.
 *
 * Listeners see two kinds of end:
 * - `error`: a drop after the stream opened; the caller reconnects with its backoff.
 * - `refused`: the refresh failed, or the reopened stream was refused too.
 *   The caller stops, so a tab never loops on 401s.
 */
export function gatedEventSource(url: string, deps: GatedEventSourceDependencies = browser) {
  const listeners: [string, (event: Event) => void][] = [];
  const ends = { error: new Set<() => void>(), refused: new Set<() => void>() };
  let source = deps.create(url);
  let opened = false;
  let refreshed = false;
  let closed = false;

  const end = (kind: keyof typeof ends) => {
    for (const listener of [...ends[kind]]) if (!closed) listener();
  };

  const failed = async (failing: EventSourceLike): Promise<void> => {
    if (closed || failing !== source) return;
    if (opened || failing.readyState !== CLOSED) return end("error");
    failing.close();
    if (refreshed) return end("refused");
    refreshed = true;
    const renewed = await deps.refresh();
    if (closed || failing !== source) return;
    if (!renewed) return end("refused");
    source = deps.create(url);
    attach(source);
  };

  const attach = (target: EventSourceLike) => {
    target.addEventListener("open", () => {
      if (target === source) opened = true;
    });
    target.addEventListener("error", () => void failed(target));
    for (const [type, listener] of listeners) target.addEventListener(type, listener);
  };
  attach(source);

  return {
    addEventListener(type: string, listener: (event: Event) => void): void {
      if (type === "error" || type === "refused") {
        ends[type].add(() => listener(new Event(type)));
        return;
      }
      listeners.push([type, listener]);
      source.addEventListener(type, listener);
    },
    close(): void {
      closed = true;
      source.close();
    },
  };
}
