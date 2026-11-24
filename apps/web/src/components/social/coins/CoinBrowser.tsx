"use client";

import { scheduleDelay } from "#web/lib/schedule-delay.ts";
import { CoinRowsLoading } from "./CoinRowsLoading";
import { SkeletonLine } from "#web/components/blast-ui/Skeleton.tsx";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { Pager } from "#web/components/blast-ui/Pager.tsx";
import { FieldGroup, TextField } from "#web/components/blast-ui/TextField.tsx";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { visibleHoldings, type WalletCoinView } from "./coin-model";
import styles from "./coins.module.css";
import { SearchIcon } from "./icons";
import { publicErrorMessage } from "#web/lib/errors.ts";

export type HoldingsPage = Readonly<{ coins: readonly WalletCoinView[]; total: number; page: number }>;
export type HoldingsLoader = (page: number, search: string, mode: string, signal: AbortSignal) => Promise<HoldingsPage>;
export type CoinBrowserState = Readonly<{ search: string; page: number }>;

/** Search runs before paging. Sheets keep explicit pages so a hundred holdings cannot bury their footer. */
export function CoinBrowser({ coins, mode, load, state, onState, children, owned = true }: Readonly<{
  coins: readonly WalletCoinView[]; owned?: boolean; mode: string; load?: HoldingsLoader; state: CoinBrowserState; onState: (state: CoinBrowserState) => void;
  children: (coins: readonly WalletCoinView[]) => ReactNode;
}>) {
  const { hideSmallBalances } = useShellPrefs();
  const [remote, setRemote] = useState<Readonly<{ key: string; result?: HoldingsPage; error?: string }>>();
  const rows = useRef<HTMLDivElement>(null);
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify([state, mode, hideSmallBalances]);
  useEffect(() => {
    if (!load) return;
    const controller = new AbortController();
    const cancelRead = scheduleDelay(() => {
      load(state.page, state.search.trim(), mode, controller.signal).then(result => {
        if (!controller.signal.aborted) setRemote({ key, result });
      }).catch(error => {
        if (!controller.signal.aborted) setRemote({ key, error: publicErrorMessage(error, "Your coins could not load. Try again.") });
      });
    }, state.search ? 200 : 0);
    return () => { controller.abort(); cancelRead(); };
  }, [load, state.page, state.search, mode, key, retry]);
  const local = visibleHoldings(coins, state.search, owned && hideSmallBalances);
  const localPage = Math.min(state.page, Math.max(1, Math.ceil(local.length / 20)));
  const result = load ? remote?.key === key ? remote : undefined : { error: undefined, result: { coins: local.slice((localPage - 1) * 20, localPage * 20), total: local.length, page: localPage } };
  const total = result?.result?.total ?? remote?.result?.total ?? 0;
  const page = result?.result?.page ?? state.page;
  const pages = Math.max(1, Math.ceil(total / 20));
  return <div className={styles.browser}>
    <FieldGroup className={styles.tpSearch}><span aria-hidden="true"><SearchIcon /></span><TextField aria-label="Search your coins" autoComplete="off" maxLength={200} onChange={event => onState({ search: event.target.value, page: 1 })} placeholder="Search name, ticker or coin type" type="search" value={state.search} /></FieldGroup>
    <div className={styles.browserMeta}><span role="status">{!result ? <SkeletonLine label="Finding coins" status={false} /> : `${total} ${total === 1 ? "coin" : "coins"}`}</span></div>
    <div aria-busy={!result || undefined} className={styles.browserRows} ref={rows}>
      <CoinBrowserRows result={result} search={state.search} hideSmall={owned && hideSmallBalances} retry={() => setRetry(value => value + 1)}>{children}</CoinBrowserRows>
    </div>
    <Pager onPage={next => { onState({ ...state, page: next }); rows.current?.scrollTo({ top: 0, behavior: "instant" }); }} page={page} pages={pages} pending={!result} what="coins" />
  </div>;
}

function CoinBrowserRows({ result, search, hideSmall, retry, children }: Readonly<{ result?: { error?: string; result?: HoldingsPage }; search: string; hideSmall: boolean; retry: () => void; children: (coins: readonly WalletCoinView[]) => ReactNode }>) {
  if (result?.error) return <EmptyState action={<Button onClick={retry} size="sm">Try again</Button>} role="alert" title={result.error} />;
  if (!result?.result) return <CoinRowsLoading label="Loading your coins" />;
  if (result.result.coins.length) return children(result.result.coins);
  if (search) return <EmptyState role="status" title="No matching coins">{hideSmall ? "Try another search or show small balances in Portfolio." : "Try another search."}</EmptyState>;
  return hideSmall
    ? <EmptyState title="No visible coins">Show small balances in Portfolio to see every coin.</EmptyState>
    : <EmptyState title="No coins yet">Deposit to get started.</EmptyState>;
}
