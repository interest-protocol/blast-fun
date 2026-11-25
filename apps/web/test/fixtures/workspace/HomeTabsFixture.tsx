"use client";

import { useMemo, useState } from "react";
import { PageHeader } from "../../../src/components/blast-ui/PageHeader.tsx";
import { bricolage, geist, geistMono } from "../../../src/components/blast-ui/fonts.ts";
import { QueryProvider } from "../../../src/lib/query/provider.tsx";
import { CoinTabs } from "../../../src/components/social/coin-home/HomeControls.tsx";
import { DiscoverList, type ListProps } from "../../../src/components/social/coin-home/sources.tsx";
import { TableCard } from "../../../src/components/social/coin-home/TableFooter.tsx";
import { HOME_DEFAULT_FEED, discoverQueryOf, stageDefaultSort, tabOf, type HomeViewState } from "../../../src/components/social/coin-home/home-state.ts";
import homeStyles from "../../../src/components/social/coin-home/CoinHome.module.css";
import { NOW, POPULATED, WORST, page } from "./home-tabs-fixtures.ts";

/**
 * The Coins table in each state, for captures: `?state=` populated | worst |
 * empty | loading | error, `?theme=` light | dark. The Home read is stubbed in
 * the browser, so tabs and header sorts run the real list code.
 */
export type HomeTabsState = "populated" | "worst" | "empty" | "loading" | "error";

/** Answers every Home read from the chosen state: the rows, nothing, a read that never settles, or a server error. */
function stubHomeReads(state: HomeTabsState): void {
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.pathname !== "/api/social/home") return original(input, init);
    if (state === "loading") return new Promise<Response>(() => {});
    if (state === "error") return Response.json({ error: "fixture" }, { status: 503 });
    if (state === "empty") return Response.json(page([]));
    return Response.json(page(state === "worst" ? WORST : POPULATED));
  };
}

const noop = () => undefined;

export function HomeTabsFixture({ state, theme }: Readonly<{ state: HomeTabsState; theme: string }>) {
  useState(() => { if (typeof window !== "undefined") stubHomeReads(state); });
  const [view, setView] = useState<HomeViewState>({ ...HOME_DEFAULT_FEED, window: "24h" });
  const list: ListProps = useMemo(() => ({
    source: "discover", window: view.window, nowMs: NOW, trading: true, stage: view.stage, sort: view.sort,
    defaultSort: stageDefaultSort(view.stage), onSort: (sort) => setView({ ...view, sort }), page: 1, rows: 10, onPage: noop, onRows: noop,
    onReset: () => setView({ ...HOME_DEFAULT_FEED, window: "24h", stage: view.stage, sort: view.sort }),
  }), [view]);
  const tab = tabOf(view);
  return (
    <div className={`${geist.variable} ${geistMono.variable} ${bricolage.variable}`} data-blast-ui="" data-theme={theme} style={{ background: "var(--bg)", minHeight: "100vh", padding: "0 1rem" }}>
      <QueryProvider>
        <div className={homeStyles.home}>
          <PageHeader title="Home" />
          <TableCard>
            <CoinTabs onChange={setView} panelId="proof-coins" state={view} />
            <div aria-label={tab ? undefined : "Coins"} aria-labelledby={tab ? `proof-coins-${tab}` : undefined} id="proof-coins" role="tabpanel">
              <DiscoverList initial={null} props={list} query={discoverQueryOf(view)} />
            </div>
          </TableCard>
        </div>
      </QueryProvider>
    </div>
  );
}
