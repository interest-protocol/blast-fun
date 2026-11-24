"use client";

import { useEffect, useState } from "react";

import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";

import type { RewardsPage } from "./launch-rewards-client";

/** One wallet's list: the rows read so far, and the state of the last read. */
export type WalletPages<Row> = Readonly<{
  status: "loading" | "ready" | "error";
  rows: readonly Row[];
  next: string | null;
  /** Why the first page failed, or why the last "more" failed while rows stay. */
  failed: string | null;
  loadingMore: boolean;
}>;

export type PageReader<Row> = (address: string, cursor: string | null, dependencies: MarketDataDependencies) => Promise<RewardsPage<Row>>;

const LOADING = { status: "loading", rows: [], next: null, failed: null, loadingMore: false } as const;

/**
 * A wallet's paged list, read in the browser while `active`: the first page, then more on
 * request, `key` keeping each row once. A failed first page is an error to retry, never empty.
 * `reader` and `dependencies` must be stable: a module function and a memoized value.
 */
export function useWalletPages<Row>(
  reader: PageReader<Row>,
  key: (row: Row) => string,
  address: string,
  dependencies: MarketDataDependencies,
  active: boolean,
): Readonly<{ state: WalletPages<Row>; more: () => void; retry: () => void; refresh: () => void }> {
  const [attempt, setAttempt] = useState(0);
  // What was read, and for which wallet and attempt: another wallet's rows, or a retried
  // read's old error, show as Loading until its own first page answers.
  const read = `${address}#${attempt}`;
  const [stored, setStored] = useState<Readonly<{ read: string; pages: WalletPages<Row> }> | null>(null);
  const state = stored?.read === read ? stored.pages : LOADING;
  const setState = (change: (previous: WalletPages<Row>) => WalletPages<Row>) =>
    setStored((previous) => ({ read, pages: change(previous?.read === read ? previous.pages : LOADING) }));

  useEffect(() => {
    if (!active) return;
    let current = true;
    void reader(address, null, dependencies).then((page) => {
      if (!current) return;
      setStored({
        read: `${address}#${attempt}`,
        pages:
          page.kind === "failed"
            ? { ...LOADING, status: "error", failed: page.reason }
            : { status: "ready", rows: page.rows, next: page.next, failed: null, loadingMore: false },
      });
    });
    return () => {
      current = false;
    };
  }, [reader, address, dependencies, active, attempt]);

  const more = () => {
    const cursor = state.next;
    if (!cursor || state.loadingMore) return;
    setState((previous) => ({ ...previous, loadingMore: true }));
    void reader(address, cursor, dependencies).then((page) =>
      setState((previous) => {
        if (page.kind === "failed") return { ...previous, loadingMore: false, failed: page.reason };
        const listed = new Set(previous.rows.map(key));
        return { ...previous, rows: [...previous.rows, ...page.rows.filter((row) => !listed.has(key(row)))], next: page.next, failed: null, loadingMore: false };
      }),
    );
  };

  /** The first page again, the rows shown until it answers; a failure keeps them as they were. */
  const refresh = () => {
    if (state.status !== "ready") return;
    void reader(address, null, dependencies).then((page) => {
      if (page.kind === "failed") return;
      setState((previous) => ({ ...previous, rows: page.rows, next: page.next, failed: null }));
    });
  };

  return { state, more, retry: () => setAttempt((count) => count + 1), refresh };
}
