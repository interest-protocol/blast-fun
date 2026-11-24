"use client";

import { coinPagePath } from "@blast/core/modules/launchpad-coin/page-key.ts";
import { Button, DisclosureButton, IconButton } from "#web/components/blast-ui/Button.tsx";
import { DiagnosticText } from "#web/components/blast-ui/DiagnosticText.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { CloseIcon, CoinVerifiedMark, SearchIcon } from "#web/components/blast-ui/Icons.tsx";
import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import { Collapse } from "#web/components/blast-ui/Collapse.tsx";
import { FieldGroup, TextField } from "#web/components/blast-ui/TextField.tsx";

import clsx from "clsx";
import { useId, useState } from "react";
import Link from "next/link";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { useSeededQuery } from "#web/lib/query/seed.ts";
import { useWalletSearchSubmit, WALLET_SEARCH_MAX_LENGTH } from "#web/lib/wallet-search.ts";
import { HOME_DEFAULT_WINDOW, hasPublicPnl, type HomeTradersQuery, type HomeTrader, type HomeTraderHolding, type HomeTradersPage, type HomeWindow } from "@blast/core/web/contracts/home.ts";
import { presaleHref } from "../feed-ui/shell-bridge-model";
import { PresaleMark } from "../post/PostMedia";
import { Face } from "./ParticipantRow";
import { ListSkeleton } from "./sources";
import { MetricHelp } from "./MetricHelp";
import { tradersQuery } from "./home-client";
import { actorName, coinFigure, pnlText, portfolioText, shareText } from "./home-model";
import styles from "./CoinHome.module.css";
import { TableCard, TableFooter } from "./TableFooter";
import { countWords } from "@blast/core/web/format.ts";
import { useTablePage } from "./use-table-pagination";

function HoldingIdentity({ holding, share = false }: Readonly<{ holding: HomeTraderHolding; share?: boolean }>) {
  return <Link className={styles.holdingIdentity} title={holding.symbol} href={holding.launch_id ? coinPagePath(holding.coin_type ?? holding.launch_id) : presaleHref(holding.presale_id!)}><PresaleMark coinType={holding.coin_type} presaleId={holding.launch_id ?? holding.presale_id!} src={holding.icon_url} size={20} /><span className={styles.holdingSymbol}>{holding.symbol}</span>{holding.verified_team ? <CoinVerifiedMark size="sm" /> : null}{share && holding.share_bps !== null ? <small className={styles.holdingPercent}>{shareText(holding.share_bps)}</small> : null}</Link>;
}

function Pnl({ value, private: hidden = false, full = false }: Readonly<{ value: string | null; private?: boolean; full?: boolean }>) {
  if (hidden) return <span className={styles.private}>Private</span>;
  const pnl = pnlText(value, full ? "full" : "compact");
  return pnl ? <span className={clsx("num", pnl.tone === "up" && styles.up, pnl.tone === "down" && styles.down)}>{pnl.text}</span> : null;
}

function Holdings({ trader }: Readonly<{ trader: HomeTrader }>) {
  if (!(trader.holdings_public ?? trader.portfolio.public)) return <p className={styles.threadNote}>Private</p>;
  if (trader.holdings === undefined) return null;
  if (trader.holdings.length === 0) return null;
  return <div>
    <div className={styles.holdingHead}><span>Token / amount</span><span>{trader.holdings.some((holding) => holding.value_usd !== null) ? "Value · USD" : null}</span><span>{trader.holdings.some((holding) => holding.share_bps !== null) ? <MetricHelp why="Share of fully valued indexed liquid launch-token holdings; excludes cash, other tokens and presale commitments.">Holdings share</MetricHelp> : null}</span><span>{!(trader.performance_public ?? trader.portfolio.public) || trader.holdings.some((holding) => holding.pnl_usd !== null) ? "Unrealized PnL" : null}</span></div>
    {trader.holdings.slice(0, 10).map((holding) => <div className={styles.holdingRow} key={holding.launch_id ?? holding.presale_id}>
      <div><HoldingIdentity holding={holding} /><span className={styles.holdingAmount}>{coinFigure(holding.balance, holding.symbol, holding.decimals, 4)}</span></div>
      <span className="num">{portfolioText(holding.value_usd)}</span>
      <span className="num">{shareText(holding.share_bps)}</span>
      <span><Pnl value={holding.pnl_usd} private={!(trader.performance_public ?? trader.portfolio.public)} /></span>
    </div>)}
  </div>;
}

function TopHoldings({ trader, publicHoldings }: Readonly<{ trader: HomeTrader; publicHoldings: boolean }>) {
  if (!publicHoldings) return <span className={styles.private}>Private</span>;
  if (trader.holdings === undefined) return null;
  if (trader.holdings.length === 0) return null;
  const valued = trader.holdings.every((holding) => holding.value_usd !== null) && trader.portfolio.value_usd !== null;
  if (!valued) return null;
  return trader.holdings.slice(0, 3).map((holding) => <HoldingIdentity holding={holding} share key={holding.launch_id ?? holding.presale_id} />);
}

function TraderRow({ trader, open, toggle }: Readonly<{ trader: HomeTrader; open: boolean; toggle: () => void }>) {
  const id = useId();
  const actor = trader.actor;
  if (actor.type !== "account") return null;
  const name = actorName(actor);
  const holdingsPublic = trader.holdings_public ?? trader.portfolio.public;
  const performancePublic = trader.performance_public ?? trader.portfolio.public;
  const canExpand = !holdingsPublic || Boolean(trader.holdings?.length);
  return <li className={styles.item} data-expanded={open || undefined}>
    <article className={clsx(styles.row, styles.traderCols)} aria-labelledby={`${id}-name`}>
      <span className={clsx("num", styles.rank)}>{performancePublic && trader.rank != null ? trader.rank : null}</span>
      <div className={styles.traderIdentity}><Face participant={trader} size={30} /><div className={styles.identText}><Link className={styles.tName} title={name} href={actor.path} id={`${id}-name`}>{name}</Link><Link href={actor.path} title={`@${actor.callsign}`} className={styles.coinName}>@{actor.callsign}</Link></div></div>
      <span className={styles.traderPnl}><Pnl value={trader.portfolio.pnl_usd} private={!performancePublic} full /></span>
      <div className={styles.topHoldings}><TopHoldings trader={trader} publicHoldings={holdingsPublic} /></div>
      {canExpand ? <DisclosureButton iconOnly size="sm" type="button" className={styles.expand} aria-expanded={open} aria-controls={`${id}-card`} aria-label={`${open ? "Close" : "Open"} ${name} holdings`} onClick={toggle}></DisclosureButton> : null}
    </article>
    {canExpand ? <Collapse id={`${id}-card`} open={open}><div className={styles.card}>
      <div className={styles.holdingsHeader}><h3 className={styles.previewHeading}>Holdings</h3>{holdingsPublic ? <Link className={styles.detailLink} href={`${actor.path}?view=portfolio`}>Portfolio <span aria-hidden="true">↗</span></Link> : null}</div>
      <Holdings trader={trader} />
    </div></Collapse> : null}
  </li>;
}

type TraderReadProps = Readonly<{ initial: HomeTradersPage | null; initialMs: number; window: HomeWindow }>;

function useTraderRead({ initial, initialMs }: TraderReadProps, selection: HomeTradersQuery) {
  const seed = initial?.search === selection.search && initial.page === selection.page && initial.limit === selection.limit ? initial : null;
  return useSeededQuery(tradersQuery(HOME_DEFAULT_WINDOW, selection), seed, initialMs, useAppQueryClient());
}

function TraderList({ traders, globalTotal, search, open, onToggle }: Readonly<{
  traders: readonly HomeTrader[];
  globalTotal: number;
  search: string;
  open: string | null;
  onToggle: (key: string) => void;
}>) {
  if (traders.length === 0) return <EmptyState listEmpty={!search} title={search ? "No matching traders" : "No traders with public PnL yet"} />;
  return <div className={clsx(styles.traderList, globalTotal >= 1000 && styles.wideRanks, globalTotal >= 1_000_000 && styles.hugeRanks)}>
    <div className={clsx(styles.listHead, styles.traderCols)}><span>#</span><span>Trader</span><span className={styles.hEnd}>PnL · USD</span><span className={styles.hHoldings}>Holdings</span><span /></div>
    <ol className={styles.list} aria-label="PnL leaderboard">{traders.map((trader) => <TraderRow key={trader.key} trader={trader} open={open === trader.key} toggle={() => onToggle(trader.key)} />)}</ol>
  </div>;
}

function TraderSearch({ search, loading, onEdit, onSearch }: Readonly<{
  search: string;
  loading: boolean;
  onEdit: () => void;
  onSearch: (search: string) => void;
}>) {
  const [draft, setDraft] = useState("");
  const clear = () => { setDraft(""); onSearch(""); };
  return (
    <form role="search" aria-label="Search traders" className={styles.traderSearch} onSubmit={(event) => {
      event.preventDefault(); onSearch(draft);
    }}>
      <FieldGroup className={styles.traderField} size="chip">
        <TextField aria-label="Name, handle or wallet" type="search" value={draft} maxLength={WALLET_SEARCH_MAX_LENGTH} placeholder="Name, @handle or wallet" autoComplete="off" spellCheck={false}
          onChange={(event) => {
            const value = event.target.value;
            if (!value) { clear(); return; }
            onEdit();
            setDraft(value);
          }}
          onKeyDown={(event) => { if (event.key === "Escape") clear(); }} />
        {draft || search ? <IconButton aria-label="Clear trader search" onClick={clear} size="xs" title="Clear trader search"><CloseIcon /></IconButton> : null}
      </FieldGroup>
      <IconButton aria-label="Search traders" size="chip" title="Search traders" type="submit" variant="secondary"><LoadingIndicator label="Searching traders" loading={loading}><SearchIcon /></LoadingIndicator></IconButton>
    </form>
  );
}

function TraderContent({ data, error, rows, open, onToggle, onRetry }: Readonly<{
  data: HomeTradersPage | undefined;
  error: boolean;
  rows: number;
  open: string | null;
  onToggle: (key: string) => void;
  onRetry: () => void;
}>) {
  if (error) return <EmptyState action={<Button onClick={onRetry} size="sm">Retry</Button>} listEmpty role="alert" title="Traders couldn’t load" />;
  if (!data) return <ListSkeleton rows={rows} />;
  return <TraderList traders={data.traders.filter(hasPublicPnl)} globalTotal={data.global_total} search={data.search} open={open} onToggle={onToggle} />;
}

function traderCount(data: HomeTradersPage | undefined, error: boolean) {
  if (error) return "Search unavailable";
  if (!data) return <span className="sr">Loading traders</span>;
  if (data.total === 0) return null;
  return traderTotal(data);
}

/** The footer's count: `4 traders ranked`, `1 trader found`. */
function traderTotal(data: HomeTradersPage): string {
  return `${countWords(data.total, "trader", "traders")}${data.search ? " found" : " ranked"}`;
}

export function TradersSection(props: TraderReadProps & Readonly<{ nowMs: number }>) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const pagination = useTablePage("traders", search);
  const query = useTraderRead(props, { search, page: pagination.page, limit: pagination.rows });
  const { cancel, issue, pending, submit } = useWalletSearchSubmit((value) => {
    setSearch(value); pagination.onPage(1); setOpen(null);
  });
  const pages = Math.max(1, Math.ceil((query.data?.total ?? 0) / pagination.rows));
  // The basis and the search sit on the section's title line (the Main board); the table card follows.
  // Search stays while a search is on (to change or clear it); with no search, an empty or failed board drops it.
  const searchable = search !== "" || pending || issue !== null || (!query.isError && query.data?.total !== 0);
  return <>
    {searchable ? <><p className={styles.traderBasis}><MetricHelp why="Realized plus unrealized USD PnL since launch on Blast-launched coins across all venues and linked wallets, using the same indexed history and cost basis as profile PnL. Gas is excluded. Missing or stale USD prices and incomplete history make performance unavailable. Recent activity does not affect eligibility. Missing or private performance is excluded. Search preserves global ranks.">PnL · Since launch</MetricHelp></p>
    <TraderSearch search={search} loading={query.isFetching || pending} onEdit={cancel} onSearch={submit} /></> : null}
    <div role="status" className="sr">
      {traderCount(query.data, query.isError)}
    </div>
    <TableCard>
      {issue ? <EmptyState role="alert" title={<DiagnosticText message={issue.message} />} action={issue.retry ? <Button onClick={issue.retry} size="sm">Try again</Button> : null} /> : <div aria-busy={query.isFetching || pending}>
        <TraderContent data={query.data} error={query.isError} rows={pagination.rows} open={open}
          onToggle={(key) => setOpen((current) => current === key ? null : key)} onRetry={() => void query.refetch()} />
      </div>}
      {!issue && query.data && !query.isError && query.data.total > 0 ? <TableFooter pending={query.isFetching} alwaysShow count={traderTotal(query.data)} what="traders" {...pagination} page={query.data.page} pages={pages} onPage={(page) => { pagination.onPage(page); setOpen(null); }} /> : null}
    </TableCard>
  </>;
}
