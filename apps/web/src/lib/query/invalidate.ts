import { partialMatchKey, type QueryClient, type QueryKey } from "@tanstack/react-query";

import { queryKeys } from "./keys";

const balanceRevisions = new WeakMap<QueryClient, number>();

export function walletBalanceRevision(client: QueryClient): number {
  return balanceRevisions.get(client) ?? 0;
}

export type ServerChange =
  | Readonly<{ kind: "publish" }>
  | Readonly<{ kind: "wallet-stale" }>
  | Readonly<{ kind: "portfolio-capability" }>
  | Readonly<{ kind: "home-live" }>
  /** A commit landed (or was registered) in a sale. */
  | Readonly<{ kind: "commit"; presaleId: string }>
  /** A claim settled (tokens, a refund or vested tokens). */
  | Readonly<{ kind: "claim"; presaleId: string | null }>
  /** A coin trade (swap) settled. */
  | Readonly<{ kind: "trade" }>
  /** "Balances move": a deposit landed or a withdrawal went out. */
  | Readonly<{ kind: "balances" }>
  /** A follow of an account or a presale was written. */
  | Readonly<{ kind: "follow"; target: "account" | "presale"; id: string }>
  /** A star was added or removed. */
  | Readonly<{ kind: "watchlist" }>
  /** The account's settings were saved (privacy, explorer, sound, notification switches). */
  | Readonly<{ kind: "settings" }>
  /** Notifications were read. */
  | Readonly<{ kind: "notifications" }>
  /** The viewer's profile (name, picture) was saved. */
  | Readonly<{ kind: "profile"; callsign: string | null }>
  /** A sale's editable metadata (R3-28) was saved. */
  | Readonly<{ kind: "sale-metadata"; presaleId: string }>
  /** A why was posted on a feed item: a sale's theses and the author's profile tabs list whys. */
  | Readonly<{ kind: "why" }>;

/** Every key prefix `change` makes stale. */
export function keysChangedBy(change: ServerChange): readonly QueryKey[] {
  switch (change.kind) {
    case "publish":
      return [queryKeys.me.presales(), queryKeys.presales.all, queryKeys.feed.all];
    case "wallet-stale":
      return [queryKeys.me.wallet()];
    case "portfolio-capability":
      return [queryKeys.workspace.portfolioCapabilities];
    case "home-live":
      return [queryKeys.home.threads, queryKeys.home.coinLists, queryKeys.me.home.all];
    case "commit":
      return [
        queryKeys.me.wallet(),
        queryKeys.me.portfolio(),
        queryKeys.me.presales(),
        queryKeys.me.presaleViewerAll,
        queryKeys.me.transactions.all,
        queryKeys.presales.detail(change.presaleId),
        queryKeys.presales.lists,
      ];
    case "claim":
      return [
        queryKeys.me.wallet(),
        queryKeys.me.portfolio(),
        queryKeys.me.presales(),
        queryKeys.me.presaleViewerAll,
        queryKeys.me.transactions.all,
        queryKeys.me.claims(),
        queryKeys.me.creatorEarnings(),
        queryKeys.me.rewards.all,
        ...(change.presaleId === null ? [] : [queryKeys.presales.detail(change.presaleId)]),
      ];
    case "trade":
      return [queryKeys.me.wallet(), queryKeys.me.portfolio(), queryKeys.me.presales(), queryKeys.me.transactions.all];
    case "balances":
      return [queryKeys.me.wallet(), queryKeys.me.portfolio(), queryKeys.me.presales(), queryKeys.me.transactions.all];
    case "follow":
      // A follow changes Home's Following source and every followed preview and thread.
      return change.target === "presale"
        ? [queryKeys.me.watchlist.all, queryKeys.me.presaleViewerAll]
        : [queryKeys.me.mutuals(change.id), queryKeys.me.connections.all, queryKeys.me.home.all, queryKeys.me.followingWallets()];
    case "watchlist":
      return [queryKeys.me.watchlist.all];
    case "settings":
      return [queryKeys.me.settings(), queryKeys.me.connections.all];
    case "notifications":
      return [queryKeys.me.notifications.all];
    case "profile":
      return [queryKeys.me.profileEdit(), queryKeys.me.account(), queryKeys.me.connections.all, ...(change.callsign === null ? [] : [queryKeys.profiles.detail(change.callsign)])];
    case "sale-metadata":
      return [queryKeys.me.saleMetadata(change.presaleId), queryKeys.presales.detail(change.presaleId)];
    case "why":
      return [queryKeys.presales.details, queryKeys.profiles.all];
  }
}

/**
 * Marks every read `change` made stale; the active ones read again. A read
 * already in flight is kept (`cancelRefetch: false`), so a burst of changes
 * costs one request per key, not one per change.
 */
export async function invalidateAfter(client: QueryClient, change: ServerChange): Promise<void> {
  if (change.kind === "wallet-stale") {
    await client.invalidateQueries({
      queryKey: queryKeys.me.wallet(),
      predicate: ({ queryKey }) => !partialMatchKey(queryKey, queryKeys.me.walletBalances),
      refetchType: "none",
    });
    return;
  }
  const keys = keysChangedBy(change);
  if (keys.some((key) => partialMatchKey(key, queryKeys.me.wallet()))) {
    balanceRevisions.set(client, walletBalanceRevision(client) + 1);
  }
  await Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey }, { cancelRefetch: false })));
}

/**
 * Drops every viewer read (`["blast","me",…]`): the viewer signed in, out, or
 * became someone else, so nothing one viewer read may show for another. Reads
 * in flight are cancelled and their answers discarded.
 */
export function clearViewerQueries(client: QueryClient): void {
  void client.cancelQueries({ queryKey: queryKeys.me.all });
  client.removeQueries({ queryKey: queryKeys.me.all });
}

/** Discovery reads that a committed activity or lifecycle hint can change. Sale details are narrower: see `saleDetailsHinted`. */
export const HINTED_KEYS: readonly QueryKey[] = [queryKeys.presales.lists, queryKeys.prices.batches, queryKeys.me.createdPresales()];

/** The phases in which a sale can still take a commit; the edge may answer `closed` while late commits are still being indexed. */
const TAKES_COMMITS = new Set(["open", "closed"]);

/**
 * The sale details a hint can change. A plain activity hint names no sale, so it
 * may be a commit to any sale still taking commits; every other sale (pending,
 * funded, trading, cancelled) moves only on its own lifecycle hint, on a catch-up
 * after a gap, or on its own timer. Without this, every hint anywhere re-read the
 * open page of a graduated sale (about every 7 s on a busy site).
 */
export function saleDetailsHinted(sales: ReadonlySet<string>, catchUp: boolean): Parameters<QueryClient["invalidateQueries"]>[0] {
  return {
    queryKey: queryKeys.presales.details,
    predicate: ({ queryKey, state }) => {
      if (catchUp || sales.has(String(queryKey[4]))) return true;
      const sale = isRecord(state.data) && isRecord(state.data.presale) ? state.data.presale : null;
      return sale === null || typeof sale.phase !== "string" || TAKES_COMMITS.has(sale.phase);
    },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
