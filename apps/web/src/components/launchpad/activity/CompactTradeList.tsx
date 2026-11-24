import { createContext, useCallback, useContext, useRef, useSyncExternalStore, type ReactNode } from "react";
import { explorerTransactionUrl as socialTransactionUrl } from "@blast/core/lib/explorer.ts";
import type { SocialExplorer } from "@blast/core/modules/social/contracts/settings.ts";
import { profilePagePath } from "@blast/core/modules/social/contracts/profiles.ts";
import { RECENT_TRADES_LIMIT, type TraderProfile } from "@blast/core/modules/social/contracts/trader-profiles.ts";
import { atomsGrouped, NO_VALUE } from "@blast/core/web/format.ts";
import { IconButtonLink } from "#web/components/blast-ui/Button.tsx";
import { CoinAmount } from "#web/components/blast-ui/CoinAmount.tsx";
import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { tradeTimeLabel } from "#web/components/blast-ui/date-label.ts";
import { UserIcon } from "#web/components/blast-ui/Icons.tsx";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { ShellAvatar } from "#web/components/blast-ui/ShellAvatar.tsx";
import { SkeletonBox, SkeletonRows, SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { Ticker } from "#web/components/blast-ui/Ticker.tsx";
import { TransactionLink } from "#web/components/blast-ui/TransactionLink.tsx";
import { formatAmountShort } from "../coin/coin-format";
import primitives from "../primitives/primitives.module.css";
import { explorerTransactionUrl } from "../transaction/explorer";
import { useTradeSlide } from "./use-trade-slide";
import styles from "./Activity.module.css";

export type TransactionExplorer = Readonly<{ environment: string; explorer: Readonly<{ baseUrl: string }> }>;

export type TradeExplorer = TransactionExplorer | SocialExplorer | null;

export function Transaction({ digest, explorer }: Readonly<{ digest: string; explorer: TradeExplorer }>) {
  // The builder compares `environment` with "non-production" only; any other value is held to https.
  const url = typeof explorer === "string"
    ? socialTransactionUrl(explorer, digest)
    : explorer && explorerTransactionUrl(explorer as Parameters<typeof explorerTransactionUrl>[0], digest);
  const short = `${digest.slice(0, 6)}…${digest.slice(-4)}`;
  if (!url) {
    return (
      <span>
        <code className={styles.mono} aria-hidden="true" title={digest}>{short}</code>
        <span className={primitives.srOnly}>{digest}</span>
      </span>
    );
  }
  return <TransactionLink href={url} />;
}

export function TradeListSkeleton({ count = RECENT_TRADES_LIMIT }: Readonly<{ count?: number }> = {}) {
  return <SkeletonRows label="Reading trades" count={count} className={`${styles.tradeList} ${styles.tradeLoading}`} rowClassName={styles.tradeRow}>
    <span className={styles.trader}>
      <SkeletonBox className={styles.defaultAvatar} round />
      <span className={styles.traderText}><SkeletonText>Trader address</SkeletonText><SkeletonText>Trade time</SkeletonText></span>
    </span>
    <span className={styles.tradeAmount}><SkeletonText>Trade amounts</SkeletonText></span>
    <SkeletonBox className={styles.defaultAvatar} />
  </SkeletonRows>;
}

function TraderAvatar({ profile }: Readonly<{ profile: TraderProfile | null }>) {
  return profile ? (
    <IconButtonLink size="touch" href={profilePagePath(profile.callsign)} aria-label={`View @${profile.callsign}’s Blast profile`}>
      <ShellAvatar viewer={{ accountId: profile.callsign, callsign: profile.callsign, avatarUrl: profile.avatarUrl }} size={32} />
    </IconButtonLink>
  ) : <span className={styles.defaultAvatar} role="img" aria-label="Wallet trader"><UserIcon /></span>;
}

const localDaySnapshot = () => new Date().setHours(0, 0, 0, 0);
const serverDaySnapshot = () => null;

function subscribeLocalDay(notify: () => void) {
  let timer: ReturnType<typeof setTimeout>;
  function schedule() {
    const now = Date.now();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    timer = setTimeout(refresh, midnight.getTime() - now);
  }
  function refresh() {
    clearTimeout(timer);
    schedule();
    notify();
  }
  schedule();
  document.addEventListener("visibilitychange", refresh);
  return () => {
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", refresh);
  };
}

const TradeInspectContext = createContext<(open: boolean) => void>(() => {});

export const useTradeInspector = () => useContext(TradeInspectContext);

export type TradeRowState = Readonly<{
  entering: boolean;
  leaving: boolean;
  localDay: number | null;
}>;

/** Both launch types use the same motion, focus hold and row spacing. */
export function CompactTradeList<Row extends { position: string }>({
  rows, entering, leaving, slide, hold, children,
}: Readonly<{
  rows: readonly Row[];
  entering?: string | null;
  leaving?: Row | null;
  slide?: boolean;
  hold?: (hold: boolean) => void;
  children: (row: Row, state: TradeRowState) => ReactNode;
}>) {
  const localDay = useSyncExternalStore(subscribeLocalDay, localDaySnapshot, serverDaySnapshot);
  const list = useRef<HTMLOListElement>(null);
  const keyboardFocus = useRef(false);
  const openInspectors = useRef(0);
  const onInspect = useCallback((open: boolean) => {
    openInspectors.current += open ? 1 : -1;
    hold?.(keyboardFocus.current || openInspectors.current > 0);
  }, [hold]);
  useTradeSlide(list, entering, slide);

  const rendered = leaving ? [...rows, leaving] : rows;
  return <TradeInspectContext value={onInspect}><div className={styles.tradeViewport}>
    <ol ref={list} className={styles.tradeList} aria-label="Recent trades"
      onFocusCapture={(event) => {
        keyboardFocus.current = event.target.matches(":focus-visible");
        hold?.(keyboardFocus.current || openInspectors.current > 0);
      }}
      onBlurCapture={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        keyboardFocus.current = false;
        hold?.(openInspectors.current > 0);
      }}
    >
      {rendered.map((row) => children(row, {
        entering: row.position === entering, leaving: row === leaving, localDay,
      }))}
    </ol>
  </div></TradeInspectContext>;
}

export function CompactTradeRow({
  side, trader, profile, timestampMs, tokens, quote, digest, explorer, entering, leaving, localDay,
}: TradeRowState & Readonly<{
  side: "buy" | "sell";
  trader: ReactNode;
  profile: TraderProfile | null;
  timestampMs: number;
  tokens: ReactNode;
  quote: ReactNode;
  digest: string | null;
  explorer: TradeExplorer;
}>) {
  const onInspect = useTradeInspector();
  return <li className={styles.tradeRow} data-live-trade={entering ? side : undefined} data-leaving={leaving || undefined} inert={leaving} aria-hidden={leaving || undefined}>
    <span className={styles.trader}>
      <TraderAvatar profile={profile} />
      <span className={styles.traderText}>
        {trader}
        <DateStamp at={timestampMs} label="trade time" onInspect={onInspect}
          displayText={localDay === null ? undefined : tradeTimeLabel(timestampMs, localDay)} />
      </span>
    </span>
    <span className={styles.tradeAmount}>
      <span className={styles.tradeLeg}>
        <b data-side={side}>{side === "sell" ? "Sold" : "Bought"}</b>{" "}{tokens}
      </span>
      {quote != null && <>{" "}<span className={styles.tradeLeg}>for{" "}{quote}</span></>}
    </span>
    {digest ? <Transaction digest={digest} explorer={explorer} /> : null}
  </li>;
}

const ZERO_ATOMS = 0n;
const DECIMAL_BASE = 10n;

export function ActivityAmount({ amount, decimals, symbol, coinType, iconUrl, compact, iconOnly, signed, mark, onInspect }: Readonly<{
  amount?: bigint; decimals: number | null; symbol: string; coinType?: string | null; iconUrl?: string | null;
  compact?: boolean; iconOnly?: boolean; signed?: boolean; mark?: ReactNode;
  onInspect?: (open: boolean) => void;
}>) {
  if (amount == null || decimals === null) return <span className={styles.muted}>{NO_VALUE}</span>;
  const sign = amount < ZERO_ATOMS ? "−" : signed && amount > ZERO_ATOMS ? "+" : "";
  const magnitude = amount < ZERO_ATOMS ? -amount : amount;
  const millions = compact && magnitude >= DECIMAL_BASE ** BigInt(decimals + 6);
  const display = millions ? `${formatAmountShort(magnitude, decimals + 6)}M` : formatAmountShort(magnitude, decimals);
  return (
    <InspectValue value={`${sign}${atomsGrouped(magnitude, decimals)} ${symbol}`} label={`${symbol} amount`} onOpenChange={onInspect}>
      {iconOnly ? (
        <CoinAmount amount={sign + display} symbol={symbol} coinType={coinType} iconUrl={iconUrl} />
      ) : (
        <span className={mark ? styles.markedAmount : undefined}>
          {mark}
          <span>{sign}{display}{"\u00a0"}<Ticker symbol={symbol} bare /></span>
        </span>
      )}
    </InspectValue>
  );
}
