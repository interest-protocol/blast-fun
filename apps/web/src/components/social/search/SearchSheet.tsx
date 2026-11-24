"use client";

import { isEnterSubmit } from "#web/lib/ime-enter.ts";
import { scheduleDelay } from "#web/lib/schedule-delay.ts";
import { Button, IconButton } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import { FieldGroup, TextField } from "#web/components/blast-ui/TextField.tsx";
import { publicErrorMessage } from "#web/lib/errors.ts";
import { useFeedbackReveal } from "#web/components/blast-ui/feedback-motion.ts";

import clsx from "clsx";
import { IntentLink as Link } from "#web/components/blast-ui/NavigationLink.tsx";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";

import { px, signPct } from "@blast/core/web/format.ts";
import { CloseIcon, CoinVerifiedMark, HelmetMark, SearchIcon, VerifiedBadge } from "#web/components/blast-ui/Icons.tsx";
import { Sheet } from "#web/components/blast-ui/Sheet.tsx";
import { isSearchShortcut } from "#web/components/blast-ui/nav.ts";
import { useShellAction } from "#web/components/blast-ui/shell-actions.tsx";
import { PersonAvatar } from "#web/components/social/PersonAvatar.tsx";
import { ArtworkMark } from "#web/components/blast-ui/ArtworkMark.tsx";
import { PHASE_LABEL } from "@blast/core/modules/presale/presentation.ts";
import { indexedPoolCoin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { normalizeSearchQuery, type SocialSearchResponse } from "@blast/core/web/contracts/search.ts";
import type { SocialTradeCoin } from "@blast/core/web/contracts/trades.ts";

import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { OFFICIAL_CALLSIGN } from "../onboarding/onboarding-flow";
import { priceQuery } from "../prices/price-client";
import { useSocialViewer } from "../SignInGate";

import { createSearchClient, exactCoinSearchTerm, type SearchClient } from "./search-client";
import {
  coinPriceAsk,
  listedCoins,
  moveHighlight,
  noCoinMatchText,
  noCoinMatches,
  pricedCoins,
  readRecents,
  rememberRecent,
  searchEmptyTitle,
  searchGroups,
  searchHref,
  type SearchCoin,
  type SearchGroup,
  type SearchRow,
} from "./search-model";
import styles from "./Search.module.css";

/** Typing settles this long before a read (the CDN answers repeated terms). */
const DEBOUNCE_MS = 90;

function ClockIcon() {
  return (
    <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

type Read = Readonly<{ term: string; answer: SocialSearchResponse | null; coins: readonly SocialTradeCoin[] | null; failed: boolean; error?: unknown }>;

/**
 * The answer for `raw` and its sale coins (OA-41), landing together so the
 * no-match line never shows before the coins: the last answer stays on
 * screen while the next one is read (no flicker as one types), a remembered
 * answer shows at once, and a failed read is reported for Try again.
 */
function useSearch(client: SearchClient, raw: string, active: boolean) {
  const coinType = exactCoinSearchTerm(raw);
  const coinOnly = coinType !== null;
  const term = coinType ?? normalizeSearchQuery(raw) ?? raw;
  const [read, setRead] = useState<Read>(() => ({ term, answer: client.remembered(term), coins: client.rememberedCoins(term), failed: false }));
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const rememberedAnswer = coinOnly ? null : client.remembered(term);
    const rememberedCoins = client.rememberedCoins(term);
    const remembered = (coinOnly || rememberedAnswer !== null) && rememberedCoins !== null;
    const run = async () => {
      const [answer, coins] = await Promise.all([
        coinOnly ? null : rememberedAnswer ?? client.search(term, controller.signal),
        rememberedCoins ?? client.coins(term, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      const error = client.failure(term);
      setRead({ term, answer, coins, failed: (!coinOnly && answer === null) || Boolean(error), error });
    };
    const cancelRead = remembered ? null : scheduleDelay(() => void run(), term === "" ? 0 : DEBOUNCE_MS);
    if (remembered) void run();
    return () => {
      controller.abort();
      cancelRead?.();
    };
  }, [client, term, coinOnly, active, attempt]);
  const settled = read.term === term;
  const loading = !settled || (!read.failed && (read.coins === null || (!coinOnly && read.answer === null)));
  const failed = settled && read.failed;
  const ready = active && !loading;
  const answered = !loading && !failed;
  return { read, loading, failed, ready, answered, coinOnly, retry: () => setAttempt((n) => n + 1) };
}

/** The listed coins' prices and 24-hour moves (R3-20's batched, shared reads), while the sheet is open. */
function useCoinPrices(coins: ReturnType<typeof listedCoins>, active: boolean): SearchCoin[] {
  const client = useAppQueryClient();
  const prices = useQueries(
    { queries: coins.map((coin) => ({ ...priceQuery({ ...coinPriceAsk(coin), window: "24h" }), enabled: active })) },
    client,
  );
  return pricedCoins(coins, prices.map((price) => price.data));
}

/** A coin row's figures: `SYM · $price` (the price omitted when unknown) and the move, right-aligned, when known. */
function CoinRowBody({ coin }: Readonly<{ coin: SearchCoin }>) {
  const poolCoin = coin.coinType ? indexedPoolCoin(coin.coinType) : undefined;
  const verifiedCommunity = poolCoin && "verifiedCommunity" in poolCoin && poolCoin.verifiedCommunity;
  return (
    <>
      {coin.presaleId ? (
        <ArtworkMark coinType={coin.coinType} src={coin.iconUrl} fallbackId={coin.presaleId} size={34} />
      ) : (
        <CoinMark coin={{ key: coin.key, coinType: coin.coinType, iconUrl: coin.iconUrl, round: true }} />
      )}
      <span className={styles.t}>
        <b>
          <span className="nm">{coin.name}</span>
          {verifiedCommunity || coin.verifiedTeam ? <CoinVerifiedMark community={verifiedCommunity} /> : null}
        </b>
        <span>{coin.price === null ? coin.symbol : `${coin.symbol} · ${px(coin.price)}`}</span>
      </span>
      {coin.changePct === null ? null : (
        <span className={clsx(styles.chg, coin.changePct >= 0 ? "up" : "down")}>{signPct(coin.changePct)}</span>
      )}
    </>
  );
}

function SearchResultsLoading() {
  return <div aria-busy="true" aria-label="Loading search results" role="status">
    {[0, 1, 2].map((row) => <div aria-hidden="true" className={styles.item} key={row}>
      <span className={styles.ico} />
      <span className={styles.t}><b><SkeletonText>Result name</SkeletonText></b><span><SkeletonText>Result details</SkeletonText></span></span>
    </div>)}
  </div>;
}

function SearchPendingStatus({ loading, hasResults }: Readonly<{ loading: boolean; hasResults: boolean }>) {
  const message = hasResults ? "Loading results… Previous matches are shown." : "Loading results…";
  return <>{loading ? hasResults ? <div className={styles.status}><LoadingIndicator label={message} /></div> : <SearchResultsLoading /> : null}</>;
}

/**
 * The search sheet (canonical UI §12), opened by the rail's Search, the phone
 * top bar's search icon and `/` (the shell's `openSearch`). A combobox: focus
 * stays in the field; ArrowUp and ArrowDown move the highlight (wrapping),
 * the mouse moves it too, Enter opens the highlighted row (the first by
 * default). A recent term fills the field; opening a presale or a person
 * remembers it on this device (five, newest first). Slash, Escape, the scrim or
 * opening a result closes it, and focus returns to where it was.
 */
export function SearchSheet() {
  const viewer = useSocialViewer();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [composing, setComposing] = useState(false);
  const [recents, setRecents] = useState<readonly string[]>([]);
  const [highlight, setHighlight] = useState(0);
  const queries = useAppQueryClient();
  const client = useMemo(() => createSearchClient(undefined, undefined, queries), [queries]);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const ids = useId();

  useShellAction("openSearch", () => {
    setRaw("");
    setComposing(false);
    setHighlight(0);
    setRecents(readRecents(storage()));
    setOpen(true);
  });
  const { read, loading, failed, ready, answered, coinOnly, retry } = useSearch(client, raw, open && !composing);
  // The answer on screen is for the text typed, or the last one while the next is read.
  const answer = read.answer;
  // The coins listed for the term the read was for (the last ones stay while the next are read).
  const listed = useMemo(() => listedCoins(read.term, read.coins), [read.term, read.coins]);
  const coins = useCoinPrices(listed, ready);
  const groups = useMemo(() => searchGroups(read.term, answer, recents, viewer.callsign, coins), [read.term, answer, recents, viewer.callsign, coins]);
  const rows = useMemo(
    () => groups.flatMap((group) => group.rows).filter((row) => row.kind !== "coin" || row.href !== null),
    [groups],
  );
  const current = Math.min(highlight, Math.max(rows.length - 1, 0));
  const empty = answered && searchEmptyTitle(raw, answer, groups, coinOnly);
  const noCoins = noCoinMatches(read.term, answered, groups);
  useFeedbackReveal(`${read.term}:${loading}`, results);

  // The highlighted row stays in view.
  useEffect(() => {
    const row = results.current?.querySelector<HTMLElement>(`[data-row="${current}"]`);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [current, rows.length]);

  const close = () => setOpen(false);
  const pick = (row: Extract<SearchRow, { kind: "presale" | "person" }>) => {
    setRecents((now) => rememberRecent(storage(), now, row.pick));
    close();
  };
  const fill = (term: string) => {
    setRaw(term);
    setHighlight(0);
    input.current?.focus();
  };
  const activate = (index: number) => {
    if (loading) return;
    const row = rows[index] ?? rows[0];
    if (!row) return;
    if (row.kind === "recent") {
      fill(row.term);
      return;
    }
    if (row.kind === "coin") {
      if (row.href) {
        close();
        router.push(row.href);
      }
      return;
    }
    pick(row);
    router.push(searchHref(row));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!rows.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight(moveHighlight(current, event.key, rows.length));
    } else if (isEnterSubmit(event)) {
      event.preventDefault();
      activate(current);
    }
  };

  const optionId = (index: number) => `${ids}-row-${index}`;
  const positions = new Map(rows.map((row, at) => [row.key, at]));
  const rowOf = (row: SearchRow): ReactNode => {
    const at = positions.get(row.key) ?? 0;
    const common = {
      "aria-selected": !loading && at === current,
      "aria-disabled": loading || undefined,
      className: clsx(styles.item, !loading && at === current && styles.kb),
      "data-row": at,
      id: optionId(at),
      onMouseMove: () => at !== current && setHighlight(at),
      role: "option" as const,
      tabIndex: -1,
    };
    if (row.kind === "recent") {
      return (
        <button key={row.key} {...common} onClick={() => fill(row.term)} type="button">
          <span className={styles.ico}><ClockIcon /></span>
          <span className={styles.t}><b>{row.term}</b></span>
        </button>
      );
    }
    if (row.kind === "coin") {
      return row.href === null ? (
        <div aria-disabled="true" aria-selected={false} className={styles.item} key={row.key} role="option">
          <CoinRowBody coin={row.coin} />
        </div>
      ) : (
        <Link key={row.key} {...common} href={row.href} onNavigate={close}>
          <CoinRowBody coin={row.coin} />
        </Link>
      );
    }
    if (row.kind === "presale") {
      return (
        <Link key={row.key} {...common} href={searchHref(row)} onClick={() => pick(row)}>
          <ArtworkMark coinType={row.presale.coin_type} src={row.presale.icon_url} fallbackId={row.presale.presale_id} size={34} />
          <span className={styles.t}>
            <b>
              <span className="nm">{row.presale.name}</span>
              {row.presale.verified_team ? <CoinVerifiedMark /> : null}
            </b>
            <span>{row.presale.symbol} · {PHASE_LABEL[row.presale.phase]}</span>
          </span>
        </Link>
      );
    }
    return (
      <Link key={row.key} {...common} href={searchHref(row)} onClick={() => pick(row)}>
        {row.person.callsign === OFFICIAL_CALLSIGN ? (
          <span aria-hidden="true" className={clsx("av s34", styles.official)}><HelmetMark /></span>
        ) : (
          <PersonAvatar person={row.person} size={34} />
        )}
        <span className={styles.t}>
          <b>
            <span className="nm">{row.person.display_name ?? row.person.callsign}</span>
            {row.person.verified ? <VerifiedBadge className="verified" /> : null}
          </b>
          <span>@{row.person.callsign}</span>
        </span>
      </Link>
    );
  };
  const groupOf = (group: SearchGroup) => (
    <div aria-labelledby={`${ids}-${group.id}`} key={group.id} role="group">
      <div className={styles.h} id={`${ids}-${group.id}`} role="presentation">{group.title}</div>
      {group.rows.map(rowOf)}
    </div>
  );

  return (
    <Sheet
      className={styles.sheet}
      initialFocus={() => input.current}
      labelledBy={`${ids}-title`}
      onKeyDown={(event) => {
        if (!composing && isSearchShortcut(event.nativeEvent)) {
          event.preventDefault();
          close();
        }
      }}
      onRequestClose={close}
      open={open}
    >
      <span hidden id={`${ids}-title`}>Search</span>
      <FieldGroup className={styles.box}>
        <span aria-hidden="true" className={styles.icon}><SearchIcon /></span>
        <TextField
          aria-activedescendant={!loading && rows.length ? optionId(current) : undefined}
          aria-autocomplete="list"
          aria-controls={`${ids}-results`}
          aria-expanded={groups.length > 0}
          aria-keyshortcuts="/"
          aria-label="Search"
          autoComplete="off"
          className={styles.field}
          enterKeyHint="go"
          onChange={(event) => {
            setRaw(event.target.value);
            setHighlight(0);
          }}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={onKeyDown}
          placeholder="Search coins, presales and people"
          ref={input}
          role="combobox"
          size="lg"
          spellCheck={false}
          type="text"
          inputMode="search"
          value={raw}
        />
        {raw ? <IconButton size="xs" onClick={() => { setRaw(""); setHighlight(0); input.current?.focus(); }} aria-label="Clear search" title="Clear search"><CloseIcon /></IconButton> : null}
      </FieldGroup>
      {groups.length || empty || failed || loading ? (
        <div className={styles.res} ref={results}>
          {noCoins ? <p className={styles.noCoins} role="status">{noCoinMatchText(read.term)}</p> : null}
          <div aria-busy={loading || undefined} aria-label="Results" className={styles.results} id={`${ids}-results`} inert={loading || undefined} role="listbox">
            {groups.map(groupOf)}
          </div>
          <SearchPendingStatus hasResults={groups.length > 0} loading={loading} />
          {empty ? <EmptyState role="status" title={empty} /> : null}
          {failed ? (
            <EmptyState action={<Button onClick={retry} size="sm">Try again</Button>} role="alert" title="Search isn’t available right now">
              {publicErrorMessage(read.error, "Try again shortly.", "service_unavailable")}
            </EmptyState>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}
