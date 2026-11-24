/**
 * The commit quote's reads (R3-54; FEATURE-MAP-R3 §15.8 "the product needs a
 * debounced or cached commit-quote rather than one call per keystroke").
 *
 * The quote itself is arithmetic: `commit/quote.ts` turns a sale, the viewer
 * and an amount into the tokens, the allocation and the refusal, with no
 * request at all. What moves under it is the **facts** — the sale's raise,
 * its lifecycle, its minimum and cap, the viewer's own position and balances —
 * and those are what this source reads. The gate calls `quoteCommit` on every
 * preset press and again at confirm; the product reads the facts at most once
 * per `maxAgeMs` per sale, however fast the amount changes:
 *
 * - **cached**: `want` reuses an answer younger than `maxAgeMs` and asks
 *   nothing (a preset press, a keystroke);
 * - **debounced**: a stale answer is re-read `debounceMs` after the last
 *   change, not once per change (`now: true` skips the wait — arming, and a
 *   composer that has nothing to show yet);
 * - **one in flight**: a change while a read is out does not start another —
 *   the read that lands is fresh by definition;
 * - **the last read wins**: a read that started earlier and answers later
 *   never overwrites a newer one (`refresh` can start a read while an older
 *   one is out);
 * - **at confirm**, `fresh` resolves with an answer no older than `maxAgeMs`,
 *   joining the read in flight rather than starting a second.
 *
 * The cache age matches the sale read's own CDN lifetime (`s-maxage=10` on
 * `GET /api/social/presales/{id}`): reading more often than that cannot see a
 * newer raise, only the same cached answer again.
 *
 * The answers live in the app's TanStack Query cache (OA-38), one entry per
 * sale **and viewer** (`queryKeys.quotes.commit({ sale, viewer })`), so one
 * viewer's facts never answer for another; a read is `fetchQuery`, so a second
 * ask while one is out joins it, and the cache's own events are what
 * subscribers hear. The age, the debounce and the follow-up read after a
 * commit belong to this source.
 */

import type { QueryClient, QueryKey } from "@tanstack/react-query";

import { isCommitQuoteFor, queryKeys } from "#web/lib/query/keys.ts";

/** How long an answer is reused: the sale read's `s-maxage`. */
export const COMMIT_QUOTE_MAX_AGE_MS = 10_000;
/** How long the amount has to stay still before a stale answer is re-read. */
export const COMMIT_QUOTE_DEBOUNCE_MS = 250;
export const COMMIT_READ_TIMEOUT_MS = 15_000;

export type QuoteSnapshot<F> = Readonly<{
  /** The last answer, or null before the first one. A failed read keeps the previous answer. */
  facts: F | null;
  /** When `facts` was read (the source's clock), or null. */
  at: number | null;
  /** A read is out. */
  loading: boolean;
  /** The last read failed. */
  failed: boolean;
  error?: Error;
}>;

export type CommitQuoteSource<F> = Readonly<{
  /** The latest snapshot for a sale. The same object until something about it changes. */
  peek: (saleId: string) => QuoteSnapshot<F>;
  /** The amount (or the arming) changed: reuse a fresh answer, else read one, debounced unless `now`. */
  want: (saleId: string, options?: Readonly<{ now?: boolean }>) => void;
  /** At confirm: an answer no older than `maxAgeMs`, joining a read in flight. Null when the read fails. */
  fresh: (saleId: string) => Promise<F | null>;
  /** After a commit: read again now, whatever the cache holds. Resolves with that read's answer. */
  refresh: (saleId: string) => Promise<F | null>;
  subscribe: (listener: () => void) => () => void;
  /** Cancel every pending debounce and forget this viewer's answers (the host unmounting, or another viewer). A later `want` starts afresh. */
  dispose: () => void;
}>;

export type CommitQuoteOptions<F> = Readonly<{
  /** One quote request. Null for a read that failed. */
  read: (saleId: string, signal: AbortSignal) => Promise<F | null>;
  /** The shared cache that owns these answers. */
  client: QueryClient;
  /** Whose quote this is (a callsign; null for a visitor): part of every key. */
  viewer?: string | null;
}>;

/** One answer, and when it was asked for (the source's clock). */
type Answer<F> = Readonly<{ facts: F; at: number }>;

/** A read that answered null or threw: the entry keeps its previous answer and says it failed. */
class QuoteUnread extends Error {
  constructor() {
    super("The commit quote could not be read.");
    this.name = "QuoteUnread";
  }
}

const EMPTY: QuoteSnapshot<never> = Object.freeze({ facts: null, at: null, loading: false, failed: false });

export function createCommitQuotes<F>(options: CommitQuoteOptions<F>): CommitQuoteSource<F> {
  const client = options.client;
  const viewer = options.viewer ?? null;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** A forced read asked for while another was out: it reads once that one lands. */
  const followUps = new Map<string, Promise<F | null>>();
  /** Each entry state's snapshot, so `peek` answers the same object until the entry changes. */
  const snapshots = new WeakMap<object, QuoteSnapshot<F>>();

  const keyOf = (saleId: string): QueryKey => queryKeys.quotes.commit({ sale: saleId, viewer });
  const mine = (queryKey: QueryKey) => isCommitQuoteFor(queryKey, viewer);
  const entry = (saleId: string) => client.getQueryCache().find<Answer<F>>({ queryKey: keyOf(saleId), exact: true });
  const inFlight = (saleId: string) => entry(saleId)?.state.fetchStatus === "fetching";
  const isFresh = (saleId: string) => {
    const answer = entry(saleId)?.state.data;
    return answer !== undefined && Date.now() - answer.at < COMMIT_QUOTE_MAX_AGE_MS;
  };

  const cancelTimer = (saleId: string) => {
    if (!timers.has(saleId)) return;
    clearTimeout(timers.get(saleId));
    timers.delete(saleId);
  };

  /** Reads the sale's facts now, or joins the read already out (one in flight; the last read wins). */
  const read = (saleId: string): Promise<F | null> => {
    cancelTimer(saleId);
    const asked = Date.now();
    return client
      .fetchQuery<Answer<F>>({
        queryKey: keyOf(saleId),
        queryFn: async ({ signal }) => {
          const controller = new AbortController();
          let cancelRead: ((reason: unknown) => void) | undefined;
          const abort = () => { controller.abort(signal.reason); cancelRead?.(signal.reason); };
          signal.addEventListener("abort", abort, { once: true });
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const facts = await Promise.race([
              options.read(saleId, controller.signal),
              new Promise<never>((_, reject) => {
                cancelRead = reject;
                timer = setTimeout(() => {
                  controller.abort();
                  reject(new DOMException("Presale terms took too long to load.", "TimeoutError"));
                }, COMMIT_READ_TIMEOUT_MS);
              }),
            ]);
            if (facts === null) throw new QuoteUnread();
            return { facts, at: asked };
          } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
          }
        },
        staleTime: 0,
        // The entry lives as long as this source (its `dispose` forgets it): a composer left open keeps its facts.
        gcTime: Number.POSITIVE_INFINITY,
        retry: false,
      })
      .then(
        (answer) => answer.facts,
        () => null,
      );
  };

  /** The read in flight's answer, or, when a forced read was asked for meanwhile, that one's. */
  const joined = (saleId: string): Promise<F | null> => read(saleId).then((answer) => followUps.get(saleId) ?? answer);

  return {
    peek(saleId) {
      const state = entry(saleId)?.state;
      if (state === undefined) return EMPTY;
      let snapshot = snapshots.get(state);
      if (snapshot === undefined) {
        snapshot = Object.freeze({
          facts: state.data?.facts ?? null,
          at: state.data?.at ?? null,
          loading: state.fetchStatus === "fetching",
          failed: state.status === "error",
          ...(state.error instanceof Error && !(state.error instanceof QuoteUnread) ? { error: state.error } : {}),
        });
        snapshots.set(state, snapshot);
      }
      return snapshot;
    },
    want(saleId, wantOptions = {}) {
      if (isFresh(saleId) || inFlight(saleId)) return;
      if (wantOptions.now === true) {
        void read(saleId);
        return;
      }
      cancelTimer(saleId);
      timers.set(
        saleId,
        setTimeout(() => {
          timers.delete(saleId);
          if (inFlight(saleId) || isFresh(saleId)) return;
          void read(saleId);
        }, COMMIT_QUOTE_DEBOUNCE_MS),
      );
    },
    fresh(saleId) {
      if (inFlight(saleId)) return joined(saleId);
      if (isFresh(saleId)) return Promise.resolve(entry(saleId)?.state.data?.facts ?? null);
      return read(saleId);
    },
    refresh(saleId) {
      if (!inFlight(saleId)) return read(saleId);
      // The read out now may have left before the commit landed: read once
      // more after it. Whoever joined that read gets this second answer.
      let followUp = followUps.get(saleId);
      if (followUp === undefined) {
        followUp = read(saleId)
          .then(() => read(saleId))
          .finally(() => followUps.delete(saleId));
        followUps.set(saleId, followUp);
      }
      return followUp;
    },
    subscribe(listener) {
      return client.getQueryCache().subscribe((event) => {
        if (mine(event.query.queryKey)) listener();
      });
    },
    dispose() {
      for (const saleId of [...timers.keys()]) cancelTimer(saleId);
      client.removeQueries({ predicate: (query) => mine(query.queryKey) });
    },
  };
}

/**
 * The Blast wallet behind every quote (and the trade kit's, `maxAgeMs` 5 s):
 * the shared `/me/wallet` read (`walletQuery` in `social/queries.ts`, the Your
 * coins card's entry), reused for a quote's age, so the balances behind quotes
 * are read once per window rather than once per sale. A failed read is not
 * kept, and is not retried here (the quote says it failed). `fetchQuery` it;
 * a send marks it stale.
 */
export function quoteWalletQuery<Shared extends Readonly<{ queryKey: readonly unknown[] }>>(shared: Shared, maxAgeMs: number = COMMIT_QUOTE_MAX_AGE_MS) {
  return { ...shared, staleTime: maxAgeMs, retry: false as const };
}
