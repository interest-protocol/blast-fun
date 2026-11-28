import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { explorerTransactionUrl as socialTransactionUrl } from "@blast/core/lib/explorer.ts";
import { bxAgo, countWords } from "@blast/core/lib/format.ts";
import { compareEventCursors } from "@blast/core/modules/launchpad-contract/cursor.ts";
import type { SocialExplorer } from "@blast/core/modules/social/contracts/settings.ts";
import { profilePagePath } from "@blast/core/modules/social/contracts/profiles.ts";
import { RECENT_TRADES_LIMIT, type TraderProfile } from "@blast/core/modules/social/contracts/trader-profiles.ts";
import { atomsGrouped, NO_VALUE } from "@blast/core/web/format.ts";
import type { Exact } from "@blast/core/web/exact-amount.ts";
import { IconButtonLink } from "#web/components/blast-ui/Button.tsx";
import { CoinAmount } from "#web/components/blast-ui/CoinAmount.tsx";
import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { UserIcon } from "#web/components/blast-ui/Icons.tsx";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { ShellAvatar } from "#web/components/blast-ui/ShellAvatar.tsx";
import { SkeletonBox, SkeletonRows, SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { Ticker } from "#web/components/blast-ui/Ticker.tsx";
import { TransactionLink } from "#web/components/blast-ui/TransactionLink.tsx";
import { useCommitClock } from "#web/components/social/commit/commit-clock.ts";
import { formatAmountShort } from "../coin/coin-format";
import primitives from "../primitives/primitives.module.css";
import { explorerTransactionUrl } from "../transaction/explorer";
import { SmallTradeSwitch } from "./SmallTradeSwitch";
import { tradeFloor } from "./small-trades";
import { useTradeSlide } from "./use-trade-slide";
import { useWalletExplorer } from "./TraderWallet";
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
        <code className={styles.mono} aria-hidden="true">{short}</code>
        <span className={primitives.srOnly}>{digest}</span>
      </span>
    );
  }
  return <TransactionLink href={url} />;
}

export function TradeListSkeleton({ count = RECENT_TRADES_LIMIT }: Readonly<{ count?: number }> = {}) {
  return <SkeletonRows label="Reading trades" count={count} className={`${styles.tradeList} ${styles.tradeLoading}`} rowClassName={styles.tradeRow}>
    <span className={styles.tradeType}><SkeletonText>Buy or sell</SkeletonText></span>
    <span className={styles.trader}>
      <SkeletonBox className={styles.defaultAvatar} round />
      <SkeletonText>Trader address</SkeletonText>
    </span>
    <span className={styles.tradeAmount}><SkeletonText>Trade amounts</SkeletonText></span>
    <span className={styles.tradeLink}><SkeletonBox className={styles.defaultAvatar} /></span>
  </SkeletonRows>;
}

/** A trader's face opens who they are: their Blast profile, or else their wallet on the viewer's explorer. */
function TraderAvatar({ profile, wallet }: Readonly<{ profile: TraderProfile | null; wallet: string | null }>) {
  const explorer = useWalletExplorer(profile ? null : wallet);
  if (profile) {
    return <IconButtonLink size="touch" className={styles.traderFace} href={profilePagePath(profile.callsign)} aria-label={`View @${profile.callsign}’s Blast profile`}>
      <ShellAvatar viewer={{ accountId: profile.callsign, callsign: profile.callsign, avatarUrl: profile.avatarUrl }} size={32} />
    </IconButtonLink>;
  }
  if (!explorer) return <span className={styles.defaultAvatar} role="img" aria-label="Wallet trader"><UserIcon /></span>;
  return <IconButtonLink size="touch" className={styles.traderFace} href={explorer.url} rel="noopener noreferrer" target="_blank" aria-label={explorer.label} title={explorer.label}>
    <span className={styles.walletFace}><UserIcon /></span>
  </IconButtonLink>;
}

const TradeInspectContext = createContext<(open: boolean) => void>(() => {});

export const useTradeInspector = () => useContext(TradeInspectContext);

export type TradeRowState = Readonly<{
  entering: boolean;
  leaving: boolean;
}>;

/**
 * `isUnder(row, floor)`: the row is a trade proven under `floor` dollars. Tiny trades never show; with
 * the "Hide trades under $1" switch on (its state owned by whoever reads the rows), dust does not either.
 */
export function useTradeVisibility<Row extends { position: string }>(
  rows: readonly Row[],
  availableRows: readonly Row[] | undefined,
  isUnder: (row: Row, floor: Exact) => boolean,
  [hideSmallTrades, setHideSmallTrades]: readonly [boolean, (hide: boolean) => void],
) {
  const [heldRows, setHeldRows] = useState<readonly Row[] | null>(null);
  const floor = tradeFloor(hideSmallTrades);
  const hidden = (row: Row) => isUnder(row, floor);
  const visibleRows = heldRows ?? filteredTrades(rows, availableRows, hidden);
  const holdRows = useCallback((active: boolean) => {
    setHeldRows((previous) => active ? previous ?? visibleRows : null);
  }, [visibleRows]);
  return {
    rows: visibleRows,
    held: heldRows !== null,
    holdRows,
    hideSmallTrades,
    changeFilter(checked: boolean) {
      setHeldRows(null);
      setHideSmallTrades(checked);
    },
    allows: (row: Row) => !hidden(row),
  };
}

/** Both launch types use the same motion, focus hold and row spacing. */
export function CompactTradeList<Row extends { position: string }>({
  visibility, entering, leaving, slide, hold, children,
}: Readonly<{
  visibility: ReturnType<typeof useTradeVisibility<Row>>;
  entering?: string | null;
  leaving?: Row | null;
  slide?: boolean;
  hold?: (hold: boolean) => void;
  children: (row: Row, state: TradeRowState) => ReactNode;
}>) {
  const { rows: visibleRows, held, holdRows, hideSmallTrades, changeFilter, allows } = visibility;
  const list = useRef<HTMLOListElement>(null);
  const keyboardFocus = useRef(false);
  const openInspectors = useRef(0);
  const updateHold = useCallback((active: boolean) => {
    holdRows(active);
    hold?.(active);
  }, [hold, holdRows]);
  const onInspect = useCallback((open: boolean) => {
    openInspectors.current += open ? 1 : -1;
    updateHold(keyboardFocus.current || openInspectors.current > 0);
  }, [updateHold]);
  const animate = !held && slide && entering === visibleRows[0]?.position;
  useTradeSlide(list, entering, animate);

  const rendered = leaving && animate && allows(leaving) &&
    !visibleRows.some((row) => row.position === leaving.position)
    ? [...visibleRows, leaving]
    : visibleRows;
  return <>
    <SmallTradeSwitch checked={hideSmallTrades} onCheckedChange={changeFilter} />
    {visibleRows.length ? (
      <TradeInspectContext value={onInspect}>
        <div className={styles.tradeViewport}>
          <ol ref={list} className={styles.tradeList} aria-label="Recent trades"
            onFocusCapture={(event) => {
              keyboardFocus.current = event.target.matches(":focus-visible");
              updateHold(keyboardFocus.current || openInspectors.current > 0);
            }}
            onBlurCapture={(event) => {
              if (event.currentTarget.contains(event.relatedTarget)) return;
              keyboardFocus.current = false;
              updateHold(openInspectors.current > 0);
            }}
          >
            {rendered.map((row) => children(row, {
              entering: row.position === entering, leaving: row === leaving,
            }))}
          </ol>
        </div>
      </TradeInspectContext>
    ) : <EmptyState compact title="No trades match this filter" />}
  </>;
}

function filteredTrades<Row extends { position: string }>(
  rows: readonly Row[],
  availableRows: readonly Row[] | undefined,
  hidden: (row: Row) => boolean,
) {
  const visible = rows.filter((row) => !hidden(row));
  const tail = rows.at(-1);
  if (!tail || visible.length === rows.length) {
    return visible;
  }
  for (const row of availableRows ?? []) {
    if (compareEventCursors(row.position, tail.position) < 0 && !hidden(row)) {
      visible.push(row);
      if (visible.length === rows.length) {
        break;
      }
    }
  }
  return visible;
}

export function CompactTradeRow({
  side, trader, profile, wallet = null, timestampMs, tokens, quote, digest, explorer, entering, leaving,
}: TradeRowState & Readonly<{
  side: "buy" | "sell";
  trader: ReactNode;
  profile: TraderProfile | null;
  /** The trader's wallet, when the row knows it: a trader with no profile links to it on the explorer. */
  wallet?: string | null;
  timestampMs: number;
  tokens: ReactNode;
  quote: ReactNode;
  digest: string | null;
  explorer: TradeExplorer;
}>) {
  const onInspect = useTradeInspector();
  return <li className={styles.tradeRow} data-live-trade={entering ? side : undefined} data-leaving={leaving || undefined} inert={leaving} aria-hidden={leaving || undefined}>
    <span className={styles.tradeType}>
      <b data-side={side}>{side === "sell" ? "Sell" : "Buy"}</b>{" · "}
      <TradeAge at={timestampMs} onInspect={onInspect} />
    </span>
    <span className={styles.trader}>
      <TraderAvatar profile={profile} wallet={wallet} />
      <span className={styles.traderText}>{trader}</span>
    </span>
    <span className={styles.tradeAmount}>
      <span className={styles.tradeLeg}>{tokens}</span>
      {quote != null && <>{" "}<span className={styles.tradeLeg}>for{" "}{quote}</span></>}
    </span>
    {digest ? <span className={styles.tradeLink}><Transaction digest={digest} explorer={explorer} /></span> : null}
  </li>;
}

/** The only part of a row that redraws each second: one shared clock serves every row's age. */
function TradeAge({ at, onInspect }: Readonly<{ at: number; onInspect: (open: boolean) => void }>) {
  const now = useCommitClock();
  const age = now === 0 ? undefined : bxAgo(at, now);
  return <DateStamp at={at} label="trade time" displayText={age} triggerLabel={tradeTimeButtonLabel(age)} onInspect={onInspect} />;
}

const ageUnits: Partial<Record<string, string>> = { s: "second", m: "minute", h: "hour", d: "day", y: "year" };

function tradeTimeButtonLabel(age?: string) {
  if (!age) return "Trade time";
  if (age === "now") return "Trade time, just now";
  const unit = ageUnits[age.slice(-1)];
  return unit ? `Trade time, ${countWords(Number(age.slice(0, -1)), unit, `${unit}s`)} ago` : "Trade time";
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
