"use client";

import clsx from "clsx";
import { useState } from "react";

import { Button } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { CoinVerifiedMark } from "#web/components/blast-ui/Icons.tsx";
import { IntentLink as Link } from "#web/components/blast-ui/NavigationLink.tsx";
import { Pager } from "#web/components/blast-ui/Pager.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { useSeededQuery } from "#web/lib/query/seed.ts";
import { fillPercent, timeUntil } from "@blast/core/web/format.ts";
import type { HomeCoin, HomeCoinsByIds, HomeWindow } from "@blast/core/web/contracts/home.ts";
import type { SocialHappeningResponse } from "@blast/core/web/contracts/happening.ts";

import { presaleHref } from "../feed-ui/shell-bridge-model";
import { happeningStore } from "../happening/happening-store";
import { Fill } from "../happening/parts";
import { useHappening, useSecondClock } from "../happening/use-happening";
import { PresaleMark } from "../post/PostMedia";
import { saleLifecycleAt } from "@blast/core/web/contracts/presales.ts";
import styles from "./CoinHome.module.css";
import { coinsByIdsQuery } from "./home-client";
import { lifecycleTone, raiseAmounts } from "./home-model";
import { presaleIdsOf, presaleSeed } from "./presale-ids";

/** One row of the board's cards: three abreast. */
const CARDS_PER_PAGE = 3;

type Props = Readonly<{
  happening: SocialHappeningResponse | null;
  /** The sales' items as the server read them, for the first paint. */
  initial: HomeCoinsByIds | null;
  initialMs: number;
  window: HomeWindow;
  nowMs: number;
}>;

type SaleCoin = HomeCoin & { presale_id: string };

/**
 * The Presales section (the Main board): the open and upcoming sales the
 * happening read names, as cards three abreast, each its mark, name and
 * ticker, its stage, the raise bar, raised of target in the coin it raises
 * and the time left. A card opens the sale's page; more sales than one row
 * page with the shared pager. The header (and "All presales") is the
 * sections wrapper's; this draws the cards, or says when there are none.
 */
export function PresaleSection({ happening, initial, initialMs, window, nowMs }: Props) {
  const client = useAppQueryClient();
  const { read, failed } = useHappening(happening);
  const current = read ?? happening;
  const clock = useSecondClock(nowMs);
  const { ids } = presaleIdsOf(current, clock);
  const query = useSeededQuery({ ...coinsByIdsQuery(ids, window), enabled: ids.length > 0 }, presaleSeed(initial, ids, window), initialMs, client);
  const [page, setPage] = useState(1);
  const coins = ids.flatMap((id): SaleCoin[] => {
    const coin = query.data?.coins.find((row) => row.presale_id === id);
    return coin && coin.presale_id !== null ? [{ ...coin, presale_id: coin.presale_id }] : [];
  });
  const retry = () => { void happeningStore().refresh(); void query.refetch(); };
  const failure = <EmptyState action={<Button onClick={retry} size="sm">Retry</Button>} framed listEmpty role="alert" title="Presales couldn’t load" />;
  const none = <EmptyState framed listEmpty title="No presale is open right now" />;
  if (current === null) {
    if (failed) return failure;
    return <SaleCardsLoading count={CARDS_PER_PAGE} />;
  }
  if (ids.length === 0) return none;
  if (query.data === undefined) {
    if (query.isError) return failure;
    return <SaleCardsLoading count={Math.min(ids.length, CARDS_PER_PAGE)} />;
  }
  if (coins.length === 0) return none;
  const pages = Math.ceil(coins.length / CARDS_PER_PAGE);
  const shown = Math.min(page, pages);
  return (
    <>
      {failed || query.isError ? <p className={styles.marketNotice} role="alert">Couldn’t refresh presales. Showing the previous result. <Button onClick={retry} size="xs">Retry</Button></p> : null}
      <ul aria-label="Presales" className={styles.saleCards}>
        {coins.slice((shown - 1) * CARDS_PER_PAGE, shown * CARDS_PER_PAGE).map((coin) => <li key={coin.presale_id}><SaleCard coin={coin} nowMs={clock} /></li>)}
      </ul>
      <Pager className={styles.salePager} onPage={setPage} page={shown} pages={pages} what="presales" />
    </>
  );
}

/** The stage as the pill says it (`saleLifecycleAt`): Live, Upcoming, Funded, Cancelled. */
function stageWord(lifecycle: string): string {
  switch (lifecycle) {
    case "open": return "Live";
    case "pending": return "Upcoming";
    case "funded": return "Funded";
    case "migrated": return "Trading";
    default: return lifecycle.charAt(0).toUpperCase() + lifecycle.slice(1);
  }
}

/** When the sale closes or opens, to the minute (`1d 4h left`, `Opens in 39m`); nothing once it has neither. */
function saleTime(coin: SaleCoin, nowMs: number): string | null {
  if (coin.sale === null) return null;
  const coarse = (ms: number) => timeUntil(ms, nowMs).replace(/\s*\d+s$/, "") || "<1m";
  const lifecycle = saleLifecycleAt(coin.lifecycle, coin.sale.start_ms, nowMs);
  if (lifecycle === "open" && coin.sale.end_ms > nowMs) return `${coarse(coin.sale.end_ms)} left`;
  if (lifecycle === "pending" && coin.sale.start_ms > nowMs) return `Opens in ${coarse(coin.sale.start_ms)}`;
  return null;
}

function SaleCard({ coin, nowMs }: Readonly<{ coin: SaleCoin; nowMs: number }>) {
  const lifecycle = saleLifecycleAt(coin.lifecycle, coin.sale?.start_ms, nowMs);
  const tone = lifecycleTone(lifecycle);
  const { raised, target } = raiseAmounts(coin);
  const pct = coin.sale === null ? 0 : Math.min(100, fillPercent(Number(coin.sale.raised), Number(coin.sale.raise_target)));
  const time = saleTime(coin, nowMs);
  return (
    <Link className={clsx("card", styles.saleCard)} href={presaleHref(coin.presale_id)}>
      <span className={styles.saleHead}>
        <PresaleMark coinType={coin.coin_type} presaleId={coin.presale_id} size={44} src={coin.icon_url} />
        <span className={styles.saleName}>
          <b className="coinNamed"><span className="nm">{coin.name}</span>{coin.verified_team ? <CoinVerifiedMark /> : null}</b>
          <span>${coin.symbol}</span>
        </span>
        <span className="status" data-tone={tone}>{stageWord(lifecycle)}</span>
      </span>
      {coin.sale !== null ? (
        <span aria-label={`Raised ${raised ?? "unknown"} of ${target ?? "unknown"}`} aria-valuemax={100} aria-valuemin={0} aria-valuenow={pct} className={styles.saleBar} data-tone={tone} role="progressbar">
          <Fill pct={pct} />
        </span>
      ) : null}
      <span className={styles.saleFoot}>
        {raised !== null ? <span className="num"><b>{raised}</b>{target !== null ? <span className={styles.ofTarget}> of {target}</span> : null}</span> : <span />}
        {time !== null ? <span className={clsx("num", styles.saleTime)}>{time}</span> : null}
      </span>
    </Link>
  );
}

/** The cards' geometry while the first read is out. */
export function SaleCardsLoading({ count = CARDS_PER_PAGE }: Readonly<{ count?: number }>) {
  return (
    <ul aria-busy="true" aria-label="Loading presales" className={styles.saleCards} data-list-pending="" role="status">
      {Array.from({ length: count }, (_, key) => (
        <li aria-hidden="true" key={key}>
          <span className={clsx("card", styles.saleCard)}>
            <span className={styles.saleHead}>
              <span className={styles.skMark} />
              <span className={styles.saleName}><b><SkeletonText>Presale name</SkeletonText></b><span><SkeletonText>Ticker</SkeletonText></span></span>
            </span>
            <span className={styles.saleBar} />
            <span className={styles.saleFoot}><span><SkeletonText>Raised of target</SkeletonText></span></span>
          </span>
        </li>
      ))}
    </ul>
  );
}
