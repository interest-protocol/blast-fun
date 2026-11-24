"use client";

import { scheduleDelay } from "#web/lib/schedule-delay.ts";
import {
  coinPriority,
  coreCoin,
  PREFERRED_COINS,
} from "@blast/core/modules/social/portfolio/core-coins.ts";

import { diagnosticMessage, publicErrorMessage } from "#web/lib/errors.ts";

import { Combobox } from "@base-ui/react/combobox";
import { Button, IconButton } from "#web/components/blast-ui/Button.tsx";
import { FieldGroup, TextField } from "#web/components/blast-ui/TextField.tsx";
import clsx from "clsx";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CoinRowsLoading } from "./CoinRowsLoading";
import { ClientOnly } from "#web/components/ui-libraries/use-hydrated.tsx";

import { formatVestingAmount } from "@blast/core/modules/vesting/model.ts";
import { HIDDEN_AMOUNT } from "@blast/core/web/format.ts";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { CoinIdentity } from "#web/components/social/coins/CoinIdentity.tsx";
import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { isSmallBalance } from "@blast/core/modules/social/portfolio/small-balance.ts";
import type { CoinSheetTrading } from "./SwapForm";
import type { HoldingsLoader, HoldingsPage } from "./CoinBrowser";
import {
  withPreferredCoins,
  type WalletCoinCatalogPage,
  type WalletCoinView,
} from "./coin-model";
import styles from "./coins.module.css";
import { CloseIcon } from "#web/components/blast-ui/Icons.tsx";
import { KnowCheckIcon, SearchIcon } from "./icons";
import {
  canTrade,
  noMatchText,
  pickerFigures,
  pickerGroups,
  pickerMatch,
  pickerQuery,
  visibleInSwapPicker,
} from "./swap-model";

/** The pause in typing before the coins route is searched (the held coins filter at once). */
export const PICKER_SEARCH_MS = 200;
const compactAmount = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 4,
});

function isCoinArray(
  value: readonly WalletCoinView[] | WalletCoinCatalogPage,
): value is readonly WalletCoinView[] {
  return Array.isArray(value);
}
function mergeCoins(
  left: readonly WalletCoinView[],
  right: readonly WalletCoinView[],
) {
  return [
    ...new Map(
      [...left, ...right].map((coin) => [coin.coinType, coin]),
    ).values(),
  ];
}

// Move module and struct names are case-sensitive; only text searches can be folded.
function coinSearchTerm(query: string, purpose: "swap" | "vesting"): string {
  return purpose === "vesting" && query.includes("::")
    ? query.trim()
    : pickerQuery(query);
}

type Group = Readonly<{ value: string; items: readonly WalletCoinView[] }>;

function eligible(
  coin: WalletCoinView,
  allowPresales: boolean,
  purpose = "swap",
): boolean {
  return (
    purpose === "vesting" ||
    (coin.metadataAvailable !== false &&
      (canTrade(coin) || (allowPresales && coin.presale?.inPresale === true)))
  );
}

function pickerCopy(coin: WalletCoinView, allowPresales: boolean): string {
  if (coin.metadataAvailable === false) return "Metadata unavailable";
  if (coin.presale?.inPresale) {
    if (!allowPresales) return "In presale · Selling unavailable";
    return coin.presale.quoteSymbol && coin.presale.quoteType
      ? `In presale · Pay with ${coin.presale.quoteSymbol}`
      : "In presale · View accepted payment coin";
  }
  return coin.presale?.trading === false ? "Not trading yet" : coin.symbol;
}

type TokenPickerProps = Readonly<{
  /** The coin this side has now (ticked). */
  current: WalletCoinView | null;
  wallet: readonly WalletCoinView[];
  pins: readonly string[];
  hidden: boolean;
  listCoins: CoinSheetTrading["listCoins"];
  listHoldings?: HoldingsLoader;
  onPick: (coin: WalletCoinView) => void;
  allowPresales?: boolean;
  /** Vesting accepts every coin, independently of trading eligibility. */
  purpose?: "swap" | "vesting";
  balancesKnown?: boolean;
  /** Additional context-specific shortcuts, including a presale’s accepted asset. */
  quickChoices?: readonly WalletCoinView[];
  catalogCoins?: readonly WalletCoinView[];
  /** Temporary live-event choices; retain normal eligibility and canonical-type deduplication. */
  featuredCoins?: readonly WalletCoinView[];
  children?: ReactNode;
}>;

function usePickerCatalog(listCoins: TokenPickerProps["listCoins"], term: string, cursor: string | null, revision: number) {
  const [remote, setRemote] = useState<Readonly<{
    term: string;
    coins: readonly WalletCoinView[];
    failed: boolean;
    revision: number;
    cursor?: string | null;
    nextCursor?: string | null;
    message?: string;
  }> | null>(null);
  // The coins route, searched after a pause; the newest search wins.
  useEffect(() => {
    const controller = new AbortController();
    const cancelRead = scheduleDelay(
      () => {
        void listCoins(term === "" ? null : term, controller.signal, cursor)
          .then((answer) => {
            const page: WalletCoinCatalogPage | null =
              answer === null
                ? null
                : isCoinArray(answer)
                  ? { coins: answer, nextCursor: null }
                  : answer;
            if (!controller.signal.aborted)
              setRemote((current) => ({
                term,
                revision,
                coins:
                  cursor && current?.term === term
                    ? mergeCoins(current.coins, page?.coins ?? [])
                    : (page?.coins ?? []),
                failed: page === null,
                cursor,
                nextCursor: page?.nextCursor,
              }));
          })
          .catch((error) => {
            if (!controller.signal.aborted)
              setRemote((current) => ({
                term,
                revision,
                coins: current?.term === term ? current.coins : [],
                failed: true,
                cursor,
                message: publicErrorMessage(
                  error,
                  "More coins could not load. Try searching again.",
                  "service_unavailable",
                ),
              }));
          });
      },
      term === "" ? 0 : PICKER_SEARCH_MS,
    );
    return () => {
      controller.abort();
      cancelRead();
    };
  }, [listCoins, term, cursor, revision]);

  const loading =
    remote === null || remote.term !== term || remote.cursor !== cursor || remote.revision !== revision;
  const failed = !loading && remote.failed;

  return { remote, loading, failed };
}

/** The class a `Sheet` holding only this picker takes, so filtering never moves its top (audit BM-06). */
export const TOKEN_PICKER_SHEET = styles.pickerSheet;

/**
 * The picker, rendered in the browser only: base-ui's Combobox writes a
 * visually hidden form input with an inline style, which the CSP refuses in
 * server HTML (OA-28, ui-libraries.md §2 rule 1). The sheet opens on a press,
 * so this matters only for a fixture that opens it on the server; until
 * hydration the search field's frame holds the place.
 */
export function TokenPicker(props: TokenPickerProps) {
  return (
    <ClientOnly
      fallback={<div aria-hidden="true" className={styles.tpSearch} />}
    >
      <TokenPickerBody {...props} />
    </ClientOnly>
  );
}

function PickerQuickChoices({ allowPresales, current, featuredCoins, onPick, purpose, quickChoices, wallet }: Readonly<{
  allowPresales: boolean;
  current: TokenPickerProps["current"];
  featuredCoins: readonly WalletCoinView[];
  onPick: TokenPickerProps["onPick"];
  purpose: NonNullable<TokenPickerProps["purpose"]>;
  quickChoices: readonly WalletCoinView[];
  wallet: TokenPickerProps["wallet"];
}>) {
  const preferred = withPreferredCoins(wallet).filter(
    (coin) => coinPriority(coin.coinType) < PREFERRED_COINS.length,
  );
  const featuredTypes = new Set(featuredCoins.map((coin) => coin.coinType));
  const featuredOrder = new Map([...featuredTypes].map((type, index) => [type, index]));
  const chips = mergeCoins(mergeCoins(preferred, quickChoices), featuredCoins)
    .filter((coin) => (purpose === "vesting" || visibleInSwapPicker(coin)) && eligible(coin, allowPresales, purpose))
    .sort((a, b) =>
      (featuredOrder.get(a.coinType) ?? featuredOrder.size) -
        (featuredOrder.get(b.coinType) ?? featuredOrder.size) ||
      coinPriority(a.coinType) - coinPriority(b.coinType),
    );
  if (
    current &&
    (purpose === "vesting" || visibleInSwapPicker(current)) &&
    eligible(current, allowPresales, purpose) &&
    !chips.some((coin) => coin.coinType === current?.coinType)
  )
    chips.push(current);

  return (
    <div aria-label="Quick choices" className={styles.tpChips} role="group">
      {chips.map((coin) => (
        <button
          aria-pressed={coin.coinType === current?.coinType}
          className={clsx(
            styles.tokChip,
            styles.tpChip,
            coin.coinType === current?.coinType && styles.on,
          )}
          key={coin.key}
          data-competition={featuredTypes.has(coin.coinType) || undefined}
          onClick={() => onPick(coin)}
          type="button"
        >
          <CoinMark coin={coin} size={18} />
          {coin.symbol}
        </button>
      ))}
    </div>
  );
}

/**
 * The token picker (FEATURE-MAP-R3 §14.1, the gate's `pickt` screen): a
 * search over name, ticker and coin type, SUI, USDC and USDsui as chips, then `Your coins` —
 * ordered by USD value — and `More coins`, every other coin a trade can name
 * (`GET /api/social/trades/coins`). Built on base-ui's Combobox, inline
 * (OA-28): the input owns the list, arrows move the highlight (the gate's
 * `.tp-row.kb`), Enter picks, and the list says when nothing matches.
 */
export function TokenPickerBody({
  current,
  wallet,
  pins,
  hidden,
  listCoins,
  listHoldings,
  onPick,
  allowPresales = false,
  purpose = "swap",
  balancesKnown = false,
  quickChoices = [],
  featuredCoins = [],
  catalogCoins = [],
  children,
}: TokenPickerProps) {
  const { hideSmallBalances } = useShellPrefs();
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(20);
  const [cursor, setCursor] = useState<string | null>(null);
  const [ownedPageState, setOwnedPageState] = useState({
    hideSmall: hideSmallBalances,
    page: 1,
  });
  const ownedPage =
    ownedPageState.hideSmall === hideSmallBalances ? ownedPageState.page : 1;
  const setOwnedPage = (page: number) =>
    setOwnedPageState({ hideSmall: hideSmallBalances, page });
  const [revision, setRevision] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const term = coinSearchTerm(query, purpose);
  // The search takes focus where a keyboard is likely (the gate's `(hover: hover)`); a phone keeps its keyboard down until asked.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (window.matchMedia("(hover: hover)").matches)
        inputRef.current?.focus({ preventScroll: true });
    }, 60);
    return () => clearTimeout(timer);
  }, []);

  // Audit BM-06: the list opens with the current coin as its first whole row. The combobox scrolls it to the
  // nearest edge and the catalog then grows the list, so the alignment holds until the person scrolls, taps or types.
  const results = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = results.current;
    const content = list?.firstElementChild;
    if (!list || !content || typeof ResizeObserver === "undefined") return;
    const selected = () => list.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    const target = (row: HTMLElement) => {
      const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top - list.clientTop + list.scrollTop;
      return top + row.offsetHeight <= list.clientHeight ? 0 : top - Number.parseFloat(getComputedStyle(list).scrollPaddingTop || "0");
    };
    const align = () => {
      const row = selected();
      if (row && Math.abs(list.scrollTop - target(row)) > 1) list.scrollTop = target(row);
    };
    // The combobox's own scroll leaves the chosen row flush with the bottom edge, so that one is undone. Any
    // other scroll that moves off the alignment is the person's (wheel, keys, scrollbar, assistive tech) and ends it.
    const settle = () => {
      const row = selected();
      if (!row) return;
      const bottom = list.getBoundingClientRect().top + list.clientTop + list.clientHeight - Number.parseFloat(getComputedStyle(list).scrollPaddingBottom || "0");
      if (Math.abs(row.getBoundingClientRect().bottom - bottom) <= 2) align();
      else if (Math.abs(list.scrollTop - target(row)) > 1) release();
    };
    const observer = new ResizeObserver(align);
    observer.observe(content);
    list.addEventListener("scroll", settle);
    const inputs = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    const scope = list.parentElement ?? list;
    function release() {
      observer.disconnect();
      list!.removeEventListener("scroll", settle);
      for (const type of inputs) scope.removeEventListener(type, release, true);
    }
    for (const type of inputs) scope.addEventListener(type, release, { capture: true, passive: true });
    return release;
  }, []);

  const { remote, loading, failed } = usePickerCatalog(listCoins, term, cursor, revision);

  const owned = usePickerHoldings(
    listHoldings,
    purpose,
    ownedPage,
    term,
    hideSmallBalances,
    revision,
  );
  const ownedReady =
    owned?.term === term && owned.hideSmall === hideSmallBalances &&
    owned.page === ownedPage && owned.revision === revision;
  const ownedFailed = ownedReady && owned?.error;
  const holdings = listHoldings
    ? matchingHoldings(owned, term, hideSmallBalances)
    : wallet;
  const listedWallet = holdings.filter(
    (coin) =>
      purpose === "vesting" || (visibleInSwapPicker(coin) &&
        (coin.coinType === current?.coinType || !hideSmallBalances ||
          !isSmallBalance(coin.atoms, coin.metadataAvailable === false ? null : coin.decimals, coin.coinType))),
  );
  const listed = useMemo(() => {
    const more = remote?.term === term ? [...remote.coins, ...catalogCoins] : catalogCoins;
    return pickerGroups({
      wallet: listedWallet,
      more: purpose === "vesting" ? more : more.filter(visibleInSwapPicker),
      pins,
      query,
    });
  }, [listedWallet, remote, pins, query, term, catalogCoins, purpose]);
  const groups = useMemo<readonly Group[]>(
    () => availableGroups(listed, allowPresales, limit, purpose),
    [listed, allowPresales, limit, purpose],
  );
  // The catalog alone can pass one page, so the button counts the listed coins a pick can take, not the server's page.
  const supportedCount = listed.find((group) => group.label !== "Your coins")?.coins.filter((coin) => eligible(coin, allowPresales, purpose)).length ?? 0;
  // One box for the picker's parts, so the Combobox's own status region and form input are not steps of the sheet's 17 px rhythm.
  return (
    <div className={styles.tpBody}>
      <Combobox.Root
        autoHighlight
        filter={null}
        filteredItems={groups as Group[]}
        inline
        inputValue={query}
        isItemEqualToValue={(item: WalletCoinView, value: WalletCoinView) =>
          item.coinType === value.coinType
        }
        itemToStringLabel={(coin: WalletCoinView) => coin.symbol}
        itemToStringValue={(coin: WalletCoinView) => coin.coinType}
        items={groups as Group[]}
        onInputValueChange={(value) => {
          if (coinSearchTerm(value, purpose) !== term) setRevision(current => current + 1);
          setQuery(value);
          setLimit(20);
          setCursor(null);
          setOwnedPage(1);
        }}
        open
        value={current}
      >
        <FieldGroup className={styles.tpSearch}>
          <span aria-hidden="true">
            <SearchIcon />
          </span>
          <Combobox.Input
            aria-label="Search coins"
            autoComplete="off"
            maxLength={purpose === "vesting" ? 512 : 200}
            placeholder="Search name, ticker or coin type"
            ref={inputRef}
            render={<TextField />}
            spellCheck={false}
          />
          {query ? <Combobox.Clear keepMounted render={<IconButton size="xs" aria-label="Clear coin search" title="Clear coin search" />} tabIndex={0}><CloseIcon /></Combobox.Clear> : null}
        </FieldGroup>
        <PickerQuickChoices
          allowPresales={allowPresales}
          current={current}
          featuredCoins={featuredCoins}
          onPick={onPick}
          purpose={purpose}
          quickChoices={quickChoices}
          wallet={wallet}
        />
        {children}
        <div className={styles.tpResults} ref={results}>
          <Combobox.List
            aria-label="Coins"
            className={clsx(styles.coinList, styles.tpList)}
          >
            {(group: Group) => (
              <Combobox.Group
                items={group.items as WalletCoinView[]}
                key={group.value}
              >
                <Combobox.GroupLabel className={styles.srH}>
                  {group.value}
                </Combobox.GroupLabel>
                <Combobox.Collection>
                  {(coin: WalletCoinView) => (
                    <PickerCoin
                      key={coin.coinType}
                      coin={coin}
                      current={current}
                      hidden={hidden}
                      allowPresales={allowPresales}
                      purpose={purpose}
                      balanceKnown={balancesKnown}
                      onPick={onPick}
                    />
                  )}
                </Combobox.Collection>
              </Combobox.Group>
            )}
          </Combobox.List>
          <PickerStatus
            loading={loading}
            failed={failed}
            message={remote?.message}
          />
          <PickerMore
            listHoldings={listHoldings}
            ownedReady={ownedReady}
            owned={owned}
            ownedPage={ownedPage}
            setOwnedPage={setOwnedPage}
            listedCount={listedWallet.filter((coin) => pickerMatch(coin, term)).length}
            limit={limit}
            setLimit={setLimit}
            loading={loading}
            supportedCount={supportedCount}
            remote={remote}
            setCursor={setCursor}
          />
          {failed || ownedFailed ? (
            <Button onClick={() => setRevision((value) => value + 1)} size="sm">
              Try again
            </Button>
          ) : null}
          <PickerEmpty
            catalogPending={loading}
            catalogFailed={failed}
            hasMore={Boolean(remote?.nextCursor)}
            holdingsPending={Boolean(listHoldings) && !ownedReady}
            holdingsFailed={Boolean(listHoldings && ownedFailed)}
            query={query}
            term={term}
          />
        </div>
      </Combobox.Root>
    </div>
  );
}

function PickerEmpty({ catalogPending, catalogFailed, hasMore, holdingsPending, holdingsFailed, query, term }: Readonly<{
  catalogPending: boolean;
  catalogFailed: boolean;
  hasMore: boolean;
  holdingsPending: boolean;
  holdingsFailed: boolean;
  query: string;
  term: string;
}>) {
  const settled = !catalogPending && !catalogFailed && !hasMore && !holdingsPending && !holdingsFailed;
  return <Combobox.Empty>
    {settled && term !== "" ? <p className={styles.tpEmpty}>{noMatchText(query)}</p> : null}
  </Combobox.Empty>;
}

function PickerStatus({
  loading,
  failed,
  message,
}: Readonly<{ loading: boolean; failed: boolean; message?: string }>) {
  return loading ? (
    <CoinRowsLoading label="Loading more coins" />
  ) : failed ? (
    <p className={styles.tpEmpty} role="status">
      {message ??
        diagnosticMessage("More coins could not load. Try searching again.", {
          code: "service_unavailable",
        })}
    </p>
  ) : null;
}

function PickerCoin({
  balanceKnown,
  coin,
  current,
  hidden,
  allowPresales,
  purpose,
  onPick,
}: Readonly<{
  coin: WalletCoinView;
  current: WalletCoinView | null;
  hidden: boolean;
  allowPresales: boolean;
  purpose: "swap" | "vesting";
  balanceKnown: boolean;
  onPick: (coin: WalletCoinView) => void;
}>) {
  const figures = pickerFigures(coin, hidden);
  return (
    <Combobox.Item
      disabled={!eligible(coin, allowPresales, purpose)}
      className={(state) =>
        clsx(
          styles.lrow,
          styles.coinRow,
          styles.tpRow,
          state.selected && styles.on,
          state.highlighted && styles.kb,
        )
      }
      onClick={() => {
        if (eligible(coin, allowPresales, purpose)) onPick(coin);
      }}
      value={coin}
    >
      <span className={styles.pickerIdentity}>
        <CoinIdentity coin={coin}>
          {coin.presale?.inPresale ? (
            <em className={styles.presaleBadge}>Presale</em>
          ) : null}
        </CoinIdentity>
        {(purpose === "vesting" || !coreCoin(coin.coinType)) ? (
          <CoinTypeLine coinType={coin.coinType} />
        ) : null}
        {purpose !== "vesting" && coreCoin(coin.coinType) ? (
          <span>{coreCoin(coin.coinType)!.category}</span>
        ) : null}
        {purpose !== "vesting" &&
        pickerCopy(coin, allowPresales) !== coin.symbol ? (
          <span>{pickerCopy(coin, allowPresales)}</span>
        ) : null}
      </span>
      <span className={styles.v}>
        {purpose === "vesting" ? <VestingBalance coin={coin} hidden={hidden} known={balanceKnown} /> : <>
          <b className="num">{figures.value}</b>
          {figures.amount === null ? null : <span className="num">{figures.amount}</span>}
        </>}
      </span>
      <span className={styles.qtick}>
        {coin.coinType === current?.coinType ? <KnowCheckIcon /> : null}
      </span>
    </Combobox.Item>
  );
}

/**
 * A coin type on one line, cut inside its address at any width (audit detail pass): the address
 * shrinks to an ellipsis before `::module::NAME` gives way.
 */
function CoinTypeLine({ coinType }: Readonly<{ coinType: string }>) {
  const split = Math.max(0, coinType.indexOf("::"));
  return (
    <span className={styles.pickerType} title={coinType}>
      <span>{coinType.slice(0, split)}</span>
      <span>{coinType.slice(split)}</span>
    </span>
  );
}

function VestingBalance({ coin, hidden, known }: Readonly<{ coin: WalletCoinView; hidden: boolean; known: boolean }>) {
  if (!known) return <><b aria-hidden="true">—</b><span>Balance unavailable</span></>;
  if (hidden) return <><b className="num">{HIDDEN_AMOUNT}</b><span>Balance hidden</span></>;
  const exact = formatVestingAmount(coin.atoms, coin.metadataAvailable === false ? null : coin.decimals);
  return <><b className="num" title={`${exact} ${coin.symbol}`}>{compactAmount.format(coin.amount)}</b><span aria-label={`Exact balance: ${exact} ${coin.symbol}`}>Balance</span></>;
}

function usePickerHoldings(
  listHoldings: HoldingsLoader | undefined,
  purpose: "swap" | "vesting",
  ownedPage: number,
  term: string,
  hideSmallBalances: boolean,
  revision: number,
) {
  const [owned, setOwned] = useState<
    Readonly<{
      term: string;
      hideSmall: boolean;
      page: number;
      revision: number;
      data?: HoldingsPage;
      error?: string;
    }>
  >();
  useEffect(() => {
    if (!listHoldings) return;
    const controller = new AbortController();
    const cancelRead = scheduleDelay(
      () => {
        listHoldings(ownedPage, term, purpose === "swap" ? "swap" : "all", controller.signal)
          .then((data) => {
            if (!controller.signal.aborted)
              setOwned((previous) => ({
                term,
                hideSmall: hideSmallBalances,
                page: ownedPage,
                revision,
                data: {
                  ...data,
                  coins:
                    ownedPage > 1 &&
                    previous?.term === term &&
                    previous.hideSmall === hideSmallBalances
                      ? mergeCoins(previous.data?.coins ?? [], data.coins)
                      : data.coins,
                },
              }));
          })
          .catch((error) => {
            if (!controller.signal.aborted)
              setOwned((previous) => ({
                term,
                hideSmall: hideSmallBalances,
                page: ownedPage,
                revision,
                data:
                  previous?.term === term &&
                  previous.hideSmall === hideSmallBalances
                    ? previous.data
                    : undefined,
                error: publicErrorMessage(
                  error,
                  "Your coins could not load. Try again.",
                ),
              }));
          });
      },
      term ? PICKER_SEARCH_MS : 0,
    );
    return () => {
      controller.abort();
      cancelRead();
    };
  }, [listHoldings, purpose, term, ownedPage, hideSmallBalances, revision]);
  return owned;
}

function PickerMore({
  listHoldings,
  ownedReady,
  owned,
  ownedPage,
  setOwnedPage,
  listedCount,
  limit,
  setLimit,
  loading,
  supportedCount,
  remote,
  setCursor,
}: Readonly<{
  listHoldings?: HoldingsLoader;
  ownedReady: boolean;
  owned: ReturnType<typeof usePickerHoldings>;
  ownedPage: number;
  setOwnedPage: (page: number) => void;
  listedCount: number;
  limit: number;
  setLimit: (update: (value: number) => number) => void;
  loading: boolean;
  supportedCount: number;
  remote: {
    coins: readonly WalletCoinView[];
    nextCursor?: string | null;
  } | null;
  setCursor: (cursor: string | null) => void;
}>) {
  return (
    <>
      {listHoldings && !ownedReady ? (
        <CoinRowsLoading label="Loading your coins" />
      ) : null}
      {ownedReady && owned?.error ? (
        <p className={styles.tpEmpty} role="alert">{owned.error}</p>
      ) : null}
      {ownedReady &&
      owned?.data &&
      owned.data.total > owned.data.coins.length ? (
        <Button
          disabled={owned.data.page !== ownedPage}
          onClick={() => {
            setOwnedPage(ownedPage + 1);
            setLimit((value) => value + 20);
          }}
        >
          Load more holdings
        </Button>
      ) : null}
      {!listHoldings && listedCount > limit ? (
        <Button onClick={() => setLimit((value) => value + 20)}>
          Load more holdings
        </Button>
      ) : null}
      {/* The server's next page first: its Blast coins join the ones above the curated catalog, so no row already shown moves. */}
      {!loading && remote?.nextCursor ? (
        <Button
          onClick={() => {
            setCursor(remote.nextCursor ?? null);
            setLimit((value) => value + 20);
          }}
        >
          Load more supported coins
        </Button>
      ) : !loading && supportedCount > limit ? (
        <Button onClick={() => setLimit((value) => value + 20)}>
          Load more supported coins
        </Button>
      ) : null}
    </>
  );
}

function matchingHoldings(
  owned: ReturnType<typeof usePickerHoldings>,
  term: string,
  hideSmall: boolean,
) {
  return owned?.term === term && owned.hideSmall === hideSmall
    ? (owned.data?.coins ?? [])
    : [];
}

function availableGroups(
  listed: ReturnType<typeof pickerGroups>,
  allowPresales: boolean,
  limit: number,
  purpose: "swap" | "vesting",
): readonly Group[] {
  const available = listed
    .map((group) => ({
      value: group.label,
      items: group.coins
        .filter((coin) => eligible(coin, allowPresales, purpose))
        .slice(0, limit),
    }))
    .filter((group) => group.items.length > 0);
  const unavailable = listed.flatMap((group) =>
    group.coins.filter((coin) => !eligible(coin, allowPresales, purpose)),
  );
  return unavailable.length
    ? [
        ...available,
        { value: "Unavailable", items: unavailable.slice(0, limit) },
      ]
    : available;
}
