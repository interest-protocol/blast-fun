"use client";
import { queryKeys } from "#web/lib/query/keys.ts";
import { TextField } from "#web/components/blast-ui/TextField.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { Button } from "#web/components/blast-ui/Button.tsx";

import { useEffect, useId } from "react";
import { useQuery } from "@tanstack/react-query";
import { isValidStructTag } from "@mysten/sui/utils";
import { RowsSkeleton } from "./RowsSkeleton";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { useAmountsHidden } from "../../profile/use-profile-data";
import { positionView, rowMoney, type PositionView } from "../../profile/profile-model";
import { walletAmount } from "../../portfolio/portfolio-model";
import { workspaceMePresalesQuery } from "../../queries";
import { fetchHomeCoins } from "../../coin-home/home-client";
import type { AccessTokenSource } from "../../social-fetch";
import { HIDDEN_AMOUNT } from "@blast/core/web/format.ts";
import type { HomeCoin } from "@blast/core/web/contracts/home.ts";
import type { MePresalePosition } from "@blast/core/web/contracts/profile-page.ts";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { CoinVerifiedMark } from "#web/components/blast-ui/Icons.tsx";
import { QuoteMark } from "../../coin-home/glyphs";
import { useWorkspace } from "./workspace-context";
import { PanelAddButton, RefreshButton } from "./CoinsRows";
import { LoadFailed, RefreshFailed } from "./DataStates";
import { assetOnScreen, canonicalCoinType } from "./coin-row-model";
import styles from "./CoinsData.module.css";
import portfolioStyles from "./PortfolioData.module.css";
import { PortfolioRows } from "./PortfolioRows";

const PAGE_SIZE = 20;
export function PortfolioPresales({ scope, getAccessToken }: Readonly<{ scope: string; getAccessToken: AccessTokenSource }>) {
  const searchId = useId();
  const { snapshot, dispatch } = useWorkspace();
  const controls = snapshot.data.controls.Portfolio;
  const filter = controls.presales;
  const client = useAppQueryClient();
  const hidden = useAmountsHidden();
  const options = workspaceMePresalesQuery(getAccessToken, true, scope);
  const read = useQuery({ ...options,  retry: false, gcTime: 0, staleTime: 0, refetchInterval: false, refetchOnMount: "always", refetchOnWindowFocus: false }, client);
  const term = filter.search.trim().toLowerCase();
  const positions = read.data?.positions.filter(row => [row.presale.name, row.presale.symbol, row.presale.presale_id].some(value => value.toLowerCase().includes(term))) ?? [];
  const pages = Math.max(1, Math.ceil(positions.length / PAGE_SIZE));
  const page = Math.min(filter.page, pages);
  const rows = positions.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const ids = rows.map(row => row.presale.presale_id);
  const assets = useQuery({ queryKey: queryKeys.workspace.portfolioPresales(ids), queryFn: ({ signal }) => fetchHomeCoins(ids, "24h", signal), enabled: ids.length > 0, retry: false, staleTime: 0, refetchOnMount: "always", refetchOnWindowFocus: false }, client);
  useEffect(() => {
    if (read.data && filter.page !== page)
      dispatch.patchDataControls("Portfolio", { ...controls, presales: { ...filter, page } });
  }, [controls, dispatch, filter, page, read.data]);
  const change = (patch: Partial<typeof filter>) => dispatch.patchDataControls("Portfolio", { ...controls, presales: { ...filter, ...patch }, navigation: { ...controls.navigation, scroll_top: 0, anchor: null } });
  const tools = (
    <div className={portfolioStyles.tools}>
      <label className={portfolioStyles.searchField} htmlFor={searchId}><span className={styles.visuallyHidden}>Search presales</span><TextField id={searchId} size="sm" aria-label="Search portfolio presales" placeholder="Search your presales" type="search" value={filter.search} maxLength={200} onChange={event => change({ search: event.currentTarget.value, page: 1 })} /></label>
      <RefreshButton busy={read.isFetching} label="Refresh positions" onRefresh={() => { void read.refetch(); if (ids.length) void assets.refetch(); }} title="Refresh positions" />
    </div>
  );
  if (!read.data) return <>
    {tools}
    {read.isError
      ? <LoadFailed onRetry={() => void read.refetch()} retryLabel="Retry positions" title="Your positions could not load" />
      : <RowsSkeleton label="Loading portfolio positions" />}
  </>;
  return <>
    {tools}
    {read.isError && <RefreshFailed title="Positions could not refresh" />}
    {assets.isError && <RefreshFailed onRetry={() => void assets.refetch()} retryLabel="Retry presale references" title="Presale references could not load">Positions are still shown.</RefreshFailed>}
    {rows.length === 0 ? term
      ? <EmptyState action={<Button onClick={() => change({ search: "", page: 1 })} size="sm">Clear search</Button>} compact role="status" title="No matching positions" />
      : <EmptyState compact role="status" title="No presale positions yet" /> : (
      <PortfolioRows label="Portfolio positions">
        {rows.map(row => <PortfolioPresaleRow key={row.presale.presale_id} row={row} hidden={hidden}
          now={assets.data?.clock_ms ?? read.dataUpdatedAt} coins={assets.data?.coins} referencesPending={assets.isPending} />)}
      </PortfolioRows>
    )}
    {/* As the Coins tab: one page is a count, not a pager with two dead steps (audit inventory). */}
    {pages <= 1 ? positions.length > 0 && <p className={portfolioStyles.holdingCount}>{positions.length} {positions.length === 1 ? "position" : "positions"}</p> : <div className={portfolioStyles.pager}>
      <Button variant="secondary" size="sm"  type="button" disabled={page <= 1} onClick={() => change({ page: page - 1 })} aria-label="Previous position page">Previous</Button>
      <span>Page {page} of {pages} · {positions.length} positions</span>
      <Button variant="secondary" size="sm"  type="button" disabled={page >= pages} onClick={() => change({ page: page + 1 })} aria-label="Next position page">Next</Button>
    </div>}
  </>;
}

function PortfolioPresaleRow({ row, hidden, now, coins, referencesPending }: Readonly<{
  row: MePresalePosition;
  hidden: boolean;
  now: number;
  coins?: readonly HomeCoin[];
  referencesPending: boolean;
}>) {
  const { snapshot, dispatch } = useWorkspace();
  const view = positionView(row, hidden, now);
  const asset = coins?.find(coin => coin.presale_id === row.presale.presale_id && isValidStructTag(coin.coin_type));
  const canonical = asset ? canonicalCoinType(asset.coin_type) : null;
  const open = assetOnScreen(snapshot, canonical);
  const delivered = row.status === "delivered";
  const figures = view.right.kind === "figures" ? view.right : null;
  return <li className={styles.row} data-on-screen={open} data-workspace-portfolio={row.presale.presale_id}>
    <div className={styles.head} data-cols="position">
      <span className={styles.tile}><CoinMark coin={{ key: row.presale.presale_id, symbol: row.presale.symbol, iconUrl: row.presale.icon_url || null, round: true }} size={28} /></span>
      <span className={styles.text}>
        <span className={styles.t1}>
          <InspectValue label={`${row.presale.symbol} presale identifier`} value={row.presale.presale_id}><strong>{row.presale.symbol}</strong></InspectValue>
          {row.presale.verified_team ? <CoinVerifiedMark size="sm" /> : null}
        </span>
        <span className={styles.t2}><span className={styles.reason}>{positionState(row.status, row.presale.status, view)}</span></span>
      </span>
      <span className={styles.figs}>
        {delivered && figures ? <>
          <span className={styles.figTop}>{figures.top}</span>
          <span className={styles.figSub} data-direction={figures.tone ?? undefined}>{figures.bottom}</span>
        </> : <>
          <span className={styles.figTop}>{hidden ? HIDDEN_AMOUNT : <InspectValue label={`${row.presale.symbol} exact commitment`} value={`${walletAmount(row.committed_atoms, row.presale.quote_decimals)} ${row.presale.quote_symbol}`}><span className={styles.mark}><QuoteMark symbol={row.presale.quote_symbol} /></span>{committedFigure(row)}</InspectValue>}</span>
          {" "}<span className={styles.figSub}>committed</span>
        </>}
      </span>
      {asset ? <PanelAddButton open={open} symbol={row.presale.symbol} onAdd={() => {
        const id = dispatch.add({ panel_id: crypto.randomUUID(), chain: "sui", network: "mainnet", coin_type: asset.coin_type, presale_id: asset.presale_id });
        if (asset.lifecycle === "migrated") dispatch.patchPanel(id, { active_namespace: "coin" });
      }} /> : <span className={styles.slot} />}
    </div>
    {!asset && !referencesPending ? <div className={styles.notes}><p>Asset reference unavailable.</p></div> : null}
  </li>;
}

/** A position's state in plain words, beside its identity. */
function positionState(status: MePresalePosition["status"], sale: string, view: PositionView): string {
  if (status === "delivered") return view.sub;
  if (status === "claimable") return sale === "cancelled" ? "Refund ready" : "Ready to claim";
  if (status === "open" && view.right.kind === "figures") return `Open · ${view.right.bottom}`;
  return view.right.kind === "figures" ? `${view.right.top} · ${view.right.bottom}` : view.sub;
}

/** The commitment as the row shows it (whole dollars or the quote coin); a nonzero commitment never reads as zero. */
function committedFigure(row: MePresalePosition): string {
  const text = rowMoney(row.presale, row.committed_usd, row.committed_atoms);
  return row.committed_atoms !== "0" && /^\$0$/.test(text) ? "<$1" : text;
}
