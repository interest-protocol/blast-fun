"use client";
import { EMPTY_TRADE_AMOUNT, type TradeDraft } from "#web/components/social/trade/trade-ticket.ts";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { Checkbox } from "#web/components/blast-ui/Checkbox.tsx";

import { useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { normalizeStructTag } from "@mysten/sui/utils";
import { exactAtoms, exactText, groupedExact, type Exact } from "@blast/core/web/exact-amount.ts";
import { NO_VALUE } from "@blast/core/web/format.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { useShellActions } from "#web/components/blast-ui/shell-actions.tsx";
import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { fetchWalletBalance } from "#web/components/social/coins/coins-client.ts";
import { refreshWalletCoinBalance, useWalletCoinBalance } from "#web/components/social/coins/use-wallet-coin-balance.ts";
import { walletIdentityQuery, walletIdentityScope } from "#web/components/social/queries.ts";
import { useSocialViewer } from "#web/components/social/SignInGate.tsx";
import { useTradeQuoteQuery } from "#web/components/social/trade/trade-quote-query.ts";
import { browserRoutable, estimateReads, type EstimateCoin } from "#web/components/social/trade/trade-estimate.ts";
import { TRADE_QUOTE_SHOWN_REFRESH_MS, tradeQuoteKey } from "#web/components/social/trade/trade-quotes.ts";
import { isOffered, sealRefusalLine } from "#web/components/social/trades/trade-quote-view.ts";
import type {
  TradeFeeRequired,
  SocialTradeQuoteRequest,
  SocialTradeQuote,
} from "@blast/core/web/contracts/trades.ts";
import {
  amountInAtoms,
  closeRequests,
  fieldValue,
  isEmptyDraft,
  overBalance,
  quoteScope,
  tradeCta,
  tradeQuoteLine,
  tradeRequest,
  type TradeFacts,
} from "./trade-model";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { TickerText } from "#web/components/blast-ui/Ticker.tsx";
import type { CoinPanelProps } from "./CoinPanel";
import type { CoinRecord } from "./coin-reads";
import tradeStyles from "./CoinTrade.module.css";
import { compactFigure } from "#web/lib/market-format.ts";
import { coinFacts } from "./coin-facts";
import { CoinCounterPicker, useCoinCounter } from "./CoinCounterPicker";
import { CoinQuoteDetails } from "./CoinQuoteDetails";
import { CoinTradeFields } from "./CoinTradeFields";
import { CoinDetails } from "./CoinDetails";
import { CoinDetailsSlots } from "./panel-context";
import { ActionConfirmation } from "../ActionConfirmation";
import { useCoinWalletRead } from "./use-coin-read";
import { tradePresetDraft } from "./trade-presets";
import { useTradePresets } from "./use-trade-presets";
import { useWorkspaceLiveClock, useWorkspaceLiveKey } from "../live-clock";


function matchingQuote(
  request: SocialTradeQuoteRequest | null,
  key: string | null,
  quote: SocialTradeQuote | null,
  scope: string,
) {
  if (!request || key !== tradeQuoteKey(request, scope) || !quote) return null;
  return quote.side === request.side &&
    quote.in_coin === request.in_coin &&
    quote.out_coin === request.out_coin &&
    quote.amount_in === request.amount_in &&
    quote.slippage_bps === request.slippage_bps
    ? quote
    : null;
}

/** The estimate is refreshed on screen this often; a press seals the number with the server (`trade-estimate.ts`). */
const ESTIMATE_POLICY = { shownRefreshMs: TRADE_QUOTE_SHOWN_REFRESH_MS };

/**
 * How far below the number on screen a sealed quote may land and still send on the same press: 10 bp. The estimate
 * and the seal are two Cetus answers a second apart, so they rarely match to the unit; the worst fill is then
 * estimate × 0.999 × (1 − slippage).
 */
const SEALED_DROP_TOLERANCE_BPS = 10n;

/**
 * Whether the sealed quote gives more than `SEALED_DROP_TOLERANCE_BPS` less than the number on screen. Its floor
 * (`min_out`) is what the trade carries, so a lower number is shown and needs its own press: nothing fills well below a floor the person did not see. A higher one always sends.
 */
function sealedBelowShown(shown: SocialTradeQuote, sealed: SocialTradeQuote) {
  if (shown.amount_out === null || sealed.amount_out === null) return false;
  return BigInt(sealed.amount_out) * 10_000n < BigInt(shown.amount_out) * (10_000n - SEALED_DROP_TOLERANCE_BPS);
}

function estimatePrice(price: Exact | null) {
  return price === null ? null : Number(exactText(price));
}

/** The pair as the estimate prices it: the coin (with its venue, so an Aftermath DAO-fee coin asks the server) and the counter coin. */
function estimateCoins(facts: TradeFacts, coin: CoinRecord | null): EstimateCoin[] {
  const coins: EstimateCoin[] = [];
  const venue = coin?.venue ?? null;
  if (facts.coinType !== null && facts.decimals !== null) {
    coins.push({ coinType: facts.coinType, symbol: facts.symbol, decimals: facts.decimals, price: estimatePrice(facts.price), presale: venue === null ? null : { venue } });
  }
  if (facts.counter) {
    coins.push({ coinType: facts.counter.coinType, symbol: facts.counter.symbol, decimals: facts.counter.decimals, price: estimatePrice(facts.counter.price) });
  }
  return coins;
}

/** The presets' questions for this side, as a tap on each would ask them. */
function presetRequests(side: "buy" | "sell", values: readonly string[], facts: TradeFacts, slippageBps: number): SocialTradeQuoteRequest[] {
  return values.flatMap((value) => {
    const draft = tradePresetDraft(side, value, facts);
    const asked = draft === null ? null : tradeRequest(draft, facts);
    return asked === null ? [] : [{ ...asked, slippage_bps: slippageBps }];
  });
}

/**
 * The read-ahead questions, kept while every amount stays within 1% of the kept one. A buy preset is dollars, so its
 * amount follows the counter coin's price, which moves on each wallet read: without this every tick would read all
 * presets again.
 */
function useSteadyRequests(requests: SocialTradeQuoteRequest[]): readonly SocialTradeQuoteRequest[] {
  const [kept, setKept] = useState(requests);
  if (!closeRequests(kept, requests)) setKept(requests);
  return kept;
}

function canSubmit(
  value: Readonly<{
    visible: boolean;
    busy: boolean;
    supportedNetwork: boolean;
    authenticated: boolean;
    walletReady: boolean;
    decimals: number | null;
    disabled: boolean;
    consumed: string | null;
    estimateKey: string | null;
    fee: TradeFeeRequired | null | undefined;
    consent: boolean;
  }>,
) {
  if (!value.visible || value.busy || !value.supportedNetwork) return false;
  if (!value.authenticated) return true;
  if (
    !value.walletReady ||
    value.decimals === null ||
    value.disabled ||
    (value.consumed !== null && value.consumed === value.estimateKey)
  )
    return false;
  return !value.fee || (value.fee.payable !== false && value.consent);
}

/** Selection changes clear local review state before paint; the async generation changes at commit. */
/** How long a quote may stay pending before the ticket says it is unavailable (audit 19). */
const QUOTE_PATIENCE_MS = 8_000;

/**
 * Whether the pending quote for `pendingKey` has waited past {@link QUOTE_PATIENCE_MS}. One wait
 * per pending request on the workspace clock, so leaving Blast mode stops it; an answer, a
 * failure or a new request (a new key) ends it.
 */
function useLateQuote(pendingKey: string | null, clock: Readonly<{ after: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void }>) {
  const [late, setLate] = useState<string | null>(null);
  useEffect(() => {
    if (pendingKey === null) return;
    const handle = clock.after(() => setLate(pendingKey), QUOTE_PATIENCE_MS);
    return () => clock.clear(handle);
  }, [pendingKey, clock]);
  return pendingKey !== null && late === pendingKey;
}

function useTradeDeactivation(visible:boolean,generationRef:RefObject<number>,reset:()=>void) {
  const [lastVisible,setLastVisible]=useState(visible);
  if(lastVisible !== visible){setLastVisible(visible);if(!visible)reset();}
  useLayoutEffect(()=>{if(!visible)generationRef.current++;},[visible,generationRef]);
}

type CoinTradeProps = Pick<
  CoinPanelProps,
  "asset" | "coin_setup" | "onSetupChange" | "effective_visibility" | "actions"
> &
  Readonly<{ compact?: boolean; unavailable?: boolean; identityStatus?: "pending" | "ready" | "error"; retryIdentity?: () => void; coin: CoinRecord | null }>;

function activeQuoteRequest(
  request: SocialTradeQuoteRequest | null,
  readiness: Readonly<{
    visible: boolean;
    supportedNetwork: boolean;
    decimals: number | null;
    hasTradeKit: boolean;
    walletReady: boolean;
  }>,
) {
  if (
    !readiness.visible ||
    !readiness.supportedNetwork ||
    readiness.decimals === null ||
    !readiness.hasTradeKit ||
    !readiness.walletReady
  ) {
    return null;
  }
  return request;
}

/** Wallet holdings can supply pricing metadata. Only the exact paying-coin read supplies spendable atoms. */
function withPaymentBalance(facts: TradeFacts, side: "buy" | "sell", atoms: bigint | null): TradeFacts {
  return {
    ...facts,
    usdc: side === "buy" && !facts.counter ? atoms : null,
    held: side === "sell" ? atoms : null,
    counter: facts.counter && { ...facts.counter, balance: side === "buy" ? atoms : null },
  };
}

const noToken = async () => null;

function useTradeWallet({
  asset,
  coin_setup: setup,
  effective_visibility: visible,
  actions,
  unavailable,
}: CoinTradeProps) {
  const kit = actions.trade;
  const queries = useAppQueryClient();
  const viewer = useSocialViewer();
  const { getAccessToken } = viewer;
  const authenticated = actions.authenticated && kit?.signedIn === true;
  const supportedNetwork = asset.network === "mainnet";
  const active = visible && supportedNetwork && authenticated && !unavailable;
  const identity = useQuery({ ...walletIdentityQuery(walletIdentityScope(viewer), getAccessToken ?? noToken), enabled: active && !!getAccessToken }, queries);
  const address = !identity.isError ? identity.data?.address : null;
  // The listing only provides pricing and picker metadata, independently of the payment read.
  const readHoldings = useCallback(() => kit?.wallet() ?? Promise.resolve(null), [kit]);
  const holdings = useCoinWalletRead(active, actions.actor_key, readHoldings).value;
  const side = setup.trade.side;
  const counter = useCoinCounter(side, holdings, asset.coin_type);
  const paymentCoin = normalizeStructTag(side === "buy" ? counter.facts.coinType : asset.coin_type);
  const balance = useWalletCoinBalance(address, paymentCoin, active, identity.isPending && !!getAccessToken);
  return {
    wallet: holdings,
    identity: identity.data,
    rereadIdentity: () => void identity.refetch(),
    address,
    paymentCoin,
    counter,
    atoms: balance.status === "ready" ? balance.atoms : null,
    supportedNetwork,
    authenticated,
    getAccessToken,
    status: balance.status === "ready" ? "ready" : balance.status === "loading" ? "pending" : "error",
    reread: () => {
      if (address) void refreshWalletCoinBalance(queries, address, paymentCoin);
      if (!address || balance.status === "unavailable") void identity.refetch();
    },
  } as const;
}

function useCoinTrade(props: CoinTradeProps) {
  const { asset, coin_setup: setup, onSetupChange, effective_visibility: visible, actions, coin } = props;
  const kit = actions.trade;
  const walletRead = useTradeWallet(props);
  const { address, counter, authenticated, supportedNetwork, getAccessToken, paymentCoin } = walletRead;
  const clock = useWorkspaceLiveClock();
  const presentationKey = useWorkspaceLiveKey(visible);
  const side = setup.trade.side;
  const facts = withPaymentBalance(
    { ...coinFacts(asset.coin_type, coin, walletRead.wallet, authenticated), counter: counter.facts },
    side,
    walletRead.atoms,
  );
  const { symbol, decimals } = facts;
  const draft = { side, ...setup.trade[side] };
  const requested = tradeRequest(draft, facts);
  const request = requested
    ? { ...requested, slippage_bps: setup.trade.slippage_bps }
    : null;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [fee, setFee] = useState<Readonly<{
    id: string;
    offer: TradeFeeRequired;
  }> | null>(null);
  const [consent, setConsent] = useState(false);
  const pressing = useRef(false);
  const [consumed, setConsumed] = useState<string | null>(null);
  const [review, setReview] = useState<string | null>(null);
  const reviewGeneration = useRef(0);
  const serverQuote = useCallback(
    (...args: Parameters<NonNullable<typeof kit>["quote"]>) =>
      kit ? kit.quote(...args) : Promise.resolve({ status: "error" as const }),
    [kit],
  );
  // Typing and presets read an estimate (Cetus from the browser); the press seals it with the server.
  const routeCoins = estimateCoins(facts, coin);
  const reads = estimateReads(kit?.route, routeCoins, serverQuote);
  const readiness = { visible, supportedNetwork, decimals, hasTradeKit: Boolean(kit), walletReady: walletRead.status === "ready" };
  // The presets are read ahead so a tap shows its number at once, from the browser's route only (`prefetchRead`):
  // through the server, four presets would be four server calls per open panel.
  const presets = useTradePresets();
  const prefetch = useSteadyRequests(kit?.route && browserRoutable(routeCoins)
    ? presetRequests(side, presets[side], facts, setup.trade.slippage_bps).flatMap((ahead) => activeQuoteRequest(ahead, readiness) ?? [])
    : []);
  // Retry asks a fresh question: a stuck first read has no answer for TanStack to cancel, so a new attempt is a new key.
  const [quoteAttempt, setQuoteAttempt] = useState(0);
  const retryQuote = () => setQuoteAttempt((attempt) => attempt + 1);
  const scope = `${actions.actor_key}:${asset.network}:${quoteScope(facts)}:${presentationKey}:${quoteAttempt}`;
  const quotes = useTradeQuoteQuery({
    ...reads,
    request: activeQuoteRequest(request, readiness),
    scope,
    held: busy,
    timers: clock,
    policy: ESTIMATE_POLICY,
    prefetch,
  });
  const quote = matchingQuote(request, quotes.key, quotes.quote, scope);
  const late = useLateQuote(request !== null && quote === null && quotes.error === null ? quotes.key : null, clock);
  const cta = tradeCta({ draft, facts, quote, nowMs: quotes.nowMs, estimate: true });
  // The estimate on screen: a finished or unknown trade blocks it until a fresh one is read (the same amount may be
  // traded again then); a fee offer holds only for the number it was shown on.
  const estimateKey = quote === null ? null : `${quotes.key}@${quote.quoted_at_ms}`;
  const feeOffer = estimateKey !== null && fee?.id === estimateKey ? fee.offer : null;
  const hidden = useShellPrefs().amountsHidden;
  const quoteLine = tradeQuoteLine({
    draft,
    facts,
    quote,
    failed: quotes.error !== null,
    hidden,
    feeMist: feeOffer?.feeMist,
  });
  const preferenceReady = actions.confirmation?.status === "ready";
  const ready =
    preferenceReady &&
    canSubmit({
      visible,
      busy,
      supportedNetwork,
      authenticated,
      walletReady: walletRead.status === "ready",
      decimals,
      disabled: cta.disabled,
      consumed,
      estimateKey,
      fee: feeOffer,
      consent,
    });
  const reviewKey = JSON.stringify([
    actions.actor_key,
    address,
    walletRead.identity?.fee,
    actions.confirmation,
    request,
    quote,
    feeOffer,
    consent,
  ]);
  const current = useRef({ visible, actions, kit, reviewKey, setup, onSetupChange });
  useLayoutEffect(() => {
    current.current = { visible, actions, kit, reviewKey, setup, onSetupChange };
  });
  useLayoutEffect(
    () => () => {
      current.current.visible = false;
    },
    [],
  );
  useTradeDeactivation(visible,reviewGeneration,()=>{setReview(null);setFee(null);setConsent(false);});
  const change = (trade: typeof setup.trade) => {
    setMessage(null);
    setFee(null);
    setConsent(false);
    onSetupChange({ ...setup, trade });
  };
  const cancelReview = () => {
    reviewGeneration.current++;
    setReview(null);
  };

  /** Check the reviewed payment against the current exact balance, independently of the holdings display. */
  async function confirmedFacts(isCurrent: () => boolean) {
    if (!getAccessToken || !address) return;
    const balance = await fetchWalletBalance({ getAccessToken }, paymentCoin);
    if (!isCurrent()) return;
    if (balance.status !== "ok") {
      setMessage("The current balance could not load. Nothing was sent. Your draft is kept.");
      walletRead.reread();
      return;
    }
    const atoms = BigInt(balance.body.atoms);
    const freshFacts = withPaymentBalance(facts, side, atoms);
    const freshRequest = tradeRequest(draft, freshFacts);
    if (
      balance.body.address !== address ||
      balance.body.coin_type !== paymentCoin ||
      atoms < BigInt(request?.amount_in ?? "0") ||
      !freshRequest ||
      JSON.stringify({
        ...freshRequest,
        slippage_bps: setup.trade.slippage_bps,
      }) !== JSON.stringify(request)
    ) {
      setMessage(
        "Your wallet or trade amount changed. Review the updated facts. Nothing was sent.",
      );
      if (balance.body.address !== address) walletRead.rereadIdentity();
      else walletRead.reread();
      return;
    }
    return freshFacts;
  }

  /**
   * The sealed quote for the number on screen: the server's, offered, still
   * tradeable, and giving at least what is shown. A lower one is put on
   * screen in its place and the press stops; the next press sends it as
   * shown. Anything else stops the press; nothing is sent.
   */
  async function sealQuote(shown: SocialTradeQuote, confirmed: boolean, isCurrent: () => boolean) {
    const checked = confirmed ? await confirmedFacts(isCurrent) : facts;
    if (!checked) return;
    const answer = shown.quote_id !== null && isOffered(shown, Date.now()) ? { status: "ok" as const, quote: shown } : await kit!.quote(request!);
    if (!isCurrent()) {
      // The number on screen changed while the server sealed it (a refresh, a price tick): say so, never end silently.
      if (current.current.visible && current.current.reviewKey !== reviewKey) setMessage("The price updated. Check it and press again. Nothing was sent.");
      return;
    }
    // Not asked (busy, offline): the estimate still stands, so the next press is the retry.
    if (answer.status !== "ok") {
      setMessage("The price could not be confirmed. Nothing was sent. Press to try again.");
      return;
    }
    // Refused for this wallet or pool (a short balance, no pool, a failed dry run): the line says why, the estimate
    // stays and the next press asks again. Nothing asks the server on its own.
    const refused = sealRefusalLine(answer.quote, side === "buy" ? facts.counter?.symbol ?? "USDC" : symbol);
    if (refused !== null) {
      setMessage(refused);
      if (answer.quote.offer_refused === "insufficient_balance") walletRead.reread();
      return;
    }
    if (
      !isOffered(answer.quote, Date.now()) ||
      tradeCta({ draft, facts: checked, quote: answer.quote, nowMs: Date.now() }).disabled
    ) {
      setMessage(
        "Your quote, balance or route changed. Review a fresh quote. Nothing was sent.",
      );
      quotes.refresh({ cancel: true });
      walletRead.reread();
      return;
    }
    if (sealedBelowShown(shown, answer.quote)) {
      quotes.show(answer.quote);
      setMessage("The price moved. Check the new amount and press again. Nothing was sent.");
      return;
    }
    return answer.quote;
  }

  function receiveResult(
    result: Awaited<ReturnType<NonNullable<typeof kit>["send"]>>,
    pressed: string,
  ) {
    if (result.status === "fee_required") {
      setFee({ id: pressed, offer: result });
      setConsent(false);
      setMessage(
        result.message ??
          "Blast cannot pay this network fee. Review payment from your SUI.",
      );
    } else if (result.status === "refused") {
      setMessage(result.message);
      quotes.refresh();
    } else {
      setConsumed(pressed);
      setMessage(result.title);
      // A finished trade leaves an empty typed box, whatever the entry was (typed, Max or a saved USD sell),
      // so the next one is never typed into the old amount nor refilled with the balance (#1012).
      const { setup: latest, onSetupChange: save } = current.current;
      save({ ...latest, trade: { ...latest.trade, ...(side === "sell" ? { sell: EMPTY_TRADE_AMOUNT } : { buy: { typed: "", mode: "typed" as const } }) } });
      quotes.invalidate();
    }
  }

  const coins = {
    in:
      side === "buy"
        ? { symbol: counter.facts.symbol, decimals: counter.facts.decimals }
        : { symbol, decimals: decimals!, iconUrl: coin?.icon_url },
    out:
      side === "buy"
        ? { symbol, decimals: decimals!, iconUrl: coin?.icon_url }
        : { symbol: counter.facts.symbol, decimals: counter.facts.decimals },
  };
  const feeConsent = feeOffer && consent ? { acceptFee: true as const } : {};

  const displayingOrigin = () =>
    current.current.visible && current.current.kit === kit;

  async function submit(confirmed = false) {
    if (!ready || pressing.current || !visible) return;
    if (!authenticated) {
      actions.signIn();
      return;
    }
    if (!kit || !address || !quote || estimateKey === null || quote.amount_out === null) {
      quotes.refresh();
      return;
    }
    if (consumed === estimateKey) return;
    if (actions.confirmation?.status !== "ready") return;
    if (actions.confirmation.enabled && !confirmed) {
      setReview(reviewKey);
      return;
    }
    if (confirmed && review !== reviewKey) return;
    pressing.current = true;
    setBusy(true);
    setMessage(null);
    const generation = reviewGeneration.current;
    const send = async () => {
      let sendStarted = false;
      try {
        const submittedQuote = await sealQuote(
          quote,
          confirmed,
          () =>
            current.current.visible &&
            current.current.kit === kit &&
            current.current.reviewKey === reviewKey &&
            reviewGeneration.current === generation,
        );
        if (!submittedQuote) return;
        setReview(null);
        sendStarted = true;
        const result = await kit.send({
          quote: submittedQuote,
          coins,
          walletAddress: address,
          ...feeConsent,
        });
        if (displayingOrigin()) receiveResult(result, estimateKey);
      } catch {
        if (!sendStarted) {
          setMessage(
            "The current trade facts could not load. Nothing was sent. Your draft is kept.",
          );
          return;
        }
        setMessage(
          "The trade result could not be checked. Check your transaction history before trying again.",
        );
        setConsumed(estimateKey);
      }
    };
    await send().finally(() => {
      pressing.current = false;
      setBusy(false);
      setReview(null);
    });
  }

  const exact: ExactTradeValue = (...args) => exactTradeValue(hidden, ...args);
  const short: ExactTradeValue = (...args) => exactTradeValue(hidden, ...args, true);
  return { preference: actions.confirmation, setup, facts, busy, walletRead, authenticated, hidden, change, side, counter, supportedNetwork, cancelReview, setFee, setConsent, setMessage, ready, cta, submit, quoteLine, request, draft, quotes, late, retryQuote, decimals, quote, feeOffer, consent, message, review, reviewKey, symbol, exact, short };
}

function balancePending(props: CoinTradeProps, walletStatus: string) {
  return props.identityStatus === "pending" || (!props.unavailable && props.effective_visibility && walletStatus === "pending");
}

function identityFeedback(props: CoinTradeProps): TradeStatus {
  if (props.identityStatus === "pending") return { text: "Verifying asset information", pending: true };
  if (props.identityStatus === "error") return { text: "Asset information could not load.", alert: true, retry: props.retryIdentity };
  return { text: "Trading is unavailable for this asset.", alert: true };
}

export function CoinTrade(props: CoinTradeProps) {
  const { compact = false, unavailable = false, asset, effective_visibility: visible, coin } = props;
  const state = useCoinTrade(props);
  const {
    setup,
    facts,
    busy,
    walletRead,
    authenticated,
    hidden,
    change,
    side,
    counter,
    supportedNetwork,
    cancelReview,
    setFee,
    setConsent,
    setMessage,
    ready,
    submit,
    quoteLine,
    draft,
    quote,
    feeOffer,
    consent,
    review,
    reviewKey,
    symbol,
    exact,
    short,
  } = state;
  const status = unavailable ? identityFeedback(props) : tradeStatus(state, unavailable);
  const feedbackId = useId();
  const detailSlots = useContext(CoinDetailsSlots);
  const [tradeSlot, setTradeSlot] = useState<HTMLDivElement | null>(null);
  const mark =
    side === "buy" ? (
      <CoinMark coin={counter.choice.coin} size={16} />
    ) : (
      <CoinMark
        coin={{ key: asset.coin_type, coinType: asset.coin_type, symbol, iconUrl: coin?.icon_url ?? null, round: false }}
        size={16}
      />
    );
  return (
    <CoinDetailsSlots.Provider value={{...detailSlots,trade:tradeSlot}}>
    <section className={tradeStyles.form} aria-label="Trade" data-unavailable={unavailable} data-compact={compact}>
      <CoinTradeFields
        feedbackId={feedbackId}
        trade={setup.trade}
        facts={facts}
        busy={busy || unavailable}
        walletReady={walletRead.status === "ready"}
        authenticated={authenticated}
        hidden={hidden}
        change={change}
        summary={
          <QuoteSummary
            line={quoteLine}
            draft={draft}
            facts={facts}
            quote={quote}
            hidden={hidden}
            wait={quoteWait(state)}
          />
        }
        balance={authenticated ? <CoinAvailableBalance side={side} facts={facts} value={short} mark={mark} loading={balancePending(props, walletRead.status)} /> : null}
        detailsSlot={<div className={tradeStyles.detailsSlot} ref={setTradeSlot}/>}
        counterPicker={<CoinCounterPicker active={visible} side={side} counter={counter} wallet={walletRead.wallet} hidden={hidden} disabled={busy || !visible || !supportedNetwork} onChange={() => {cancelReview();setFee(null);setConsent(false);setMessage(null);}}/>}
        action={<CoinSubmit
          ready={ready && !unavailable}
          guest={!authenticated}
          busy={busy}
          label={!authenticated ? `Sign in to ${side} ${symbol}` : submitPrerequisite(state, unavailable) ?? (side === "buy" ? buyLabel(draft, facts, symbol, hidden) : `Sell ${symbol}`)}
          side={side}
          submit={() => void submit()}
        />}
      />
      <div className={tradeStyles.notices} data-empty={!hasTradeNotice(status, feeOffer)}>
        <CoinDetails kind="trade" label="Trade details" text="Details">
          <SavedDraftNote state={state} />
          <p className={tradeStyles.slippageNote}>Max slippage <b className="num">{setup.trade.slippage_bps / 100}%</b> · change it in Trade settings</p>
          <CoinQuoteDetails
            hasAmount={!isEmptyDraft(draft)}
            quote={quote}
            fee={feeOffer}
            facts={facts}
            side={side}
            exact={exact}
          />
        </CoinDetails>
        <TradeFeedback id={feedbackId} status={status} />
        <CoinFeeConsent
          fee={feeOffer}
          exact={exact}
          busy={busy}
          consent={consent}
          onConsent={setConsent}
        />
      </div>
      <ActionConfirmation
        open={review !== null && visible}
        busy={busy}
        valid={ready && review === reviewKey}
        action={side === "buy" ? "Buy" : "Sell"}
        asset={symbol}
        onCancel={cancelReview}
        onConfirm={() => void submit(true)}
      >
        <CoinQuoteDetails
          quote={quote}
          fee={feeOffer}
          facts={facts}
          side={side}
          exact={(...args) => exactTradeValue(false, ...args)}
        />
        <p>
          Slippage limit: {setup.trade.slippage_bps / 100}% · Network:{" "}
          {asset.network}
        </p>
      </ActionConfirmation>
    </section>
    </CoinDetailsSlots.Provider>
  );
}

/** The buy action names its dollar amount once one is entered ("Buy $100 of WAL"); hidden amounts stay out of it. */
function buyLabel(draft: TradeDraft, facts: TradeFacts, symbol: string, hidden: boolean) {
  const value = fieldValue(draft, facts).trim().replaceAll(",", "");
  const valid = /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) && /[1-9]/.test(value);
  return valid && !hidden ? `Buy $${value} of ${symbol}` : `Buy ${symbol}`;
}

/** A pending read is not a notice: the balance skeleton shows it, so the row keeps its ready height. */
function hasTradeNotice(status: TradeStatus, fee: TradeFeeRequired | null | undefined) {
  return Boolean((status?.text && !status.pending) || fee);
}

function TradeFeedback({ id, status }: Readonly<{ id: string; status: TradeStatus }>) {
  const run = useShellActions();
  return <p id={id} role={status?.alert ? "alert" : "status"} data-trade-feedback="" data-pending={status?.pending || undefined}>
    {status?.pending ? <span className="sr-only">{status.text}</span> : status?.text}
    {status?.fund && <> <Button variant="ghost" size="sm" className={tradeStyles.pill} type="button" onClick={() => run("openDeposit")}>Add funds</Button></>}
    {status?.retry && <> <Button variant="ghost" size="sm" className={tradeStyles.pill} type="button" onClick={status.retry}>Retry</Button></>}
  </p>;
}

function SavedDraftNote({ state }: Readonly<{ state: TradeState }>) {
  const { side, draft, busy, change, setup, symbol } = state;
  if (side !== "sell" || draft.unit === "token") return null;
  return <p className={tradeStyles.modeNote}>Saved USD draft. <Button variant="ghost" size="sm" type="button" disabled={busy} onClick={() => change({ ...setup.trade, sell: { typed: "", mode: "typed", unit: "token" } })}>Clear and enter {symbol}</Button></p>;
}

/**
 * The amount box's live line ("≈ 242.31 WAL"): what the amount gets, or the refusal or outage in
 * place of a figure. Fees, route, slippage and network are in Details and in
 * the review before signing; only a high price impact (the quote line's
 * warning tone) is said here, in words.
 */
function QuoteSummary({
  line,
  draft,
  facts,
  quote,
  hidden,
  wait,
}: Readonly<{
  line: ReturnType<typeof tradeQuoteLine>;
  draft: TradeDraft;
  facts: TradeFacts;
  quote: SocialTradeQuote | null;
  hidden: boolean;
  wait: QuoteWait;
}>) {
  const out = draft.side === "sell"
    ? { decimals: facts.counter?.decimals ?? facts.usdcDecimals, symbol: facts.counter?.symbol ?? "USDC" }
    : { decimals: facts.decimals, symbol: facts.symbol };
  const figure = compactFigure(quote?.amount_out, out.decimals);
  if (!quote && !line.impact) return <QuoteWaitMessage wait={wait} />;
  // No-break spaces keep the amount with its ticker; a ticker too long for the line breaks inside itself (audit F29).
  const receive = hidden ? "••••" : figure === null ? `${NO_VALUE}\u00a0${out.symbol}` : `≈\u00a0${figure}\u00a0${out.symbol}`;
  const impact = line.impact && line.impact.tone !== "plain" ? line.impact : null;
  return (
    <span className={tradeStyles.quote} aria-live="polite">
      <>
          <span className={tradeStyles.receive}>
            <span className="sr">Estimated receive </span><TickerText text={receive} symbols={hidden ? [] : [out.symbol]} />
          </span>
          {impact && (
            <span className={tradeStyles.alert} data-tone={impact.tone}>
              High price impact: {impact.text}
            </span>
          )}
      </>
    </span>
  );
}


function QuoteWaitMessage({ wait }: Readonly<{ wait: QuoteWait }>) {
  if (wait?.state === "pending") {
    return (
      <span className={tradeStyles.quote} role="status">
        <span className={tradeStyles.waiting}>Getting a quote…</span>
      </span>
    );
  }
  if (wait?.state === "unavailable") {
    return (
      <span className={tradeStyles.quote} role="alert">
        <span className={tradeStyles.alert}>
          {wait.reason ?? "Quote unavailable"}
        </span>
        <Button variant="ghost" size="xs" type="button" className={tradeStyles.quoteRetry} onClick={wait.retry}>
          Retry
        </Button>
      </span>
    );
  }
  return null;
}

type ExactTradeValue = (
  atoms: string | null,
  places: number,
  symbol: string,
  label: string,
) => React.ReactNode;
/** An exact amount in the shared inspector; `short` shows the tray's compact figure while the inspector keeps every place. */
function exactTradeValue(
  hidden: boolean,
  atoms: string | null,
  places: number,
  symbol: string,
  label: string,
  short = false,
) {
  if (atoms == null) return "Unavailable";
  if (hidden) return "••••";
  const parsed = exactAtoms(atoms, places);
  const text = `${parsed ? groupedExact(parsed, places) : atoms} ${symbol}`;
  const figure = short ? compactFigure(atoms, places) : null;
  if (short && (figure === null || `${figure} ${symbol}` === text)) return text;
  return (
    <InspectValue value={text} label={label}>
      {figure === null ? text : `${figure} ${symbol}`}
    </InspectValue>
  );
}
function CoinFeeConsent({
  fee,
  exact,
  busy,
  consent,
  onConsent,
}: Readonly<{
  fee: TradeFeeRequired | null | undefined;
  exact: ExactTradeValue;
  busy: boolean;
  consent: boolean;
  onConsent: (consent: boolean) => void;
}>) {
  if (!fee) return null;
  return (
    <>
      <p>Network fee estimate: {exact(fee.feeMist, 9, "SUI", "network fee")}</p>
      <label className={tradeStyles.consent}>
        <Checkbox

          checked={consent}
          disabled={fee.payable === false || busy}
          onChange={(event) => onConsent(event.currentTarget.checked)}
        />
        Pay the displayed network fee from my SUI
      </label>
    </>
  );
}

function CoinSubmit({
  ready,
  guest,
  busy,
  label,
  side,
  submit,
}: Readonly<{
  ready: boolean;
  guest: boolean;
  busy: boolean;
  label: string;
  side: "buy" | "sell";
  submit: () => void;
}>) {
  return (
    <Button variant="primary" size="lg"
      className={tradeStyles.cta}
      data-coin-submit=""
        aria-keyshortcuts="Shift+Space"
      data-guest={guest}
      type="button"
      disabled={!ready}
      loading={busy}
      loadingLabel={side === "buy" ? "Buying coin" : "Selling coin"}
      onClick={submit}
    >
      {label}
    </Button>
  );
}

/** The signed-in wallet's spendable balance for this side; a pending read is a skeleton, never "unavailable". */
function CoinAvailableBalance({side,facts,value,mark,loading}:Readonly<{side:"buy"|"sell";facts:TradeFacts;value:ExactTradeValue;mark:ReactNode;loading:boolean}>) {
  const amount=side === "buy" ? facts.counter ? facts.counter.balance : facts.usdc : facts.held;
  const decimals=side === "buy" ? facts.counter?.decimals ?? facts.usdcDecimals : facts.decimals;
  const symbol=side === "buy" ? facts.counter?.symbol ?? "USDC" : facts.symbol;
  const known=decimals !== null && amount !== null;
  return <span className={tradeStyles.avail} role="group" aria-label="Available trade balance" aria-busy={!known && loading}>
    {known ? <>Available{mark}<b>{value(amount.toString(),decimals,symbol,"available balance")}</b></> : loading ? <>Available<SkeletonText>000.00 {symbol}</SkeletonText></> : "Balance unavailable"}
  </span>;
}

function tokenDust(draft: TradeDraft, facts: TradeFacts) {
  return draft.side === "sell" && draft.unit === "token" && !isEmptyDraft(draft) && amountInAtoms(draft, facts) === 0n;
}

type TradeStatus = { text: string; alert?: boolean; pending?: boolean; fund?: boolean; retry?: () => void } | null;
type TradeState = ReturnType<typeof useCoinTrade>;

function tradeStatus(state: TradeState, unavailable: boolean): TradeStatus {
  const { authenticated, busy, walletRead, message, supportedNetwork, preference } = state;
  if (message) return { text: message };
  if (unavailable) return { text: "Trading waits for verified asset information." };
  if (!supportedNetwork) return { text: "Trading is unavailable on this network." };
  if (!authenticated || busy) return null;
  if (walletRead.status === "error") return { text: "Wallet balances could not load.", alert: true, retry: walletRead.reread };
  if (walletRead.status === "pending") return { text: "Loading wallet balance", pending: true };
  if (preference?.status === "error") return { text: "Your action preference could not load.", alert: true, retry: preference.retry };
  if (preference?.status !== "ready") return { text: "Loading action preference", pending: true };
  // The action's label already names a blocker; a status line under it would compete (audit Buy/Sell).
  if (tradeBlocker(state)) return null;
  return tradeDraftStatus(state) ?? tradePriceStatus(state) ?? tradeQuoteStatus(state);
}

function tradeDraftStatus({ draft, facts, symbol, side, decimals, walletRead }: TradeState): TradeStatus {
  if (side === "sell" && facts.held === null) return { text: `${symbol} balance is unavailable.`, retry: walletRead.reread };
  if (decimals === null) return { text: "Trading waits for verified asset details." };
  if (draft.mode === "typed" && draft.typed.trim() !== "" && (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(draft.typed.trim().replaceAll(",", "")) || !/[1-9]/.test(draft.typed))) return { text: "Enter an amount greater than zero." };
  if (tokenDust(draft, facts)) return { text: `This amount is below the smallest ${symbol} unit.` };
  if (overBalance(draft, facts)) return { text: `Not enough ${side === "sell" ? symbol : facts.counter?.symbol ?? "USDC"}.`, fund: side === "buy" };
  return null;
}

function tradePriceStatus({ draft, facts }: TradeState): TradeStatus {
  const payment = draft.side === "buy" ? facts.counter : facts;
  if (draft.mode !== "typed" || draft.unit === "token" || isEmptyDraft(draft) || payment?.price !== null) return null;
  return { text: `A fresh ${payment.symbol} USD price is unavailable. Choose ${draft.side === "sell" ? "a balance percentage" : "Max"} for an exact token amount.` };
}

function tradeQuoteStatus({ draft, cta, quoteLine, quote, quotes }: TradeState): TradeStatus {
  if (isEmptyDraft(draft)) return null;
  if (quote?.offer_refused === "insufficient_balance") return { text: cta.label, fund: true };
  if (cta.note) return { text: cta.note };
  // A failed quote already says so beside the amount, with Retry.
  if (quoteLine.notice && quotes.error === null) return { text: quoteLine.lead };
  return null;
}

type QuoteWait = Readonly<{ state: "pending" } | { state: "unavailable"; reason: string | null; retry: () => void }> | null;

/** Where the quote stands for a typed amount (audit 13/19): asked, or unavailable with a reason and Retry. Idle input says nothing. */
function quoteWait({ draft, quotes, late, request, quote, walletRead, retryQuote }: TradeState): QuoteWait {
  if (isEmptyDraft(draft) || request === null || quote !== null || walletRead.status !== "ready") return null;
  const retry = retryQuote;
  if (quotes.error) return { state: "unavailable", reason: quoteFailureReason(quotes.error.code ?? "error"), retry };
  if (late) return { state: "unavailable", reason: "No answer yet", retry };
  return { state: "pending" };
}

/** A refusal's published code in words, when it says something the person can act on. */
function quoteFailureReason(code: string) {
  if (code === "rate_limited") return "Too many requests";
  if (code === "pool_unavailable" || code === "no_route") return "No route available";
  if (code === "unauthorized" || code === "forbidden") return "Sign in again";
  return null;
}

/**
 * What stops a trade before any amount (audit Buy/Sell): it is the action's own label, directly under the coin
 * picker, in place of "Enter an amount", so one line names the limit instead of two competing ones.
 */
function tradeBlocker({ facts, symbol, side }: TradeState): string | null {
  if (side === "sell" && facts.held === 0n) return `No ${symbol} to sell`;
  if (facts.counter?.coinType === facts.coinType) return `Choose another ${side === "buy" ? "payment" : "receive"} coin`;
  return null;
}

/** The disabled action states what it needs, in place, without changing the form's height (audit 20). */
function submitPrerequisite(state: TradeState, unavailable: boolean): string | null {
  const { ready, draft, cta, symbol, side, busy } = state;
  if (ready || busy || unavailable) return null;
  const blocker = tradeBlocker(state);
  if (blocker) return blocker;
  if (isEmptyDraft(draft)) return "Enter an amount";
  if (cta.label !== `${side === "sell" ? "Sell" : "Buy"} ${symbol}`) return cta.label;
  const wait = quoteWait(state);
  if (wait?.state === "unavailable") return "Quote unavailable";
  if (wait?.state === "pending") return "Getting a quote…";
  return null;
}
