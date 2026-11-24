import { diagnosticMessage, publicErrorCopy } from "#web/lib/errors.ts";
import type { SocialPresaleSummary } from "@blast/core/web/contracts/presales.ts";
import type { SocialWatchlistItem, SocialWatchlistPage } from "@blast/core/web/contracts/watchlist.ts";

import type { ApiResult, SocialApiOptions } from "#web/components/social/social-api.ts";
import { fetchWatchlistKeys, fetchWatchlistPage, setWatched } from "./watchlist-client";

/**
 * One signed-in viewer's watchlist in the page (UI-12, OA-11): the starred
 * ids for every star on screen (read once), the first page of rows for the
 * right column's card (read when a card asks, again after a change), and
 * star toggles that show at once and roll back when the server refuses. A
 * star's key is a presale id, or a bonding-curve coin's type (in `ids`,
 * newest first, never in the card's rows). The card lists the stars, then
 * the followed presales not starred (OA-17); a follow written elsewhere on
 * the page reaches it through `followChanged`.
 * Framework-free; `WatchlistProvider` binds it to React.
 */
export type WatchlistRows = Readonly<{
  status: "loading" | "ready" | "error";
  errorMessage?: string;
  items: readonly SocialWatchlistItem[];
  total: number;
}>;

export type WatchlistSnapshot = Readonly<{
  /** "idle" until the ids are asked for. */
  status: "idle" | "loading" | "ready" | "error";
  ids: ReadonlySet<string>;
  rows: WatchlistRows | null;
}>;

export type ToggleOutcome = "on" | "off" | "limit" | "failed";

export type WatchlistCalls = Readonly<{
  /** Every saved key, newest first. */
  keys: typeof fetchWatchlistKeys;
  /** The card's first rows: stars, then followed presales not starred. */
  page: (options: SocialApiOptions, limit: number) => Promise<ApiResult<SocialWatchlistPage>>;
  set: typeof setWatched;
}>;

const DEFAULT_CALLS: WatchlistCalls = {
  keys: fetchWatchlistKeys,
  page: (options, limit) => fetchWatchlistPage(options, limit, null, true),
  set: setWatched,
};

/** The card's rows: the first of the watchlist (the header shows the total). */
export const WATCHLIST_CARD_ROWS = 10;

export class WatchlistStore {
  private snapshot: WatchlistSnapshot = { status: "idle", ids: new Set(), rows: null };
  private readonly listeners = new Set<() => void>();
  private options: SocialApiOptions;
  private readonly calls: WatchlistCalls;
  private rowsWanted = false;
  private rowsRead = 0;
  /** Stars changed while the ids were being read: they win over that read (it may predate them). */
  private readonly changedDuringRead = new Map<string, boolean>();

  constructor(options: SocialApiOptions, calls: WatchlistCalls = DEFAULT_CALLS) {
    this.options = options;
    this.calls = calls;
  }

  setOptions(options: SocialApiOptions): void {
    this.options = options;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): WatchlistSnapshot => this.snapshot;

  private set(next: Partial<WatchlistSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }

  /** Reads the starred ids once (again after a failure). */
  async loadIds(): Promise<void> {
    if (this.snapshot.status === "loading" || this.snapshot.status === "ready") return;
    this.set({ status: "loading" });
    const result = await this.calls.keys(this.options);
    if (result.status !== "ok") {
      this.set({ status: "error" });
      return;
    }
    let ids: ReadonlySet<string> = new Set(result.body.keys);
    // A save the server already holds keeps the server's place.
    for (const [id, on] of this.changedDuringRead) if (!(on && ids.has(id))) ids = withKey(ids, id, on);
    this.changedDuringRead.clear();
    this.set({ status: "ready", ids });
  }

  /** Reads the card's rows (the first page); later changes read them again. */
  async loadRows(): Promise<void> {
    this.rowsWanted = true;
    const read = ++this.rowsRead;
    if (!this.snapshot.rows) this.set({ rows: { status: "loading", items: [], total: 0 } });
    const result = await this.calls.page(this.options, WATCHLIST_CARD_ROWS);
    if (read !== this.rowsRead) return;
    if (result.status !== "ok") {
      this.set({ rows: { status: "error", errorMessage: diagnosticMessage(publicErrorCopy(result.code, "Your watchlist could not load. Try again."), result), items: this.snapshot.rows?.items ?? [], total: this.snapshot.rows?.total ?? 0 } });
      return;
    }
    this.set({ rows: { status: "ready", items: result.body.items, total: result.body.total } });
  }

  has(presaleId: string): boolean {
    return this.snapshot.ids.has(presaleId);
  }

  /**
   * Stars or unstars `presale` (`on`): shown at once (the star, and the
   * card's rows: a new star leads, an unstarred row goes unless the presale
   * is followed), then written; a refusal puts everything back. A presale
   * summary lets a new star show in the card before the rows are read again.
   */
  async toggle(presale: Pick<SocialPresaleSummary, "presale_id"> & Partial<SocialPresaleSummary>, on: boolean): Promise<ToggleOutcome> {
    const id = presale.presale_id;
    const before = this.snapshot;
    const ids = withKey(before.ids, id, on);
    const reading = this.snapshot.status === "loading";
    if (reading) this.changedDuringRead.set(id, on);
    this.set({ ids, rows: before.rows ? optimisticRows(before.rows, presale, on) : null });
    const result: ApiResult<null> = await this.calls.set(this.options, id, on);
    if (result.status !== "ok") {
      const was = before.ids.has(id);
      if (this.snapshot.status === "loading") this.changedDuringRead.delete(id);
      // An unsave put back returns the key to its place, after keys saved meanwhile; a save put back just goes.
      const back = was
        ? new Set([
            ...[...this.snapshot.ids].filter((key) => !before.ids.has(key)),
            ...[...before.ids].filter((key) => key === id || this.snapshot.ids.has(key)),
          ])
        : withKey(this.snapshot.ids, id, false);
      this.set({ ids: back, rows: before.rows });
      return result.status === "refused" && result.code === "watchlist_limit" ? "limit" : "failed";
    }
    if (this.rowsWanted) void this.loadRows();
    return on ? "on" : "off";
  }

  /**
   * The viewer followed or unfollowed a presale (a write that succeeded):
   * the card's row keeps its place while starred, an unfollowed row that is
   * not starred goes, and the rows are read again (a new follow's row comes
   * with that read).
   */
  followChanged(presaleId: string, on: boolean): void {
    const rows = this.snapshot.rows;
    if (!rows || !this.rowsWanted) return;
    const row = rows.items.find((item) => item.presale.presale_id === presaleId);
    if (row) {
      const items = !on && !row.starred
        ? rows.items.filter((item) => item !== row)
        : rows.items.map((item) => (item === row ? { ...item, followed: on } : item));
      this.set({ rows: { ...rows, items, total: items.length < rows.items.length ? Math.max(rows.total - 1, 0) : rows.total } });
    }
    void this.loadRows();
  }
}

/** The keys with `id` saved (newest, so first) or removed. */
function withKey(ids: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
  return on ? new Set([id, ...ids]) : new Set([...ids].filter((key) => key !== id));
}

function optimisticRows(rows: WatchlistRows, presale: Pick<SocialPresaleSummary, "presale_id"> & Partial<SocialPresaleSummary>, on: boolean): WatchlistRows {
  // A curve coin (its key a coin type) is never a card row: the card lists sales.
  if (presale.presale_id.includes("::")) return rows;
  const row = rows.items.find((item) => item.presale.presale_id === presale.presale_id);
  const others = rows.items.filter((item) => item !== row);
  if (!on) {
    if (!row) return rows;
    // Still followed: it stays (the next read moves it among the follows).
    if (row.followed) return { ...rows, items: rows.items.map((item) => (item === row ? { ...item, starred: false } : item)) };
    return { ...rows, items: others, total: Math.max(rows.total - 1, 0) };
  }
  // Already listed as a follow: it moves up among the stars, counted once.
  if (row) return { ...rows, items: [{ ...row, starred: true, added_ms: Date.now() }, ...others] };
  const full = isSummary(presale) ? presale : null;
  return {
    ...rows,
    items: full ? [{ presale: full, added_ms: Date.now(), starred: true, followed: false }, ...rows.items].slice(0, WATCHLIST_CARD_ROWS) : rows.items,
    total: rows.total + 1,
  };
}

function isSummary(value: Partial<SocialPresaleSummary>): value is SocialPresaleSummary {
  return typeof value.name === "string" && typeof value.phase === "string" && typeof value.end_ms === "number";
}
