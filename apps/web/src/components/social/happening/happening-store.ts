import { happeningReadSchema } from "@blast/core/web/contracts/home-read-schemas.ts";
import { PublicError, publicErrorMessage, responseDiagnostic, responseError } from "#web/lib/errors.ts";
import { gatedFetch } from "#web/lib/api-gate-client.ts";
import type { QueryClient } from "@tanstack/react-query";

import { PUBLIC_STALE_MS, getQueryClient } from "#web/lib/query/client.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { HAPPENING_TAPE_MAX, SOCIAL_HAPPENING_DISCOVER_PATH, type HappeningTapeEvent, type SocialHappeningResponse } from "@blast/core/web/contracts/happening.ts";

import { liveFreshness, recordHintPainted } from "../home/activity-hints";
import { browserGapTimers, hintedGap, NEW_POSTS_MIN_GAP_MS, NEW_POSTS_POLL_MS, type FreshnessHint } from "../home/feed-freshness";
import { arrivals, dripGapMs, TAPE_ROWS } from "./happening-model";
import { T3 } from "#web/components/blast-ui/motion-tokens.ts";
import { withoutTestHappening } from "#web/lib/test-launches.ts";

/**
 * Home's live data in the browser: one store per tab shared by the right
 * column, the ≤1219 live card and the recap, which live in different parts of
 * the page (the `@rail` slot and the page). It holds the latest public read
 * and the tape as shown.
 *
 * Refresh is T-012's: the store reads `GET /api/social/happening` when its
 * freshness source signals (the blast-infra activity hint when the tab has
 * one, R3-26, and the 30 s poll while the tab is visible either way), at most
 * once per 5 s, and only while something on the page subscribes. Nothing
 * polls tighter. A hint inside the 5 s is read once the 5 s have passed; a
 * poll signal there is dropped. Nothing is taken from a hint but the cue to
 * read. New tape events then slide in one at a time, oldest first, spread
 * over the interval (the design's tape adds a row every few seconds); with
 * reduced motion they all land at once. A failed read keeps what is shown.
 *
 * Given the page's `QueryClient` (OA-38) every browser read
 * goes through the shared cache (`["blast","public","happening"]`): a second
 * read in flight is the same request, and the first read of a page that had
 * no server read takes an answer under 10 s old (the CDN's) without asking.
 */

export type HappeningSnapshot = Readonly<{
  read: SocialHappeningResponse | null;
  /** Initial failure is distinct from unresolved data; refresh failures keep the valid read. */
  failed?: boolean;
  errorMessage?: string;
  /** The tape as shown, newest first. */
  tape: readonly HappeningTapeEvent[];
  /** Tape events that slid in after the page's first read (they animate in once). */
  arrived: ReadonlySet<string>;
  /** The row the latest arrival pushed out of the visible four, while it collapses (320 ms). */
  leaving: HappeningTapeEvent | null;
}>;

const NONE: ReadonlySet<string> = new Set();
const EMPTY: HappeningSnapshot = Object.freeze({ read: null, tape: [], arrived: NONE, leaving: null });
/** How long a pushed-out row takes to leave (its `happening-row-out`, `--t3`). */
const LEAVE_MS = T3;

/** One public read of Home's happening data; throws on anything but a well-formed 200. */
export async function fetchHappening(signal?: AbortSignal): Promise<SocialHappeningResponse> {
  const response = await gatedFetch(SOCIAL_HAPPENING_DISCOVER_PATH, { headers: { accept: "application/json" }, credentials: "same-origin", signal });
  const body: unknown = await response.json().catch(() => null);
  if (response.status !== 200) throw responseError(body, response, "Live activity could not load. Try again shortly.");
  const parsed = happeningReadSchema.safeParse(body);
  if (!parsed.success) throw new PublicError("Live activity returned an unreadable response. Try again.", { ...responseDiagnostic(response), code: "invalid_response" });
  // The server leaves test sales out of every row (`PUBLIC_PRESALES`); this drops any row whose quote still names Test SUI, with no extra read.
  return withoutTestHappening(parsed.data);
}

export class HappeningStore {
  readonly #source = liveFreshness("happening", NEW_POSTS_POLL_MS);
  readonly #client: QueryClient | null;
  #snapshot: HappeningSnapshot = EMPTY;
  #queue: HappeningTapeEvent[] = [];
  #drip: unknown = null;
  #listeners = new Set<() => void>();
  #watchers = new Set<(previous: SocialHappeningResponse | null, next: SocialHappeningResponse) => void>();
  #off: (() => void) | null = null;
  #controller: AbortController | null = null;
  readonly #gate: ReturnType<typeof hintedGap>;

  constructor(client: QueryClient | null) {
    this.#client = client;
    this.#gate = hintedGap(NEW_POSTS_MIN_GAP_MS, browserGapTimers(), (hint) => void this.refresh(hint));
  }

  readonly getSnapshot = (): HappeningSnapshot => this.#snapshot;

  /** Starts from a server read, unless the store already holds one at least as new. */
  seed(read: SocialHappeningResponse | null): void {
    if (!read) return;
    const current = this.#snapshot.read;
    if (current && current.clock_ms >= read.clock_ms) return;
    this.#queue = [];
    this.#snapshot = { read, tape: read.tape, arrived: NONE, leaving: null };
    // Seeding happens while a page renders: tell watchers after it.
    if (current && this.#watchers.size > 0) queueMicrotask(() => this.#tellWatchers(current, read));
  }

  /**
   * Hears every new read with the one it replaced (the celebration watches
   * for presales that closed funded, §19). Watching never starts reads: only
   * the parts of Home that subscribe do.
   */
  readonly watchReads = (watcher: (previous: SocialHappeningResponse | null, next: SocialHappeningResponse) => void): (() => void) => {
    this.#watchers.add(watcher);
    return () => {
      this.#watchers.delete(watcher);
    };
  };

  #tellWatchers(previous: SocialHappeningResponse | null, next: SocialHappeningResponse): void {
    for (const watcher of this.#watchers) watcher(previous, next);
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) this.#start();
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) this.#stop();
    };
  };

  /** Reads now if the gate allows (a freshness signal); a hinted signal the gate holds reads when it opens. */
  async refresh(hint?: FreshnessHint): Promise<void> {
    if (document.visibilityState !== "visible" || !this.#gate.admit(hint)) return;
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    try {
      const read = await this.#read(controller.signal);
      if (controller.signal.aborted) return;
      this.apply(read);
      if (hint) recordHintPainted("happening", hint);
    } catch (error) {
      if (!controller.signal.aborted && this.#snapshot.read === null) {
        this.#snapshot = { ...this.#snapshot, failed: true, errorMessage: publicErrorMessage(error, "Live activity is unavailable right now. Try again shortly.", "service_unavailable") };
        this.#notify();
      }
      // The next signal reads again; a valid read stays on screen.
    }
  }

  /** One read: through the shared cache when the store has one (a look always asks; the first read takes a fresh answer). */
  #read(signal: AbortSignal): Promise<SocialHappeningResponse> {
    if (this.#client === null) return fetchHappening(signal);
    return this.#client.fetchQuery({
      queryKey: queryKeys.happening(),
      queryFn: () => fetchHappening(),
      staleTime: this.#snapshot.read ? 0 : PUBLIC_STALE_MS,
      retry: false,
    });
  }

  /** Takes a new read: the figures and lists at once, the tape's new events one by one. */
  apply(read: SocialHappeningResponse): void {
    const previous = this.#snapshot.read;
    const shown = this.#snapshot.tape;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true || shown.length === 0) {
      this.#queue = [];
      this.#snapshot = { read, tape: read.tape, arrived: NONE, leaving: null };
    } else {
      const known = [...this.#queue].reverse().concat(shown);
      this.#queue.push(...arrivals(known, read.tape));
      this.#snapshot = { ...this.#snapshot, read };
      this.#scheduleDrip(0);
    }
    this.#notify();
    this.#tellWatchers(previous, read);
  }

  #scheduleDrip(delay: number): void {
    if (this.#drip !== null || this.#queue.length === 0) return;
    this.#drip = window.setTimeout(() => {
      this.#drip = null;
      const next = this.#queue.shift();
      if (!next) return;
      const tape = [next, ...this.#snapshot.tape].slice(0, HAPPENING_TAPE_MAX);
      const arrived = new Set([...this.#snapshot.arrived].filter((id) => tape.some((event) => event.activity_id === id)));
      arrived.add(next.activity_id);
      const leaving = this.#snapshot.tape[TAPE_ROWS - 1] ?? null;
      this.#snapshot = { ...this.#snapshot, tape, arrived, leaving };
      this.#notify();
      if (leaving) {
        window.setTimeout(() => {
          if (this.#snapshot.leaving !== leaving) return;
          this.#snapshot = { ...this.#snapshot, leaving: null };
          this.#notify();
        }, LEAVE_MS);
      }
      this.#scheduleDrip(dripGapMs(this.#queue.length, NEW_POSTS_POLL_MS));
    }, delay);
  }

  #start(): void {
    this.#gate.reset();
    this.#off = this.#source.subscribe((hint) => void this.refresh(hint));
    // Without a server read, read now; with one, the next signal would only repeat it, so the gate starts now.
    if (this.#snapshot.read) this.#gate.admit();
    else void this.refresh();
    this.#scheduleDrip(0);
  }

  #stop(): void {
    this.#off?.();
    this.#off = null;
    this.#gate.cancel();
    this.#controller?.abort();
    if (this.#drip !== null) window.clearTimeout(this.#drip as number);
    this.#drip = null;
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

let shared: HappeningStore | null = null;

/** The tab's store (created on first use in the browser). */
export function happeningStore(): HappeningStore {
  // The browser session's cache; on the server the store only renders its initial snapshot and reads nothing.
  shared ??= new HappeningStore(typeof window === "undefined" ? null : getQueryClient());
  return shared;
}
