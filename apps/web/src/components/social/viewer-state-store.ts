import type { QueryClient, QueryKey } from "@tanstack/react-query";

import { invalidateAfter } from "#web/lib/query/invalidate.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import type { SocialFollowTarget } from "@blast/core/web/contracts/follows.ts";
import type { SocialViewerBackers, SocialViewerStateResponse } from "@blast/core/web/contracts/viewer-state.ts";

import {
  fetchViewerState,
  viewerStateBatches,
  writeFollow,
  writeReaction,
  type AccessTokenSource,
  type FollowWriteResult,
  type ReactionWriteResult,
  type ViewerStateWants,
} from "./viewer-state-client";

export type ViewerStateStoreDependencies = Readonly<{
  getAccessToken: AccessTokenSource;
  fetch?: typeof fetch;
  /**
   * The server-state cache the answers live in (OA-38): the page's
   * `QueryClient`, so a sign-out or an account switch drops them with every
   * other viewer read.
   */
  client: QueryClient;
  /** Who the answers belong to (the callsign), part of every key. */
  scope?: string;
}>;

/**
 * One target's follow writes: `want` is the newest tap, `base` the last state
 * the server confirmed (undefined if never read), `hadWritten` whether a read
 * could already not overwrite it.
 */
type FollowQueue = {
  want: boolean;
  base: boolean | undefined;
  hadWritten: boolean;
  run: Promise<FollowWriteResult>;
};

const followKey = (target: SocialFollowTarget) =>
  target.kind === "account" ? `c:${target.callsign}` : `p:${target.presale_id}`;

/**
 * One signed-in viewer's state on social pages: whether they follow each
 * account and presale on screen, and their reactions on each item. Controls
 * ask for the ids they show (`want`); the store gathers every id asked for in
 * one turn and reads them with as few `POST /api/social/viewer-state` calls
 * as the route's bounds allow, once per id. A follow written here wins over
 * any read still in flight. Subscribe with `useSyncExternalStore`.
 *
 * The answers live in the page's server-state cache (OA-38,
 * `["blast","me","viewer-state",…]`), so Blast mode's lanes, the sale page and
 * every post share one read per id, and signing out drops them with the
 * viewer's other reads. The batching stays here: TanStack Query reads one key
 * per request, and this route answers many ids at once.
 */
/**
 * One kind of per-id answer, kept in the server-state cache under
 * `["blast","me","viewer-state",<scope>,<kind>,<id>]`: never stale (the store
 * reads an id once per viewer) and never collected while the page lives.
 */
class CachedMap<V> {
  readonly #client: QueryClient;
  readonly #prefix: QueryKey;
  constructor(client: QueryClient, prefix: QueryKey) {
    this.#client = client;
    this.#prefix = prefix;
  }
  #key(id: string): QueryKey {
    return [...this.#prefix, id];
  }
  get(id: string): V | undefined {
    return this.#client.getQueryData<V>(this.#key(id));
  }
  has(id: string): boolean {
    return this.get(id) !== undefined;
  }
  set(id: string, value: V): void {
    this.#client.setQueryData<V>(this.#key(id), value);
  }
  delete(id: string): void {
    this.#client.removeQueries({ queryKey: this.#key(id), exact: true });
  }
}

export class ViewerStateStore {
  readonly #dependencies: ViewerStateStoreDependencies;
  readonly #client: QueryClient;
  #getAccessToken: AccessTokenSource;
  readonly #follows: CachedMap<boolean>;
  readonly #reactions: CachedMap<readonly string[]>;
  /** The viewer's reactions as first read: what a public count already includes of them. */
  readonly #readReactions: CachedMap<readonly string[]>;
  readonly #backers: CachedMap<SocialViewerBackers>;
  /** Whether each account (by callsign) follows the viewer. */
  readonly #followsYou: CachedMap<boolean>;
  /** Grows with every change a listener is told of (a stable snapshot for `useSyncExternalStore`). */
  #version = 0;
  /** Keys asked for and read or being read (`e:`, `c:`, `p:`, `b:`, `y:` prefixed). */
  readonly #requested = new Set<string>();
  readonly #failedFollows = new Set<string>();
  /** Follow and reaction keys written by this viewer here: a read never overwrites them. */
  readonly #written = new Set<string>();
  /** The latest reaction write per item: an older one finishing late never undoes a newer tap. */
  readonly #reactionWrites = new Map<string, number>();
  #writeSequence = 0;
  readonly #listeners = new Set<() => void>();
  /** The follow writes in flight per target, with the newest tap still to settle. */
  readonly #followQueues = new Map<string, FollowQueue>();
  readonly #followWriteListeners = new Set<(target: SocialFollowTarget, following: boolean) => void>();
  #pending: { entryIds: string[]; callsigns: string[]; presaleIds: string[]; backersOf: string[]; followsYou: string[] } = {
    entryIds: [], callsigns: [], presaleIds: [], backersOf: [], followsYou: [],
  };
  #scheduled = false;
  #controller = new AbortController();

  constructor(dependencies: ViewerStateStoreDependencies) {
    this.#dependencies = dependencies;
    this.#getAccessToken = dependencies.getAccessToken;
    const client = dependencies.client;
    this.#client = client;
    const root = queryKeys.me.viewerState(dependencies.scope ?? "");
    client.setQueryDefaults(root, { staleTime: Number.POSITIVE_INFINITY, gcTime: Number.POSITIVE_INFINITY, retry: false });
    this.#follows = new CachedMap(client, [...root, "follow"]);
    this.#reactions = new CachedMap(client, [...root, "reactions"]);
    this.#readReactions = new CachedMap(client, [...root, "reactions-at-read"]);
    this.#backers = new CachedMap(client, [...root, "backers"]);
    this.#followsYou = new CachedMap(client, [...root, "follows-you"]);
  }

  /** Changes with every update listeners hear of. */
  readonly version = (): number => this.#version;

  /** Replaces where the viewer's access token comes from (a new session's getter). */
  setAccessTokenSource(getAccessToken: AccessTokenSource): void {
    this.#getAccessToken = getAccessToken;
  }

  /** End outgoing private reads and ignore late answers across viewer lifetimes. */
  setActive(active: boolean): void {
    if (active) {
      if (this.#controller.signal.aborted)
        this.#controller = new AbortController();
      return;
    }
    this.#controller.abort();
    // A follow write in flight is no longer this viewer's: show the last confirmed
    // state, and let the next read correct it if the write did land.
    for (const [key, queue] of this.#followQueues) {
      this.#putBack(key, queue);
      this.#written.delete(key);
    }
    this.#followQueues.clear();
    this.#requested.clear();
    this.#failedFollows.clear();
    this.#pending = {
      entryIds: [],
      callsigns: [],
      presaleIds: [],
      backersOf: [],
      followsYou: [],
    };
    this.#scheduled = false;
  }

  /** Asks for the viewer's state of these ids; ids already read or being read are skipped. */
  want(wants: ViewerStateWants): void {
    if (this.#controller.signal.aborted) return;
    let added = false;
    let retrying = false;
    const add = (prefix: string, ids: readonly string[] | undefined, into: string[]) => {
      for (const id of ids ?? []) {
        const key = `${prefix}${id}`;
        if (this.#requested.has(key)) continue;
        this.#requested.add(key);
        if (this.#failedFollows.delete(key)) retrying = true;
        into.push(id);
        added = true;
      }
    };
    add("e:", wants.entryIds, this.#pending.entryIds);
    add("c:", wants.callsigns, this.#pending.callsigns);
    add("p:", wants.presaleIds, this.#pending.presaleIds);
    add("b:", wants.backersOf, this.#pending.backersOf);
    add("y:", wants.followsYou, this.#pending.followsYou);
    if (!added) return;
    if (retrying) this.#notify();
    if (this.#scheduled) return;
    this.#scheduled = true;
    setTimeout(() => void this.flush(), 0);
  }

  /**
   * Reads every pending id now, in batches. A batch that fails forgets its
   * ids, so a later `want` asks again; until then they stay unknown.
   */
  async flush(): Promise<void> {
    const signal = this.#controller.signal;
    if (signal.aborted) return;
    this.#scheduled = false;
    const pending = this.#pending;
    this.#pending = { entryIds: [], callsigns: [], presaleIds: [], backersOf: [], followsYou: [] };
    const batches = viewerStateBatches(pending);
    await Promise.all(batches.map(async (request) => {
      const result = await fetchViewerState({
        getAccessToken: this.#getAccessToken,
        request,
        fetch: this.#dependencies.fetch,
        signal,
      });
      if (signal.aborted) return;
      if (result.status !== "ok") {
        this.#forgetBatch(request);
        for (const callsign of request.callsigns ?? []) this.#failedFollows.add(`c:${callsign}`);
        for (const id of request.presale_ids ?? []) this.#failedFollows.add(`p:${id}`);
        this.#notify();
        return;
      }
      const { reactions, follows, backers } = result.state;
      for (const callsign of request.follows_you ?? []) this.#followsYou.set(callsign, result.state.follows_you?.[callsign] === true);
      this.#mergeReactions(request.entry_ids ?? [], reactions);
      for (const id of request.backers_of ?? []) this.#backers.set(id, backers[id] ?? { count: 0, accounts: [] });
      for (const callsign of request.callsigns ?? []) {
        if (!this.#written.has(`c:${callsign}`)) this.#follows.set(`c:${callsign}`, follows.accounts[callsign] === true);
      }
      for (const id of request.presale_ids ?? []) {
        if (!this.#written.has(`p:${id}`)) this.#follows.set(`p:${id}`, follows.presales[id] === true);
      }
      this.#notify();
    }));
  }

  #forgetBatch(request: ReturnType<typeof viewerStateBatches>[number]): void {
    for (const id of request.entry_ids ?? []) this.#requested.delete(`e:${id}`);
    for (const id of request.callsigns ?? []) this.#requested.delete(`c:${id}`);
    for (const id of request.presale_ids ?? []) this.#requested.delete(`p:${id}`);
    for (const id of request.backers_of ?? []) this.#requested.delete(`b:${id}`);
    for (const id of request.follows_you ?? []) this.#requested.delete(`y:${id}`);
  }

  #mergeReactions(entryIds: readonly string[], reactions: SocialViewerStateResponse["reactions"]): void {
    for (const id of entryIds) {
      if (!this.#readReactions.has(id)) this.#readReactions.set(id, reactions[id] ?? []);
      if (!this.#written.has(`e:${id}`)) this.#reactions.set(id, reactions[id] ?? []);
    }
  }

  /** Whether the viewer follows `target`; undefined until read. */
  following(target: SocialFollowTarget): boolean | undefined {
    return this.#follows.get(followKey(target));
  }

  followReadFailed(target: SocialFollowTarget): boolean {
    return this.#failedFollows.has(followKey(target));
  }

  /** The viewer's reaction keys on an item; undefined until read. */
  reactions(entryId: string): readonly string[] | undefined {
    return this.#reactions.get(entryId);
  }

  /**
   * The viewer's reaction keys on an item as first read (before any tap
   * here); undefined until read. A public count read with the page already
   * includes these.
   */
  reactionsAtRead(entryId: string): readonly string[] | undefined {
    return this.#readReactions.get(entryId);
  }

  /** Whether the account `callsign` follows the viewer; undefined until read. */
  followsYou(callsign: string): boolean | undefined {
    return this.#followsYou.get(callsign);
  }

  /** The viewer's followed named backers of a presale (count and the largest few); undefined until read. */
  backers(presaleId: string): SocialViewerBackers | undefined {
    return this.#backers.get(presaleId);
  }

  /**
   * Adds or removes the viewer's `reaction` on `entryId` optimistically: every
   * control shows it at once, the route writes it, and a refusal puts back what
   * was there. Taps in quick succession settle on the last one: only the
   * newest write's answer can roll back.
   */
  async setReaction(entryId: string, reaction: string, on: boolean): Promise<ReactionWriteResult> {
    const signal = this.#controller.signal;
    if (signal.aborted) return { status: "error", code: "owner_changed" };
    const before = this.#reactions.get(entryId);
    const current = before ?? [];
    const next = on ? [...new Set([...current, reaction])].sort() : current.filter((key) => key !== reaction);
    const key = `e:${entryId}`;
    const hadWritten = this.#written.has(key);
    this.#written.add(key);
    this.#reactions.set(entryId, next);
    const sequence = ++this.#writeSequence;
    this.#reactionWrites.set(entryId, sequence);
    this.#notify();
    const result = await writeReaction({
      getAccessToken: this.#getAccessToken,
      entryId,
      reaction,
      on,
      fetch: this.#dependencies.fetch,
    });
    if (signal.aborted) return result;
    if (result.status !== "ok" && this.#reactionWrites.get(entryId) === sequence) {
      if (before === undefined) this.#reactions.delete(entryId);
      else this.#reactions.set(entryId, before);
      if (!hadWritten) this.#written.delete(key);
      this.#notify();
    }
    return result;
  }

  /**
   * Follows or unfollows `target` optimistically: every control shows the tap
   * at once and the route writes it. Writes for one target go one at a time,
   * and taps made while one is in flight collapse into the newest: when it
   * settles, the store sends the newest tap only if it differs from what the
   * server now holds. A refusal of the newest tap puts back the last confirmed
   * state. Listeners, `cancelQueries` and `invalidateAfter` run only for a
   * write the route accepted. Every tap of a burst shares one settlement.
   * Pausing the viewer (`setActive(false)`) puts a tap in flight back to the
   * last confirmed state for the next read to settle.
   */
  setFollowing(target: SocialFollowTarget, following: boolean): Promise<FollowWriteResult> {
    if (this.#controller.signal.aborted) return Promise.resolve({ status: "error", code: "owner_changed" });
    const key = followKey(target);
    const queued = this.#followQueues.get(key);
    if (queued) {
      queued.want = following;
    } else {
      const queue: FollowQueue = {
        want: following,
        base: this.#follows.get(key),
        hadWritten: this.#written.has(key),
        run: Promise.resolve({ status: "ok" }),
      };
      queue.run = this.#drainFollow(target, queue).finally(() => {
        if (this.#followQueues.get(key) === queue) this.#followQueues.delete(key);
        this.#notify();
      });
      this.#followQueues.set(key, queue);
    }
    // Marked before the write, so a viewer-state read in flight cannot overwrite the tap.
    this.#written.add(key);
    this.#follows.set(key, following);
    this.#notify();
    return this.#followQueues.get(key)!.run;
  }

  async #drainFollow(target: SocialFollowTarget, queue: FollowQueue): Promise<FollowWriteResult> {
    const signal = this.#controller.signal;
    while (queue.want !== queue.base) {
      if (signal.aborted) return { status: "error", code: "owner_changed" };
      const sent = queue.want;
      const result = await writeFollow({
        getAccessToken: this.#getAccessToken, target, following: sent, fetch: this.#dependencies.fetch,
      });
      if (signal.aborted) return result;
      if (result.status === "ok") {
        queue.base = sent;
        queue.hadWritten = true;
        await this.#followAccepted(target, sent, signal);
      } else if (queue.want === sent) {
        this.#followRefused(target, queue);
        return result;
      }
      // Otherwise a newer tap is waiting: send it (or stop, if it matches the server).
    }
    return { status: "ok" };
  }

  async #followAccepted(target: SocialFollowTarget, following: boolean, signal: AbortSignal): Promise<void> {
    if (target.kind === "account") await this.#client.cancelQueries({ queryKey: queryKeys.me.connections.all });
    if (signal.aborted) return;
    for (const listener of this.#followWriteListeners) listener(target, following);
    await invalidateAfter(this.#client, target.kind === "presale" ? { kind: "follow", target: "presale", id: target.presale_id } : { kind: "follow", target: "account", id: target.callsign });
  }

  #followRefused(target: SocialFollowTarget, queue: FollowQueue): void {
    const key = followKey(target);
    this.#putBack(key, queue);
    // Tapped before the page's read: read the real state again.
    if (queue.base !== undefined) return;
    this.#requested.delete(key);
    this.want(target.kind === "account" ? { callsigns: [target.callsign] } : { presaleIds: [target.presale_id] });
  }

  #putBack(key: string, queue: FollowQueue): void {
    if (queue.base === undefined) this.#follows.delete(key);
    else this.#follows.set(key, queue.base);
    if (!queue.hadWritten) this.#written.delete(key);
  }

  /** Hears each follow written here once it succeeded (the watchlist card lists followed presales, OA-17). */
  readonly subscribeFollowWrites = (listener: (target: SocialFollowTarget, following: boolean) => void): (() => void) => {
    this.#followWriteListeners.add(listener);
    return () => this.#followWriteListeners.delete(listener);
  };

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #notify(): void {
    if (this.#controller.signal.aborted) return;
    this.#version += 1;
    for (const listener of this.#listeners) listener();
  }
}
