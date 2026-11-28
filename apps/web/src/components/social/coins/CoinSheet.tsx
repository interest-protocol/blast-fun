"use client";

import Link from "next/link";
import { EMPTY_TRADE_AMOUNT, type TradeAmount } from "../trade/trade-ticket.ts";
import { fmtLive } from "#web/components/social/trade/trade-ticket.ts";
import { exactText, groupDigits } from "@blast/core/web/exact-amount.ts";

import { focusAfterDelay } from "#web/lib/deferred-focus.ts";
import { Button, DisclosureButton, DisclosureSummary } from "#web/components/blast-ui/Button.tsx";
import { Disclosure } from "#web/components/blast-ui/Disclosure.tsx";
import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import { coinPriority, coreCoin, PREFERRED_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";

import { diagnosticMessage, publicErrorMessage } from "#web/lib/errors.ts";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { presaleDetailQuery } from "../queries";
import { presaleCoinView } from "./swap-client";

import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { Sheet, SheetClose, useSheet } from "#web/components/blast-ui/Sheet.tsx";
import { atomsValue, HIDDEN_AMOUNT, usd, usd0 } from "@blast/core/web/format.ts";
import { usePhoneLayout, useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import clsx from "clsx";
import type { SocialTransferFee } from "@blast/core/web/contracts/coins.ts";
import { bpsToPct } from "@blast/core/modules/social/prices/change.ts";

import { ArrowDownIcon, ArrowUpIcon, BridgeIcon, PreviousIcon } from "#web/components/blast-ui/Icons.tsx";
import { usePrice } from "../prices/price-client";
import { CopyButton } from "#web/components/blast-ui/CopyButton.tsx";
import {
  coinAmt,
  coinCount,
  coinPriceLine,
  coinsValue,
  coinSub,
  coinValue,
  EMPTY_COIN_BROWSER,
  maxWithdrawAtoms,
  numIn,
  PUBLIC_PREFERRED_COINS,
  withPreferredCoins,
  withdrawCheck,
  type CoinScreen,
  type WalletCoinView,
} from "./coin-model";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { CoinIdentity } from "#web/components/social/coins/CoinIdentity.tsx";
import { PIN_MAX, pinLabel, pinSort, toggleCoinPin, useCoinPins } from "./coin-pins";
import styles from "./coins.module.css";
import { KnowCheckIcon, StarIcon, SwapIcon } from "./icons";
import { qrMatrix } from "./qr";
import { AmountFit } from "#web/components/blast-ui/AmountFit.tsx";
import { canTrade, pairFor, pickedPair, tradeTitle, type SwapPair } from "./swap-model";
import { SwapForm, type CoinSheetTrading } from "./SwapForm";
import { useCommitKit } from "../feed-ui/shell-bridge";
import { CommitReceipt } from "../commit/CommitReceipt";
import type { ContributionReceipt } from "../commit/commit-receipt";
import { InlineCommit } from "../commit/InlineCommit";
import type { CommitDraft } from "../commit/CommitPanel";
import commitStyles from "../commit/commit.module.css";
import { isSmallBalance } from "@blast/core/modules/social/portfolio/small-balance.ts";
import { CoinBrowser, type CoinBrowserState, type HoldingsLoader } from "./CoinBrowser";
import { TokenPicker } from "./TokenPicker";
import { authenticatedAction } from "../sign-in-gate";
import { useSignInDraft } from "../sign-in-draft";
import { decodeTradeAction, ECOSYSTEM_COIN_VIEWS, encodeTradeAction, tradableCoinView } from "./swap-model";
import { useSwapCompetitions } from "../competitions/swap-competitions.ts";
import { SwapCompetitionNotice } from "../competitions/SwapCompetitionNotice.tsx";
import { SUI_COIN_TYPE, USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { decimalText, dropDecimal, pasteDecimal } from "#web/lib/decimal-input.ts";
import { useWalletCoinBalance, type WalletCoinBalance } from "./use-wallet-coin-balance";
import { DiagnosticText } from "#web/components/blast-ui/DiagnosticText.tsx";
import { useBridge } from "../bridge/bridge-context.tsx";
import { BridgeScreen } from "../bridge/BridgeScreen.tsx";
import { SUI_ADDRESS_PLACEHOLDER, SUI_NAME_LOOKUP_LABEL, useSuiAddressLookup } from "#web/lib/sui-address-input.ts";

export type { CoinSheetTrading, TradeAsk, TradeOutcome } from "./SwapForm";

const ZERO_ATOMS = 0n;

function useLiveTradeCoin(coin: WalletCoinView, enabled: boolean): WalletCoinView {
  const id = coin.presale?.presaleId ?? null;
  const query = useQuery({ ...presaleDetailQuery(id ?? ""), enabled: enabled && id !== null, select: (body) => presaleCoinView(body, id ?? "") }, useAppQueryClient());
  const live = query.data;
  if (!enabled || !live || (coin.presale?.trading && !live.presale?.trading)) return coin;
  return { ...coin, presale: live.presale, price: live.price, iconUrl: live.iconUrl };
}

function useTradeCoins(inCoin: WalletCoinView, outCoin: WalletCoinView, active: boolean) {
  const [heldPurchase, setHeldPurchase] = useState<WalletCoinView | null>(null);
  const purchasePending = heldPurchase !== null;
  const enabled = active && !purchasePending;
  const input = useLiveTradeCoin(inCoin, enabled);
  const output = useLiveTradeCoin(heldPurchase ?? outCoin, enabled);
  return {
    inCoin: input,
    outCoin: output,
    purchasePending,
    onPendingChange: (pending: boolean) => setHeldPurchase(pending ? output : null),
  };
}

/** The wallet as the sheet sees it. */
export type CoinSheetWallet =
  | Readonly<{ status: "visitor" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error"; message?: string }>
  /** A Privy account whose embedded Sui wallet is being created. */
  | Readonly<{ status: "creating" }>
  | Readonly<{ status: "ready"; address: string; fee: SocialTransferFee; coins: readonly WalletCoinView[]; total?: number; value?: string | null }>;

/** A withdrawal the sheet asks for, already checked. */
export type WithdrawAsk = Readonly<{ coin: WalletCoinView; atoms: bigint; amount: number; recipient: string }>;

export type CoinSheetProps = Readonly<{
  open: boolean;
  /** A persistent page panel; uses the same form without dialog navigation. */
  inline?: boolean;
  draftKey?: string;
  /** Changes on every open, so each open starts fresh. */
  session: number;
  first: CoinScreen;
  wallet: CoinSheetWallet;
  onClose: () => void;
  onClosed?: () => void;
  onCopy: (address: string) => boolean | void | Promise<boolean | void>;
  onRetry: () => void;
  /** True on confirmation. A pending result can only check the same withdrawal. */
  onWithdraw: (ask: WithdrawAsk) => Promise<boolean | "pending">;
  /** Reports navigation changes for deposit polling; the host owns the opening screen. */
  onScreen?: (screen: CoinScreen | null) => void;
  /** R3-33: quotes, the picker's coins and the trade itself. */
  trading: CoinSheetTrading;
  /**
   * Publicly read coins the wallet does not hold, opened from discovery or Buy.
   */
  extraCoins?: readonly WalletCoinView[];
  listHoldings?: HoldingsLoader;
  holdingsOwner?: string | null;
}>;

/**
 * The coins sheet (the live design's "coins: deposit, withdraw and trade any
 * coin in the Blast wallet"): one sheet walking a small stack of screens —
 * pick a coin, the coin itself, then Deposit, Withdraw or Trade — with a back
 * button once it is deeper than its first screen.
 *
 * R3-33 makes Trade the universal swap (FEATURE-MAP-R3 §14.1): any coin for
 * any coin the aggregator can route, USDC included, with the token picker as
 * a screen of its own (`pickt`) and the trade's state kept while you pick.
 * The coin screen is rebuilt around its header and one big balance (§14.2).
 *
 * R3-10 adds the All-coins screen: every coin in the Blast wallet with its
 * star, the favourites across the top, and `PIN_MAX = 5`. Favourites lead
 * every coin list in the sheet.
 */
export function CoinSheet(props: CoinSheetProps) {
  const titleId = useId();
  const { open, onClose } = props;
  if (props.inline) return <CoinSheetBody key={props.session} {...props} titleId={titleId} />;
  return (
    <Sheet
      className={styles.sheet}
      initialFocus={() => document.getElementById(titleId)?.closest("[data-coin-ready]")?.querySelector<HTMLElement>("[data-coin-focus]") ?? null}
      labelledBy={titleId}
      onClosed={props.onClosed}
      onRequestClose={onClose}
      open={open}
    >
      <SheetClose onClick={onClose} />
      <CoinSheetBody key={props.session} {...props} titleId={titleId} />
    </Sheet>
  );
}

function availableCoinScreen(screen: CoinScreen, coins: readonly WalletCoinView[]): CoinScreen {
  if ((screen.kind === "coin" || screen.kind === "wd") && !coins.some((coin) => coin.key === screen.key)) {
    return screen.kind === "wd" ? { kind: "pick", mode: "withdraw" } : { kind: "all" };
  }
  return screen;
}

function useCoinSteps(props: Pick<CoinSheetProps, "first" | "onScreen" | "inline"> & Readonly<{ titleId: string }>, firstIsPurchase: boolean) {
  const { swap } = useSheet();
  const [stack, setStack] = useState<readonly Readonly<{ screen: CoinScreen; returnTrade: TradeState; returnFocus: string | null }>[]>(() => {
    const trade = initialTrade(props.first);
    const swapScreen: CoinScreen = { kind: "trade", key: trade.pair.in };
    return [...(firstIsPurchase ? [{ screen: swapScreen, returnTrade: initialTrade(swapScreen), returnFocus: null }] : []), { screen: props.first, returnTrade: firstIsPurchase ? initialTrade(swapScreen) : trade, returnFocus: null }];
  });
  const screen = stack[stack.length - 1]!.screen;
  // The trade's pair, amount and detail survive a trip to the picker and back (the gate's `st`).
  const [trade, setTrade] = useState<TradeState>(() => initialTrade(props.first));
  /** Coins picked from the picker's list that the wallet does not hold: the trade names them by key. */
  const [picked, setPicked] = useState<readonly WalletCoinView[]>([]);
  const [returnFocus, setReturnFocus] = useState<string | null>(null);
  useEffect(() => {
    const target = returnFocus ?? (props.inline && screen.kind === "pickt" ? '[aria-label="Search coins"]' : null);
    if (target === null) return;
    document.getElementById(props.titleId)?.closest("[data-coin-ready]")?.querySelector<HTMLElement>(target)?.focus({ preventScroll: true });
  }, [screen, returnFocus, props.titleId, props.inline]);
  const go = (next: CoinScreen, nextTrade?: TradeState) => {
    const active = document.activeElement;
    const side = active?.getAttribute("data-coin-pick");
    const label = next.kind === "bridge" ? "Bridge" : screen.kind === "fund" ? "Withdraw" : active?.getAttribute("aria-label");
    const fallbackFocus = screen.kind === "pick" ? '[aria-label="Search your coins"]' : '[aria-label="Search coins"]';
    const focus = side ? `[data-coin-pick=${JSON.stringify(side)}]` : label ? `[aria-label=${JSON.stringify(label)}]` : active?.id ? `#${CSS.escape(active.id)}` : fallbackFocus;
    swap(() => {
      setReturnFocus(next.kind === "pick" ? '[aria-label="Search your coins"]' : null);
      if (next.kind === "trade") setTrade(nextTrade ?? initialTrade(next));
      setStack((current) => [...current, { screen: next, returnTrade: trade, returnFocus: focus }]);
      props.onScreen?.(next);
    });
  };
  const back = (updatedTrade?: TradeState) => {
    const previous = stack.at(-2);
    if (!previous) return;
    swap(() => {
      setTrade(updatedTrade ?? stack.at(-1)!.returnTrade);
      setStack((current) => current.slice(0, -1));
      setReturnFocus(stack.at(-1)!.returnFocus);
      props.onScreen?.(previous.screen);
    });
  };
  const canBack = stack.length > 1;
  const pickCoin = (coin: WalletCoinView, side: "in" | "out") => {
    setPicked(current => [...current.filter(each => each.key !== coin.key), coin]);
    const next = pickedPair(trade.pair, side, coin.key);
    const nextTrade = { ...trade, pair: next.pair, field: next.clear ? EMPTY_TRADE_AMOUNT : trade.field };
    if (side === "out" && coin.presale?.inPresale) go({ kind: "trade", key: next.pair.in, out: coin.key }, { ...nextTrade, field: EMPTY_TRADE_AMOUNT });
    else back(nextTrade);
  };
  return { screen, trade, setTrade, picked, setPicked, pickCoin, go, back, canBack, returnFocus };
}

function opensPurchase(props: Pick<CoinSheetProps, "first" | "wallet" | "extraCoins">): boolean {
  const out = props.first.kind === "trade" ? props.first.out : null;
  const coins = [...(props.extraCoins ?? []), ...(props.wallet.status === "ready" ? props.wallet.coins : [])];
  return coins.some(coin => coin.key === out && coin.presale?.inPresale === true);
}

function CoinSheetBody(props: CoinSheetProps & Readonly<{ titleId: string }>) {
  const [receipt, setReceipt] = useState<ContributionReceipt | null>(null);
  return receipt
    ? <CommitReceipt receipt={receipt} onDone={props.onClose} titleId={props.titleId} />
    : <CoinSheetForm key={props.holdingsOwner ?? "visitor"} {...props} onConfirmed={setReceipt} />;
}

function walletFailureMessage(wallet: Extract<CoinSheetWallet, { status: "error" }>): string {
  return wallet.message ?? diagnosticMessage("Your wallet could not load.", { code: "service_unavailable" });
}

function swapDialogClassName(screen: CoinScreen, outCoin: WalletCoinView): string | undefined {
  const isSwap = screen.kind === "pickt" || (screen.kind === "trade" && !outCoin.presale?.inPresale);
  return isSwap ? styles.swapDialog : undefined;
}

function swapPromotionEnabled(open: boolean, screen: CoinScreen): boolean {
  return open && (screen.kind === "trade" || screen.kind === "pickt");
}

function CoinPickerRow({ coin, balanceKnown, hidden, disabled, onPick }: Readonly<{
  coin: WalletCoinView; balanceKnown: boolean; hidden: boolean; disabled: boolean; onPick: () => void;
}>) {
  const balance = !balanceKnown ? "Balance —" : hidden ? HIDDEN_AMOUNT : coinSub(coin, coin.amount);
  return <Button className={clsx(styles.lrow, styles.coinRow)} disabled={disabled} onClick={onPick} size="lg" variant="nav">
    <CoinMark coin={coin} />
    <span className={styles.t}>
      <b>{coin.name}</b>
      <span className="num">{balance}</span>
    </span>
    {balanceKnown && coin.value !== null ? <span className={styles.v}>
      <b className="num">{hidden ? HIDDEN_AMOUNT : coinValue(coin)}</b>
    </span> : null}
  </Button>;
}

function CoinSheetForm(props: CoinSheetProps & Readonly<{ titleId: string; onConfirmed: (receipt: ContributionReceipt) => void }>) {
  const commitKit = useCommitKit();
  const storedPins = useCoinPins();
  const [browsers, setBrowsers] = useState<Readonly<Record<string, CoinBrowserState>>>({});
  const browser = (mode: string) => ({ state: browsers[mode] ?? EMPTY_COIN_BROWSER, onState: (state: CoinBrowserState) => setBrowsers(current => ({ ...current, [mode]: state })) });
  const hidden = useShellPrefs().amountsHidden;
  const { screen, trade, setTrade, picked, setPicked, pickCoin, go, back, canBack, returnFocus } = useCoinSteps(props, opensPurchase(props));
  const extraCoins = props.extraCoins ?? [];
  const [purchaseDrafts, setPurchaseDrafts] = useState<Readonly<Record<string, CommitDraft>>>({});
  const savePurchaseDraft = useCallback((draft: CommitDraft) => {
    setPurchaseDrafts(current => ({ ...current, [trade.pair.out]: draft }));
  }, [trade.pair.out]);
  useSignInDraft(props.draftKey ?? "coins:trade", !props.trading.signedIn && screen.kind === "trade" ? {
    in: trade.pair.in, out: trade.pair.out, text: trade.field.typed, focus: trade.focus ?? "", detail: String(trade.detail),
    coins: JSON.stringify([...picked, ...extraCoins].filter((coin) => !PUBLIC_PREFERRED_COINS.some((base) => base.coinType === coin.coinType)).map((coin) => encodeTradeAction({ side: "buy", coin: { presale_id: coin.presale?.presaleId ?? null, coin_type: coin.coinType, symbol: coin.symbol, name: coin.name, decimals: coin.decimals, usd_price: coin.price?.toString() ?? null, icon_url: coin.iconUrl } }))),
  } : null, (saved) => {
    try {
      const extras: unknown = JSON.parse(saved.coins ?? "[]");
      if (!Array.isArray(extras) || extras.some((coin) => typeof coin !== "string" || decodeTradeAction(coin) === null)) return;
      const restored = extras.map((coin) => tradableCoinView(decodeTradeAction(coin)!.coin));
      const keys = new Set([...PUBLIC_PREFERRED_COINS, ...restored].map((coin) => coin.key));
      if (!saved.in || !saved.out || !keys.has(saved.in) || !keys.has(saved.out)) return;
      setPicked(restored);
      setTrade({ pair: { in: saved.in, out: saved.out }, field: { typed: saved.text ?? "", mode: "typed", unit: "token" }, detail: saved.detail === "true", focus: saved.focus || null });
    } catch { /* Ignore a corrupt form snapshot. */ }
  }, props.open);
  const head = (title: string, lead?: string, unseen = false) => (
    <CoinHead canBack={canBack} id={props.titleId} lead={lead} onBack={() => back()} title={title} unseen={unseen} />
  );

  // SUI's 24 h move under its price (R3-20), read only while SUI's own screen is shown.
  const suiPrice = usePrice(screen.kind === "coin" && screen.key === "sui" ? { coin: SUI_COIN_TYPE } : null);

  const balanceKnown = props.wallet.status === "ready";
  const wallet = props.wallet.status === "ready" ? props.wallet : { address: null, fee: "wallet" as const, coins: PUBLIC_PREFERRED_COINS };
  const bridge = useBridge();
  // Favourite shortcuts keep their saved order; the browser ranks holdings by USD value.
  const pins = storedPins;
  const coins = pinSort(withPreferredCoins(wallet.coins), pins);
  const promotions = useSwapCompetitions(swapPromotionEnabled(props.open, screen), [...coins, ...picked, ...extraCoins]);
  const coinOf = (key: string): WalletCoinView =>
    coins.find((coin) => coin.key === key) ?? picked.find((coin) => coin.key === key) ??
    extraCoins.find((coin) => coin.key === key) ??
    { key, coinType: key, symbol: key.toUpperCase(), name: key.toUpperCase(), decimals: 9, atoms: ZERO_ATOMS, amount: 0, price: null, value: null, iconUrl: null, round: false, presale: null };

  // Discovery can open a publicly read coin before it is held by this wallet.
  const shown = availableCoinScreen(screen, [...coins, ...picked, ...extraCoins]);
  const selected = tradeView(trade, [...coins, ...extraCoins, ...picked], coinOf);
  const { inCoin, outCoin, purchasePending, onPendingChange } = useTradeCoins(selected.inCoin, selected.outCoin, props.open && screen.kind === "trade");
  const { field } = selected;
  const withdrawPicker = (): ReactNode => {
    const list = coins.filter((coin) => !balanceKnown || coin.atoms > ZERO_ATOMS || coinPriority(coin.coinType) < PREFERRED_COINS.length);
    return (
      <>
        {head("Withdraw")}
        <CoinBrowser coins={list} owned={balanceKnown} load={props.listHoldings} mode="withdraw" {...browser("withdraw")}>{rows => <div className={styles.coinList}>
          {rows.map((coin) => (
            <CoinPickerRow balanceKnown={balanceKnown} coin={coin} disabled={balanceKnown && coin.atoms === ZERO_ATOMS} hidden={hidden} key={coin.key} onPick={() => { setPicked(current => [...current.filter(each => each.key !== coin.key), coin]); go({ kind: "wd", key: coin.key }); }} />
          ))}
        </div>}</CoinBrowser>
        {list.length === 0 ? <p className={styles.status}>Nothing to withdraw yet. Deposit first.</p> : null}
      </>
    );
  };

  const allCoinsScreen = (): ReactNode => {
    // The complete wallet value and count stay independent of its visible page.
    const total = props.wallet.status === "ready" && props.wallet.value !== undefined ? props.wallet.value === null ? null : Number(props.wallet.value) : coinsValue(coins);
    return (
      <>
        {head("Your coins", balanceKnown ? `${coinCount(props.wallet.status === "ready" ? props.wallet.total ?? coins.length : coins.length)}${hidden ? ` · ${HIDDEN_AMOUNT}` : total === null ? "" : ` · ${usd0(total)}`}` : "Sign in to see your coins")}
        {/* The list keeps the read's own order, as the reference does: a coin does not jump away when you star it. */}
        <AllCoins coins={balanceKnown ? coins : []} hidden={hidden} load={props.listHoldings} browser={browser("all")} onOpen={(key, coin) => { if (coin) setPicked(current => [...current.filter(each => each.key !== key), coin]); go({ kind: "coin", key }); }} pins={pins} />
      </>
    );
  };

  const coinScreen = (shown: Extract<CoinScreen, { kind: "coin" | "wd" }>): ReactNode => {
    const coin = coinOf(shown.key);
    const line = coinPriceLine(coin, coin.key === "sui" ? bpsToPct(suiPrice?.change_24h_bps ?? null) : null);
    // Who the coin is sits in the header; what you hold is the one big figure (§14.2).
    return (
      <>
        <div className={styles.coinTop}>
          {canBack ? (
            <button aria-label="Back" className={clsx("icon-btn", styles.back)} onClick={() => back()} type="button">
              <PreviousIcon />
            </button>
          ) : null}
          <CoinMark coin={coin} size={44} />
          <div className={styles.t}>
            <h2 id={props.titleId}>{coin.name}</h2>
            <span className="num">
              {line.kind === "text" ? line.text : (
                <>
                  {line.before}
                  <b className={styles[line.tone]}>{line.strong}</b>
                  {line.after}
                </>
              )}
            </span>
          </div>
        </div>
        <div className={styles.coinBal}>
          <b className="num">{!balanceKnown ? props.wallet.status === "loading" ? <SkeletonText>Balance</SkeletonText> : null : hidden ? HIDDEN_AMOUNT : coinAmt(coin, coin.amount)}</b>
          {hidden ? <span className="num">{HIDDEN_AMOUNT}</span> : coin.value === null ? null : <span className="num">{usd(coin.value, 2)}</span>}
        </div>
        {/* One primary (Trade); moving money in or out is a quiet second line, and the sheet fits this screen. */}
        <div className={styles.acts}>
          <Button
            className={styles.tradeAct}
            // A sale coin whose sale does not trade yet has no route (R3-30's `not_tradable`).
            disabled={!canTrade(coin)}
            onClick={() => go({ kind: "trade", key: coin.key })}
            size="lg"
            variant="primary"
          >
            <SwapIcon />Trade
          </Button>
          <div className={styles.quietActs} data-three={bridge ? "" : undefined}>
            <Button className={styles.quietAct} onClick={() => go({ kind: "dep" })} variant="ghost"><ArrowDownIcon />Deposit</Button>
            <Button className={styles.quietAct} onClick={() => go({ kind: "wd", key: coin.key })} variant="ghost"><ArrowUpIcon />Withdraw</Button>
            {bridge ? <Button aria-label="Bridge" className={styles.quietAct} onClick={() => go({ kind: "bridge" })} variant="ghost"><BridgeIcon />Bridge</Button> : null}
          </div>
        </div>
      </>
    );
  };

  const depositScreen = (fund: boolean): ReactNode => (
    <>
      {head(fund ? "Fund" : "Deposit")}
      <div className={styles.depBody}>
        <DepositAddress address={wallet.address} onCopy={props.onCopy} />
      </div>
      {!props.trading.signedIn ? <Button loading={props.trading.sessionPending === true} loadingLabel="Restoring session" onClick={props.trading.onSignIn} size="lg" variant="primary">Sign in to get your address</Button> : null}
      {fund ? <Button aria-label="Withdraw" onClick={() => go({ kind: "pick", mode: "withdraw" })} size="lg" variant="secondary"><ArrowUpIcon />Withdraw</Button> : null}
      {fund && bridge ? <Button aria-label="Bridge" onClick={() => go({ kind: "bridge" })} size="lg" variant="secondary"><BridgeIcon />Bridge</Button> : null}
    </>
  );

  // Bridge to Sui: coins from another chain arrive in this Blast wallet.
  // A new Blast session starts a new form (key), so nothing from the last account carries over.
  const bridgeScreen = (): ReactNode => !bridge ? depositScreen(false) : (
    <>
      {head("Bridge to Sui")}
      <BridgeScreen
        blastAddress={wallet.address}
        key={wallet.address ?? "signed-out"}
        onSignIn={props.trading.onSignIn}
        signedIn={props.trading.signedIn}
      />
    </>
  );

  const withdrawScreen = (shown: Extract<CoinScreen, { kind: "coin" | "wd" }>): ReactNode => {
    const coin = coinOf(shown.key);
    return (
      <>
        {head(`Withdraw ${coin.symbol}`)}
        <WithdrawForm
          active={props.open}
          address={wallet.address}
          coin={coin}
          fee={wallet.fee}
          trading={props.trading}
          balanceKnown={balanceKnown}
          onWithdraw={props.onWithdraw}
          suiAtoms={coinOf("sui").atoms}
        />
      </>
    );
  };

  const tradeScreen = (): ReactNode => {
    // OA-48: named for the action that opened it (`Buy KSTL`, `Sell KSTL`, `Trade`); the flip and the picker re-name it at once.
    if (outCoin.presale?.inPresale) return <>
      <CoinHead canBack={canBack} coin={outCoin} id={props.titleId} pending={purchasePending} onBack={() => back()} onChangeCoin={() => go({ kind: "pickt", side: "out" })} title={`Buy ${outCoin.symbol}`} />
      {commitKit ? <InlineCommit key={outCoin.presale.presaleId} kit={commitKit} presaleId={outCoin.presale.presaleId}
        purchase={{ active: props.open, onConfirmed: props.onConfirmed, initialPayCoin: inCoin.coinType, initialPaymentCoin: inCoin,
          draft: purchaseDrafts[outCoin.key], onDraftChange: savePurchaseDraft, onDetails: props.onClose, onPendingChange }}
        fallback={<PresaleLoading symbol={outCoin.symbol} quoteSymbol={outCoin.presale.quoteSymbol} />} /> : <div className={commitStyles.purchaseRead}><p role="status">Presale purchases are unavailable here.</p><Link className={commitStyles.detailsLink} href={`/presale/${outCoin.presale.presaleId}`} onClick={props.onClose} prefetch={false}>Presale details →</Link></div>}
    </>;
    return (
      <>
        {/* Inline, the card around it shows the title (the Coin board's "Buy {name}"): this one stays for assistive technology and focus return, unseen. */}
        {head(tradeTitle(inCoin, outCoin, trade.focus), undefined, props.inline && !canBack)}
        <SwapForm
          active={props.open}
          persistent={props.inline}
          detail={trade.detail}
          field={field}
          focus={trade.focus}
          hidden={hidden}
          focusAmount={!props.inline && returnFocus === null}
          inCoin={inCoin}
          onDetail={(detail) => setTrade((current) => ({ ...current, detail }))}
          onField={(next) => setTrade((current) => ({ ...current, field: next }))}
          onFlip={(next) => setTrade((current) => ({ ...current, pair: { in: current.pair.out, out: current.pair.in }, field: next }))}
          onPick={(side) => go({ kind: "pickt", side })}
          outCoin={outCoin}
          trading={props.trading}
          walletFee={wallet.fee}
        />
        <SwapCompetitionNotice competitions={promotions.competitions} coinTypes={[inCoin.coinType, outCoin.coinType]} onNavigate={props.onClose} />
      </>
    );
  };

  const tradePickerScreen = (shown: Extract<CoinScreen, { kind: "pickt" }>): ReactNode => {
    const side = shown.side;
    return (
      <>
        {head(side === "in" ? "Select payment coin" : "Select coin to receive")}
        <TokenPicker
          allowPresales={side === "out"}
          catalogCoins={ECOSYSTEM_COIN_VIEWS}
          current={side === "in" ? inCoin : outCoin}
          featuredCoins={promotions.coins}
          hidden={hidden}
          listCoins={props.trading.listCoins}
          listHoldings={props.listHoldings}
          onPick={(coin) => pickCoin(coin, side)}
          pins={pins}
          wallet={coins}
        >
          <SwapCompetitionNotice competitions={promotions.competitions} coinTypes={promotions.coins.slice(0, 1).map(coin => coin.coinType)} onNavigate={props.onClose} />
        </TokenPicker>
      </>
    );
  };

  const content = () => {
    switch (shown.kind) {
      case "pick": return withdrawPicker();
      case "all": return allCoinsScreen();
      case "coin": return coinScreen(shown);
      case "fund": return depositScreen(true);
      case "dep": return depositScreen(false);
      case "bridge": return bridgeScreen();
      case "wd": return withdrawScreen(shown);
      case "trade": return tradeScreen();
      case "pickt": return tradePickerScreen(shown);
    }
  };
  const fixedFlow = shown.kind === "pickt" || (shown.kind === "trade" && outCoin.presale?.inPresale);
  return <div className={clsx(styles.screen, styles.reveal, fixedFlow && styles.flow, swapDialogClassName(shown, outCoin))} data-coin-ready="" data-coin-screen={shown.kind} data-coin-flow={fixedFlow ? "" : undefined} data-sheet-step="">{content()}{props.wallet.status === "error" ? <p className={styles.status} role="alert">{walletFailureMessage(props.wallet)} <button className="btn btn-quiet btn-sm" onClick={props.onRetry} type="button">Try again</button></p> : null}</div>;
}

function PresaleLoading({ symbol, quoteSymbol = "COIN" }: Readonly<{ symbol: string; quoteSymbol?: string }>) {
  return <div className={clsx(commitStyles.panel, commitStyles.purchase)}>
    <div className={commitStyles.purchaseBody}>
      <span className="sr-only" role="status">Loading presale terms…</span>
      <div aria-hidden="true" className={commitStyles.amt}>
        <div className={commitStyles.amtTop}><span><SkeletonText>You pay</SkeletonText></span></div>
        <div className={commitStyles.amtRow}><b className={commitStyles.amtInput}><SkeletonText>0</SkeletonText></b><CoinIdentity coin={{ key: quoteSymbol, symbol: quoteSymbol, name: quoteSymbol === "TSUI" ? "Test SUI" : quoteSymbol, iconUrl: null, round: true }} showName={false} /></div>
        <div className={commitStyles.amtFoot}><SkeletonText>Balance — {quoteSymbol}</SkeletonText></div>
      </div>
      <div aria-hidden="true" className={commitStyles.presets}>{["10", "25", "100", "Max"].map((label) => <span className={commitStyles.preset} key={label}><SkeletonText>{label}</SkeletonText></span>)}</div>
      <div aria-hidden="true" className={commitStyles.allocation}>
        <div className={commitStyles.allocationHeading}><span>Estimated allocation</span><b className={commitStyles.estimate}><SkeletonText>≈ 90,000 {symbol}</SkeletonText></b><small><SkeletonText>If the presale closed now</SkeletonText></small></div>
        <dl className={commitStyles.terms}>{["Payment used", "Your allocation share", "Token availability"].map((label) => <div key={label}><dt>{label}</dt><dd><SkeletonText>Pending terms</SkeletonText></dd></div>)}</dl>
      </div>
      <details aria-hidden="true" className={commitStyles.disclosure}><DisclosureSummary tabIndex={-1}><SkeletonText>How this presale works</SkeletonText></DisclosureSummary></details>
      <span className={commitStyles.detailsLink} aria-hidden="true"><SkeletonText>Presale details →</SkeletonText></span>
      <details aria-hidden="true" className={clsx(commitStyles.disclosure, commitStyles.optional)}><DisclosureSummary tabIndex={-1}><SkeletonText>Message for your followers · Optional</SkeletonText></DisclosureSummary></details>
    </div>
    <div className={commitStyles.purchaseFooter}><p>Commitments can’t be withdrawn before close.</p><Button className={commitStyles.primary} disabled loading loadingLabel="Loading presale terms" size="lg" variant="primary">Buy allocation</Button></div>
  </div>;
}

/**
 * The All-coins screen's body (R3-10, the design's `allCoinsList`): the
 * favourites as a row across the top — coin and value, nothing more, in pin
 * order — then every coin with its star, in the wallet read's own order.
 * The list is deliberately *not* reordered by the stars: starring re-renders
 * it in place, so the row stays where it was and focus stays on the star that
 * was pressed. Five favourites is the limit, so a sixth star is disabled and
 * says why.
 */
export function AllCoins({
  coins,
  pins,
  hidden,
  onOpen,
  load,
  browser,
}: Readonly<{ coins: readonly WalletCoinView[]; pins: readonly string[]; hidden: boolean; onOpen: (key: string, coin?: WalletCoinView) => void; load?: HoldingsLoader; browser?: Readonly<{ state: CoinBrowserState; onState: (state: CoinBrowserState) => void }> }>) {
  const [state, onState] = useState(EMPTY_COIN_BROWSER);
  const { hideSmallBalances } = useShellPrefs();
  const full = pins.length >= PIN_MAX;
  const pinnedKeys = new Set(pins);
  const favourites = pinSort(coins, pins).filter((coin) => pinnedKeys.has(coin.key) && (!hideSmallBalances || !isSmallBalance(coin.atoms, coin.metadataAvailable === false ? null : coin.decimals, coin.coinType)));
  const value = (coin: WalletCoinView) => (hidden ? HIDDEN_AMOUNT : coinValue(coin));
  return (
    <div>
      {favourites.length > 0 ? (
        <div aria-label="Favourites" className={styles.coinFavs} role="group">
          {favourites.map((coin) => (
            <button
              aria-label={`${coin.name}, ${value(coin)}`}
              className={styles.coinFav}
              key={coin.key}
              onClick={() => onOpen(coin.key, coin)}
              type="button"
            >
              <CoinMark coin={coin} />
              <span>
                <b>{coin.symbol}</b>
                <span className="num">{value(coin)}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <p className={styles.coinSec}>All coins</p>
      <CoinBrowser coins={coins} load={load} mode="all" {...(browser ?? { state, onState })}>{rows => <div className={styles.coinList}>
        {rows.map((coin) => {
          const pinned = pinnedKeys.has(coin.key);
          const label = pinLabel(coin.name, pinned, full);
          return (
            <div className={clsx(styles.coinPinrow, pinned && styles.on)} key={coin.key}>
              <button className={clsx(styles.lrow, styles.coinRow)} onClick={() => onOpen(coin.key, coin)} type="button">
                <CoinMark coin={coin} />
                <span className={styles.t}>
                  <b>{coin.name}</b>
                  {coreCoin(coin.coinType) ? <span>{coreCoin(coin.coinType)!.category}</span> : null}
                  <span className="num">{hidden ? HIDDEN_AMOUNT : coinSub(coin, coin.amount)}</span>
                </span>
                <span className={styles.v}>
                  <b className="num">{value(coin)}</b>
                </span>
                {/* OA-24: no chevron here; the star is the row's trailing control, and a chevron before it read as a second action. */}
              </button>
              <button
                aria-label={label}
                aria-pressed={pinned}
                className={clsx("icon-btn", styles.coinPin)}
                disabled={!pinned && full}
                onClick={() => toggleCoinPin(coin.key)}
                title={label}
                type="button"
              >
                <StarIcon />
              </button>
            </div>
          );
        })}
      </div>}</CoinBrowser>
    </div>
  );
}

function CoinHead({
  id,
  title,
  lead,
  canBack,
  onBack,
  coin,
  onChangeCoin,
  pending = false,
  unseen = false,
}: Readonly<{ id: string; title: string; lead?: string; canBack: boolean; onBack: () => void; coin?: WalletCoinView; onChangeCoin?: () => void; pending?: boolean; unseen?: boolean }>) {
  return (
    <div className={unseen ? "sr-only" : styles.head}>
      {canBack ? (
        <button aria-label="Back" className={clsx("icon-btn", styles.back)} disabled={pending} onClick={onBack} type="button">
          <PreviousIcon />
        </button>
      ) : null}
      <div className={styles.headText}>
        <h2 id={id}>{title}</h2>
        {coin ? <DisclosureButton aria-label="Change receiving coin" className={styles.receivingCoin} disabled={pending} onClick={onChangeCoin} type="button"><CoinMark coin={coin} size={28} /><span>{coin.name}</span><em className={styles.presaleBadge}>Presale</em></DisclosureButton> : null}
        {lead ? <p className={styles.lead}>{lead}</p> : null}
      </div>
    </div>
  );
}

/** The deposit address's QR code, as an SVG of dark modules. */
function QrCode({ address }: Readonly<{ address: string }>) {
  const path = useMemo(() => {
    const matrix = qrMatrix(address);
    let d = "";
    matrix.forEach((row, y) => row.forEach((dark, x) => {
      if (dark) d += `M${x} ${y}h1v1h-1z`;
    }));
    return { d, size: matrix.length };
  }, [address]);
  return (
    <svg shapeRendering="crispEdges" viewBox={`0 0 ${path.size} ${path.size}`}>
      <path d={path.d} />
    </svg>
  );
}

function DepositAddress({ address, onCopy }: Readonly<{ address: string | null; onCopy: CoinSheetProps["onCopy"] }>) {
  const phone = usePhoneLayout();
  const qr = (
    <div aria-hidden="true" className={styles.qr}>
      {address === null ? <span className={styles.qrSkeleton} /> : <QrCode address={address} />}
    </div>
  );
  return (
    <>
      <div className={styles.depAddr}>
        {phone ? null : qr}
        <div className={styles.t}>
          <span className={styles.cap}>Your deposit address</span>
          <b className="mono">{address === null ? <SkeletonText>0x00000000…00000000</SkeletonText> : address}</b>
          <CopyButton key={address} size="sm" disabled={address === null} label="Copy address" onCopy={() => address === null ? false : onCopy(address)} />
        </div>
      </div>
      <ul className={styles.know}>
        <li>
          <KnowCheckIcon />
          <span>
            Send coins on the <b>Sui network</b> only.
          </span>
        </li>
      </ul>
      {phone && address !== null ? <Disclosure title="Show QR code">{qr}</Disclosure> : null}
    </>
  );
}

function WithdrawAvailable({ coin, known }: Readonly<{ coin: WalletCoinView; known: boolean }>) {
  const hidden = useShellPrefs().amountsHidden;
  const amount = !known ? "—" : hidden ? HIDDEN_AMOUNT : coinAmt(coin, coin.amount);
  return <span>Available {amount}</span>;
}

function coinAtBalance(coin: WalletCoinView, balance: WalletCoinBalance) {
  if (balance.status !== "ready") return coin;
  return { ...coin, atoms: balance.atoms, amount: atomsValue(balance.atoms, coin.decimals) ?? 0 };
}

function withdrawFunding(selectedCoin: WalletCoinView, balance: WalletCoinBalance, gasBalance: WalletCoinBalance, separateGas: boolean, listing: { known: boolean; gas: bigint } | null) {
  const retryBalance = balance.status === "unavailable" ? balance.retry : null;
  const retryGas = separateGas && gasBalance.status === "unavailable" ? gasBalance.retry : null;
  const coin = coinAtBalance(selectedCoin, balance);
  return {
    coin,
    balanceKnown: listing?.known ?? balance.status === "ready",
    gasKnown: listing !== null || !separateGas || gasBalance.status === "ready",
    gas: listing?.gas ?? (gasBalance.status === "ready" ? gasBalance.atoms : coin.atoms),
    retryBalance: retryBalance ?? retryGas,
  };
}

function useWithdrawBalances(selectedCoin: WalletCoinView, fee: SocialTransferFee, address: string | null, enabled: boolean, listing: { known: boolean; gas: bigint } | null) {
  const separateGas = fee === "wallet" && selectedCoin.coinType !== USDC_COIN_TYPE && selectedCoin.coinType !== SUI_COIN_TYPE;
  const exact = enabled && listing === null;
  const balance = useWalletCoinBalance(address, selectedCoin.coinType, exact);
  const gasBalance = useWalletCoinBalance(address, SUI_COIN_TYPE, exact && separateGas);
  return withdrawFunding(selectedCoin, balance, gasBalance, separateGas, listing);
}

function withdrawLabel(check: ReturnType<typeof withdrawCheck>, funded: boolean, checking: boolean) {
  if (checking) return "Check withdrawal";
  return funded ? check.label : "Withdraw";
}

function WithdrawTerms({ coinType, fee }: Readonly<{ coinType: string; fee: SocialTransferFee }>) {
  return (
    <dl className={styles.terms}>
      <div>
        <dt>Network fee</dt>
        <dd>{coinType === USDC_COIN_TYPE ? "Free" : fee === "sponsored" ? "Paid by Blast" : "Paid from your SUI"}</dd>
      </div>
      <div>
        <dt>Arrives</dt>
        <dd>In a few seconds</dd>
      </div>
    </dl>
  );
}

function WithdrawAmount({ id, coin, amount, value, locked, balanceKnown, amountRef, onAmount, onMax }: Readonly<{
  id: string;
  coin: WalletCoinView;
  amount: string;
  value: string;
  locked: boolean;
  balanceKnown: boolean;
  amountRef: React.RefObject<HTMLInputElement | null>;
  onAmount: (value: string) => void;
  onMax: () => void;
}>) {
  const usdc = coin.key === "usdc";
  return (
    <div className={styles.amt}>
      <div className={styles.amtTop}>
        <label htmlFor={`${id}-amount`}>Amount</label>
        <button
          className="btn btn-quiet btn-sm"
          disabled={!balanceKnown || locked}
          onClick={onMax}
          type="button"
        >
          Max
        </button>
      </div>
      <div className={styles.amtRow}>
        {usdc ? <span className={styles.cur}>$</span> : null}
        <AmountFit value={amount}>
          <input
            autoComplete="off"
            data-coin-focus=""
            disabled={locked}
            id={`${id}-amount`}
            inputMode="decimal"
            onChange={(event) => onAmount(decimalText(event))}
            onPaste={(event) => pasteDecimal(event, onAmount)}
            onDrop={(event) => dropDecimal(event, onAmount)}
            placeholder="0"
            ref={amountRef}
            value={amount}
          />
        </AmountFit>
        {usdc ? null : <span className={styles.amtSym}>{coin.symbol}</span>}
      </div>
      <div className={styles.amtFoot}>
        <span>{value}</span>
        <WithdrawAvailable coin={coin} known={balanceKnown} />
      </div>
    </div>
  );
}

function WithdrawForm({
  active,
  coin: selectedCoin,
  fee,
  address,
  suiAtoms,
  trading,
  balanceKnown: listingKnown,
  onWithdraw,
}: Readonly<{
  active: boolean;
  coin: WalletCoinView;
  fee: SocialTransferFee;
  address: string | null;
  suiAtoms: bigint;
  trading: CoinSheetTrading;
  balanceKnown: boolean;
  onWithdraw: CoinSheetProps["onWithdraw"];
}>) {
  const id = useId();
  const enabled = active && trading.signedIn && !trading.sessionPending;
  const listing = trading.walletAddress === undefined ? { known: listingKnown, gas: suiAtoms } : null;
  const { coin, balanceKnown, gasKnown, gas, retryBalance } = useWithdrawBalances(selectedCoin, fee, address, enabled, listing);
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [pending, setPending] = useState<Readonly<{ address: string; ask: WithdrawAsk }> | null>(null);
  const pendingAsk = pending !== null && pending.address === address ? pending.ask : null;
  useSignInDraft(`coins:withdraw:${coin.key}`, !trading.signedIn ? { amount, to } : null, (saved) => {
    setAmount(saved.amount ?? "");
    setTo(saved.to ?? "");
  }, active);
  const [touched, setTouched] = useState(false);
  const typeAmount = (text: string) => {
    setAmount(fmtLive(text, coin.decimals));
    setTouched(true);
  };
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [failed, setFailed] = useState<string | null>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const check = withdrawCheck({ coin, amountText: amount, to, touched, fee, own: address ?? "", suiAtoms: gas });
  useEffect(() => {
    return focusAfterDelay(() => amountRef.current, 60, { preventScroll: true });
  }, []);
  const funded = balanceKnown && gasKnown;
  const checking = pendingAsk !== null;
  const canSend = checking || (funded && check.ready);
  const locked = busy || checking;
  const label = withdrawLabel(check, funded, checking);
  const action = authenticatedAction(trading, label, "Sign in to withdraw", !canSend, busy);
  const send = async () => {
    if (!active || trading.sessionPending || sending.current) return;
    if (!trading.signedIn) return trading.onSignIn();
    if (!canSend || busy) return;
    const ask = pendingAsk ?? (check.atoms === null ? null : { coin, atoms: check.atoms, amount: numIn(amount), recipient: to.trim().toLowerCase() });
    if (ask === null) return;
    sending.current = true;
    setBusy(true);
    setFailed(null);
    const done = await onWithdraw(ask).catch((error: unknown) => {
      setFailed(publicErrorMessage(error, "Withdrawal could not be confirmed. Try again to check it.", "execution_unconfirmed"));
      return pendingAsk === null ? false : "pending";
    }).finally(() => {
      sending.current = false;
    });
    setPending(done === "pending" && address !== null ? { address, ask } : null);
    setBusy(done === true);
  };
  return (
    <>
      <WithdrawAmount
        id={id}
        coin={coin}
        amount={amount}
        value={check.value}
        locked={locked}
        balanceKnown={balanceKnown}
        amountRef={amountRef}
        onAmount={typeAmount}
        onMax={() => { setAmount(groupDigits(exactText({ n: maxWithdrawAtoms(coin, fee), scale: coin.decimals }))); setTouched(true); }}
      />
      <WithdrawDestination
        id={id}
        to={to}
        locked={locked}
        bad={check.bad}
        message={trading.signedIn ? check.message : "Sign in to withdraw"}
        onResolved={setTo}
        onChange={(value) => {
          setTo(value);
          setTouched(true);
        }}
      />
      <WithdrawTerms coinType={coin.coinType} fee={fee} />
      <WithdrawActions
        action={action}
        busy={busy}
        restoringSession={trading.sessionPending === true}
        checking={checking}
        retryBalance={retryBalance}
        failed={failed}
        onSend={() => void send()}
      />
    </>
  );
}

function WithdrawActions({
  action,
  busy,
  restoringSession,
  checking,
  retryBalance,
  failed,
  onSend,
}: Readonly<{
  action: ReturnType<typeof authenticatedAction>;
  busy: boolean;
  restoringSession: boolean;
  checking: boolean;
  retryBalance: (() => void) | null;
  failed: string | null;
  onSend: () => void;
}>) {
  return (
    <>
      {retryBalance && !checking ? <Button onClick={retryBalance} size="sm" variant="secondary">Retry balance</Button> : null}
      {failed ? <p className={styles.status} role="alert">{failed}</p> : null}
      <button className="btn btn-primary btn-lg btn-block" disabled={action.disabled} onClick={onSend} type="button">
        {busy ? (
          <>
            <span className={styles.spin} />
            Sending
          </>
        ) : <LoadingIndicator label="Restoring session…" loading={restoringSession}>{action.label}</LoadingIndicator>}
      </button>
    </>
  );
}

function WithdrawDestination({ id, to, locked, bad, message, onChange, onResolved }: Readonly<{
  id: string;
  to: string;
  locked: boolean;
  bad: boolean;
  message: string;
  onChange: (value: string) => void;
  onResolved: (address: string) => void;
}>) {
  const destination = useSuiAddressLookup(to, onResolved);
  const badAddress = destination.name ? destination.error !== null : bad;
  return (
    <div className={styles.field}>
      <label htmlFor={`${id}-to`}>To</label>
      <div className={styles.input}>
        <input
          aria-describedby={`${id}-msg`}
          aria-invalid={badAddress || undefined}
          autoCapitalize="off"
          autoComplete="off"
          disabled={locked}
          id={`${id}-to`}
          onBlur={(event) => destination.lookup(event.currentTarget.value)}
          onChange={(event) => {
            destination.invalidate();
            onChange(event.target.value);
          }}
          onKeyDown={destination.onKeyDown}
          placeholder={SUI_ADDRESS_PLACEHOLDER}
          spellCheck={false}
          value={to}
        />
      </div>
      <span aria-live="polite" className={clsx(styles.msg, badAddress && styles.bad)} id={`${id}-msg`}>
        <WithdrawAddressMessage destination={destination} fallback={message} />
      </span>
      <span className="sr-only" role="status">{destination.confirmation}</span>
    </div>
  );
}

function WithdrawAddressMessage({ destination, fallback }: Readonly<{ destination: ReturnType<typeof useSuiAddressLookup>; fallback: string }>) {
  if (destination.status === "pending") return <LoadingIndicator label={SUI_NAME_LOOKUP_LABEL} />;
  if (destination.error) return <DiagnosticText message={destination.error} />;
  return destination.name ? "Press Enter or leave the field to look up the name." : fallback;
}

/**
 * The trade screen's state, kept by the sheet so a trip to the picker keeps
 * it; `focus` is the coin a Buy or Sell opened it for (OA-48, the gate's
 * `st.focus`), kept through flips, picks and quotes.
 */
type TradeState = Readonly<{ pair: SwapPair; field: TradeAmount; detail: boolean; focus: string | null }>;

/** Wallet balances lead public metadata and picker choices when resolving the pair. */
function tradeView(trade: TradeState, coins: readonly WalletCoinView[], coinOf: (key: string) => WalletCoinView) {
  const inCoin = coins.find((coin) => coin.key === trade.pair.in) ?? coinOf("usdc");
  const outCoin = coins.find((coin) => coin.key === trade.pair.out) ?? coinOf(inCoin.key === "sui" ? "usdc" : "sui");
  return { inCoin, outCoin, field: trade.field };
}

/** The trade pair of the opening screen; navigation retains later edits. */
function initialTrade(screen: CoinScreen): TradeState {
  const pair = screen.kind === "trade" ? { in: screen.key, out: screen.out ?? pairFor(screen.key).out } : pairFor("usdc");
  return { pair, field: EMPTY_TRADE_AMOUNT, detail: false, focus: screen.kind === "trade" ? screen.focus ?? null : null };
}
