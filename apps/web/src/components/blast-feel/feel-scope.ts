/**
 * The Feel layer's lifecycle discipline, in React idiom.
 *
 * The gate's base build keeps every timer in `BX.timers`, every frame in
 * `BX.rafs` and every listener on one `AbortController`, clears all three in a
 * single `bxStop()`, and reports `window.bxActive()` as the leak check. The
 * Feel lab itself sits outside that discipline: bare `setTimeout`, nine
 * permanent capture listeners on `document`, a ball appended straight to
 * `document.body` (FEEL-LAYER.md §5). Harmless in one document that never
 * unmounts; a leak in an app where every surface mounts and unmounts.
 *
 * A `FeelScope` is that discipline as an object a React effect can own: every
 * timer, frame, listener and stray node goes through it, one `stop()` undoes
 * all of it, and `active()` — plus `feelActive()` across every live scope — is
 * the countable `bxActive()`. `feel-mount.test.ts` proves zero of each after a
 * full mount, use and unmount.
 */

/** The host's timing and frame functions. `window` satisfies this. */
export type FeelScopeHost = {
  setTimeout(handler: () => void, timeout: number): number;
  clearTimeout(id: number): void;
  setInterval(handler: () => void, timeout: number): number;
  clearInterval(id: number): void;
  requestAnimationFrame(callback: (time: number) => void): number;
  cancelAnimationFrame(id: number): void;
};

/** The slice of `EventTarget` the layer attaches to. `document` and `window` satisfy it. */
export type FeelEventTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/** What is still outstanding. Zero on every count is the leak check. */
export type FeelActivity = Readonly<{ scopes: number; timers: number; frames: number; listeners: number; nodes: number }>;

type Attached = { target: FeelEventTarget; type: string; listener: EventListener; options: AddEventListenerOptions };

const live = new Set<FeelScope>();

export class FeelScope {
  readonly #host: FeelScopeHost;
  readonly #timers = new Set<number>();
  readonly #intervals = new Set<number>();
  readonly #frames = new Set<number>();
  readonly #listeners = new Set<Attached>();
  readonly #nodes = new Set<{ remove(): void }>();
  #stopped = false;

  constructor(host: FeelScopeHost) {
    this.#host = host;
    live.add(this);
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  /** One-shot, like `bxAfter`: it deregisters itself before it runs. */
  after(handler: () => void, ms: number): number {
    if (this.#stopped) return 0;
    const id = this.#host.setTimeout(() => {
      this.#timers.delete(id);
      handler();
    }, ms);
    this.#timers.add(id);
    return id;
  }

  /** Repeating, like `bxEvery`. */
  every(handler: () => void, ms: number): number {
    if (this.#stopped) return 0;
    const id = this.#host.setInterval(handler, ms);
    this.#intervals.add(id);
    return id;
  }

  /** Cancels one `after`, like `bxClear`. A null or unknown id is ignored. */
  clear(id: number | null | undefined): void {
    if (id === null || id === undefined || id === 0) return;
    this.#host.clearTimeout(id);
    this.#timers.delete(id);
  }

  /** One frame, like `bxRaf`: it deregisters itself before it runs. */
  raf(callback: (time: number) => void): number {
    if (this.#stopped) return 0;
    const id = this.#host.requestAnimationFrame((time) => {
      this.#frames.delete(id);
      callback(time);
    });
    this.#frames.add(id);
    return id;
  }

  /**
   * One listener, like `bxOn`. Always capture-phase unless told otherwise,
   * because the layer answers a press before the page's own handler runs.
   */
  on<Payload>(target: FeelEventTarget, type: string, listener: (event: Payload) => void, options: AddEventListenerOptions = { capture: true }): () => void {
    if (this.#stopped) return () => undefined;
    const entry: Attached = { target, type, listener: listener as unknown as EventListener, options };
    target.addEventListener(type, entry.listener, options);
    this.#listeners.add(entry);
    return () => {
      if (!this.#listeners.delete(entry)) return;
      target.removeEventListener(type, entry.listener, options);
    };
  }

  /**
   * A node the layer put outside the React tree (the ball). `stop()` removes
   * any that is still there, so an unmount mid-flight leaves nothing behind.
   */
  own(node: { remove(): void }): () => void {
    if (this.#stopped) {
      node.remove();
      return () => undefined;
    }
    this.#nodes.add(node);
    return () => {
      if (!this.#nodes.delete(node)) return;
      node.remove();
    };
  }

  /**
   * Removes every node the layer put outside the React tree (a ball still in
   * flight) and keeps the scope running: a route change (R3-13). The flight's
   * own timer still settles its promise.
   */
  releaseNodes(): void {
    for (const node of this.#nodes) node.remove();
    this.#nodes.clear();
  }

  /** What this scope still holds. */
  active(): Omit<FeelActivity, "scopes"> {
    return {
      timers: this.#timers.size + this.#intervals.size,
      frames: this.#frames.size,
      listeners: this.#listeners.size,
      nodes: this.#nodes.size,
    };
  }

  /** The one `bxStop`: everything this scope holds, released. Idempotent. */
  stop(): void {
    this.#stopped = true;
    for (const id of this.#timers) this.#host.clearTimeout(id);
    this.#timers.clear();
    for (const id of this.#intervals) this.#host.clearInterval(id);
    this.#intervals.clear();
    for (const id of this.#frames) this.#host.cancelAnimationFrame(id);
    this.#frames.clear();
    for (const entry of this.#listeners) entry.target.removeEventListener(entry.type, entry.listener, entry.options);
    this.#listeners.clear();
    for (const node of this.#nodes) node.remove();
    this.#nodes.clear();
    live.delete(this);
  }
}

/**
 * Everything the layer still holds, over every scope that has not stopped —
 * the countable `window.bxActive()`. Zero on every count after a surface
 * unmounts is the leak check.
 */
export function feelActive(): FeelActivity {
  let timers = 0;
  let frames = 0;
  let listeners = 0;
  let nodes = 0;
  for (const scope of live) {
    const one = scope.active();
    timers += one.timers;
    frames += one.frames;
    listeners += one.listeners;
    nodes += one.nodes;
  }
  return { scopes: live.size, timers, frames, listeners, nodes };
}
