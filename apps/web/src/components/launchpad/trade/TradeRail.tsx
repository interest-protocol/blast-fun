"use client";

import { TransactionLink } from "#web/components/blast-ui/TransactionLink.tsx";

import clsx from "clsx";
import { useId, useState, useSyncExternalStore, type ReactNode } from "react";

import { AmountFit } from "#web/components/blast-ui/AmountFit.tsx";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { compactTradeText, tradePresetAmount } from "./trade-display.ts";
import { Collapse } from "#web/components/blast-ui/Collapse.tsx";
import { Button, ButtonLink, DisclosureButton } from "#web/components/blast-ui/Button.tsx";
import { DexIdentity } from "#web/components/blast-ui/DexIdentity.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { Segmented } from "#web/components/blast-ui/Segmented.tsx";
import { SheetDock } from "#web/components/blast-ui/Sheet.tsx";
import { usePhoneLayout } from "#web/components/blast-ui/use-shell-prefs.ts";
import {
  SkeletonBox,
  SkeletonRegion,
} from "#web/components/blast-ui/Skeleton.tsx";
import { TextField, FieldGroup } from "#web/components/blast-ui/TextField.tsx";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { coinDisplay } from "#web/components/social/coins/coin-display.ts";

import type { ActionState } from "../transaction/action-machine";
import type { ActionController } from "../transaction/controller";
import { useLaunchpadSigners } from "../transaction/LaunchpadSignerProvider";
import { AmountPresets } from "#web/components/social/coins/AmountPresets.tsx";
import { ratioText } from "#web/components/social/coins/swap-model.ts";
import { amtExact } from "@blast/core/web/exact-amount.ts";
import swapStyles from "#web/components/social/coins/coins.module.css";
import { AMOUNT_REFUSALS, parseFormattedAtomic, parseTradeAmount } from "./amount";
import type { TradeDirection } from "./curve-adapter";
import { unresolvedTrade } from "./curve-trade-provider-model";
import type { IndicativeEstimate } from "./curve-trade-rail-model";
import type { QuoteAsset } from "./quote-asset";
import { useCoinTradeWallet } from "./CoinTradeSignerProvider";
import { useSignInGate } from "#web/components/social/SignInGate.tsx";
import type { WalletCoinBalance } from "#web/components/social/coins/use-wallet-coin-balance.ts";
import styles from "./coin-trade.module.css";
import type { MigratorVenue } from "@blast/core/modules/launchpad-contract/venues.ts";
import { atomsGrouped } from "@blast/core/web/format.ts";
import { bpsPercent } from "@blast/core/lib/bps.ts";
import { NO_VALUE } from "@blast/core/lib/format.ts";

const SLIPPAGE_LABEL = "Slippage tolerance";

type TradeInput = Readonly<{
  amount: string;
  slippageBps: bigint;
  direction: TradeDirection;
  minimumOut?: bigint;
}>;
type Asset = Readonly<{ symbol: string; decimals: number; quote: QuoteAsset }>;
type Session<Input> = Readonly<{
  controllers: Readonly<Record<TradeDirection, ActionController<Input>>>;
  direction: TradeDirection;
  setDirection(direction: TradeDirection): void;
  balances: Readonly<{ quote: bigint; meme: bigint }> | null;
  balancesPending?: boolean;
  refresh(): void;
}>;
type StateProps<Input extends TradeInput> = Readonly<{
  state: ActionState<Input>;
  controller: ActionController<Input>;
  asset: Asset | null;
  canReview: boolean;
  minimumOut?: bigint;
  refresh(): void;
  blockedByOther: boolean;
  verb: string;
  label?: string;
  sellHint?: string;
  receipt(digest: string): ReactNode;
  venue?: MigratorVenue;
}>;

function QuoteMark({ quote }: Readonly<{ quote: QuoteAsset }>) {
  const symbol = coinDisplay(quote.coinType, quote.symbol, quote.symbol).symbol;
  const key =
    quote.symbol === "SUI"
      ? "sui"
      : quote.symbol === "USDC"
        ? "usdc"
        : quote.coinType;
  return (
    <span
      title={quote.symbol}
      role="img"
      aria-label={quote.symbol}
      className={styles.quoteMark}
    >
      <CoinMark
        coin={{
          key,
          coinType: quote.coinType,
          round: true,
          symbol,
          iconUrl: quote.iconUrl,
        }}
        size={18}
      />
      {symbol}
    </span>
  );
}

/** Replace amount units only: a quote symbol inside a meme name is not a quote. */
function quoteUnitPosition(text: string, asset: Asset | null): number {
  if (!asset || asset.symbol === asset.quote.symbol) return -1;
  let position = text.indexOf(asset.quote.symbol);
  while (position >= 0) {
    const before = text.slice(0, position);
    const after = text.slice(position + asset.quote.symbol.length);
    if (/(?:^|\s)[\d.,₀-₉]+\s+$/.test(before) && /^(?:$|[\s,;)])/.test(after))
      return position;
    position = text.indexOf(
      asset.quote.symbol,
      position + asset.quote.symbol.length,
    );
  }
  return -1;
}

function QuoteText({
  text,
  asset,
}: Readonly<{ text: string; asset: Asset | null }>): ReactNode {
  const position = quoteUnitPosition(text, asset);
  if (!asset || position < 0) return <span>{text}</span>;
  const before = text.slice(0, position);
  const amount = before.match(/[\d.,₀-₉]+\u00a0$/)?.[0] ?? "";
  const mark = <QuoteMark quote={asset.quote} />;
  return (
    <span>
      {before.slice(0, before.length - amount.length)}
      {amount ? <span className={styles.quoteAmount}>{amount}{mark}</span> : mark}
      <QuoteText
        text={text.slice(position + asset.quote.symbol.length)}
        asset={asset}
      />
    </span>
  );
}

function amountView<Input extends TradeInput>(
  session: Session<Input>,
  state: ActionState<Input>,
  asset: Asset | null,
  payBalance?: WalletCoinBalance,
) {
  const buying = session.direction === "buy";
  const decimals = asset
    ? buying
      ? asset.quote.decimals
      : asset.decimals
    : null;
  const parsed =
    decimals === null ? null : parseTradeAmount(state.input.amount, decimals);
  const error =
    state.input.amount.trim() && parsed && !parsed.ok
      ? AMOUNT_REFUSALS[parsed.reason]
      : null;
  const payment = buying ? payBalance : undefined;
  const directBalance = buying ? session.balances?.quote : session.balances?.meme;
  const balance = payment === undefined ? directBalance ?? null : payment.status === "ready" ? payment.atoms : null;
  const displayedBalance = balanceDisplay(balance, decimals);
  const balancesPending = payment === undefined ? session.balancesPending : payment.status === "loading";
  const retryBalance = payment?.status === "unavailable" ? payment.retry : null;
  const editable = [
    "editing",
    "review",
    "blocked",
    "failed",
    "rejected",
    "succeeded",
  ].includes(state.phase);
  return { buying, error, balance, decimals, ...displayedBalance, balancesPending, retryBalance, editable, valid: parsed?.ok === true };
}

function balanceDisplay(balance: bigint | null, decimals: number | null) {
  if (balance === null || decimals === null) return { balanceText: null, balanceShort: null };
  return { balanceText: atomsGrouped(balance, decimals), balanceShort: amtExact({ n: balance, scale: decimals }) };
}

export function TradeRail<Input extends TradeInput>({
  session,
  asset,
  ready,
  reading,
  problem,
  venue,
  price,
  estimate,
  receipt,
  paymentControl, paymentNote, payAsset, paymentReady = true, payBalance,
}: Readonly<{
  paymentControl?: ReactNode; paymentNote?: ReactNode; payAsset?: Asset | null; paymentReady?: boolean; payBalance?: WalletCoinBalance;
  session: Session<Input>;
  asset: Asset | null;
  ready: boolean;
  reading: boolean;
  problem: string | null;
  venue?: MigratorVenue;
  price?: string | null;
  estimate?: (
    input: Input,
    direction: TradeDirection,
  ) => IndicativeEstimate | null;
  receipt(digest: string): ReactNode;
}>) {
  const id = useId();
  const buy = useSyncExternalStore(
    session.controllers.buy.subscribe,
    session.controllers.buy.getState,
    session.controllers.buy.getState,
  );
  const sell = useSyncExternalStore(
    session.controllers.sell.subscribe,
    session.controllers.sell.getState,
    session.controllers.sell.getState,
  );
  const { direction } = session;
  const state = { buy, sell }[direction];
  const controller = session.controllers[direction];
  const unresolved = unresolvedTrade({ buy, sell });
  const blockedByOther =
    unresolved !== null && unresolved.direction !== direction;
  const amountAsset = direction === "buy" ? payAsset ?? asset : asset;
  const amount = amountView(session, state, amountAsset, payBalance);
  const compactSell = usePhoneLayout() && direction === "sell";
  const dockedSell = compactSell && dockTradePhase(state.phase);
  const preview = estimate?.(state.input, direction);
  const shownEstimate = reviewedEstimate(state, venue) ?? preview;
  const received = receiveAmount(shownEstimate, asset, direction);
  const actionLabel = curveLabel(direction, state.input.amount, asset, received);
  const presets = <TradeAmountPresets ready={ready} amount={amount} state={state} controller={controller} />;
  const rate = curveRate(state.input.amount, amountAsset, asset, direction, received);
  const hasQuote = Boolean(venue) || preview?.minimumAtomic !== undefined;
  const canReview = canReviewTrade(ready, paymentReady, amount.valid, unresolved === null, hasQuote);
  const payment = paymentNotes(paymentReady, paymentNote);
  const action = <TradeAction
    state={state}
    controller={controller}
    asset={asset}
    canReview={canReview}
    minimumOut={preview?.minimumAtomic}
    refresh={session.refresh}
    blockedByOther={blockedByOther}
    verb={{ buy: "Buy", sell: "Sell" }[direction]}
    label={actionLabel}
    receipt={receipt}
    venue={venue}
    sellHint={compactSell ? sellEntryHint({ amount, ready, reading, paymentReady, hasQuote, unresolved: unresolved !== null }) : undefined}
  />;
  return (
    <div className={clsx(styles.rail, swapStyles.swapDialog)} data-coin-trade={venue ?? "blast_curve"} data-compact-sell={compactSell || undefined} data-sell-dock={dockedSell || undefined}>
      <Segmented
        label="Trade direction"
        options={[
          ["buy", "Buy"],
          ["sell", "Sell"],
        ]}
        value={direction}
        onChange={session.setDirection}
        tabs
        stretch
        tabId={(key) => `${id}-${key}`}
        panelId={(key) => `${id}-${key}-panel`}
      />
      <RouteStatus
        venue={venue}
        reading={reading}
        problem={problem}
        refresh={session.refresh}
      />
      <div
        id={`${id}-${direction}-panel`}
        role="tabpanel"
        aria-labelledby={`${id}-${direction}`}
        className={swapStyles.tradeBody}
      >
        <TradeAmount
          id={id}
          state={state}
          asset={amountAsset}
          amount={amount}
          ready={ready}
          controller={controller}
          paymentControl={paymentControl}
          receiveAsset={asset}
          received={received}
          presets={compactSell ? presets : null}
          compactSell={compactSell}
        />
        <TradeOptions
          compactSell={compactSell}
          direction={direction}
          venue={venue}
          estimate={{ preview: shownEstimate, price, rate, asset, paymentNote: payment.details }}
          bps={state.input.slippageBps}
          disabled={!amount.editable}
          setSlippage={(slippageBps) => controller.edit({ ...state.input, slippageBps })}
          presets={presets}
        />
        {payment.notice}
        <TradeFooter blockedDirection={blockedByOther ? unresolved.direction : undefined} docked={dockedSell}>
          {action}
        </TradeFooter>
      </div>
    </div>
  );
}

function canReviewTrade(ready: boolean, paymentReady: boolean, validAmount: boolean, tradeSettled: boolean, hasQuote: boolean) {
  return ready && paymentReady && validAmount && tradeSettled && hasQuote;
}

function TradeFooter({ blockedDirection, docked, children }: Readonly<{
  blockedDirection?: TradeDirection; docked: boolean; children: ReactNode;
}>) {
  return <>
    {blockedDirection ? <p role="status" className={styles.note}>
      A {blockedDirection} is unresolved. Open that tab and check its transaction before trading again.
    </p> : null}
    {docked ? <SheetDock>{children}</SheetDock> : children}
  </>;
}

function TradeOptions({ compactSell, direction, venue, estimate, bps, disabled, setSlippage, presets }: Readonly<{
  compactSell: boolean;
  direction: TradeDirection;
  venue?: MigratorVenue;
  estimate: EstimateProps;
  bps: bigint;
  disabled: boolean;
  setSlippage(bps: bigint): void;
  presets: ReactNode;
}>) {
  const slippage = <SlippageChoices bps={bps} disabled={disabled} onChange={setSlippage} />;
  if (compactSell) return <SellQuote {...estimate} bps={bps} slippage={slippage} />;
  return <>
    {presets}
    <span aria-hidden="true" className={styles.label}>{SLIPPAGE_LABEL}</span>
    {slippage}
    <TradeEstimate {...estimate} />
    <CurveSellNote direction={direction} venue={venue} asset={estimate.asset} />
  </>;
}

function dockTradePhase(phase: ActionState<unknown>["phase"]) {
  return phase !== "review" && phase !== "choosing-signer";
}

function paymentNotes(ready: boolean, note: ReactNode) {
  return ready ? { details: note, notice: null } : { details: null, notice: note };
}

function SlippageChoices({ bps, disabled, onChange }: Readonly<{ bps: bigint; disabled: boolean; onChange: (bps: bigint) => void }>) {
  return <Segmented
    label={SLIPPAGE_LABEL}
    size="sm"
    options={[["50", "0.5%"], ["100", "1%"], ["200", "2%"]]}
    value={String(bps)}
    onChange={(value) => onChange(BigInt(value))}
    disabled={disabled}
    stretch
  />;
}

function sellEntryHint({ amount, ready, reading, paymentReady, hasQuote, unresolved }: Readonly<{
  amount: ReturnType<typeof amountView>; ready: boolean; reading: boolean; paymentReady: boolean; hasQuote: boolean; unresolved: boolean;
}>) {
  if (unresolved || !paymentReady) return "";
  if (!ready) return reading ? "Checking the trading route…" : "Trading is unavailable.";
  if (amount.error) return "";
  if (!amount.valid) return "Enter an amount to see your quote.";
  return hasQuote ? "" : "A quote is unavailable for this amount.";
}

function RouteStatus({
  venue,
  reading,
  problem,
  refresh,
}: Readonly<{
  venue?: MigratorVenue;
  reading: boolean;
  problem: string | null;
  refresh(): void;
}>) {
  return (
    <>
      {venue ? (
        <div className={styles.venue}>
          <DexIdentity venue={venue} iconOnly size={20} />
          <span>Recorded graduation pool</span>
        </div>
      ) : null}
      {reading ? (
        <SkeletonRegion label="Reading trading route">
          <SkeletonBox className={styles.skeleton} />
        </SkeletonRegion>
      ) : null}
      {problem ? (
        <EmptyState
          title="Trading couldn't load"
          role="alert"
          action={<Button onClick={refresh}>Try again</Button>}
        >
          {problem}
        </EmptyState>
      ) : null}
    </>
  );
}

function CurveSellNote({ direction, venue, asset }: Readonly<{ direction: TradeDirection; venue?: MigratorVenue; asset: Asset | null }>) {
  if (direction !== "sell" || venue || !asset) return null;
  return <p className={styles.note}>Curve sells receive {asset.quote.symbol} only.</p>;
}

function AmountUnit({
  asset,
  buying,
}: Readonly<{ asset: Asset | null; buying: boolean }>) {
  if (!asset) return null;
  return buying ? (
    <QuoteMark quote={asset.quote} />
  ) : (
    <span className={styles.symbol}>{asset.symbol}</span>
  );
}

function TradeAmount<Input extends TradeInput>({
  id, state, asset, amount, ready, controller, paymentControl, receiveAsset, received, presets, compactSell,
}: Readonly<{
  id: string;
  state: ActionState<Input>;
  asset: Asset | null;
  amount: ReturnType<typeof amountView>;
  ready: boolean;
  controller: ActionController<Input>;
  paymentControl?: ReactNode;
  receiveAsset: Asset | null;
  received: bigint | null;
  presets: ReactNode;
  compactSell: boolean;
}>) {
  return (
    <div className={swapStyles.swapPair}>
      <FieldGroup variant="amount" className={clsx(swapStyles.amt, compactSell && styles.sellInput)}>
        <div className={swapStyles.amtTop}>
          <label htmlFor={`${id}-amount`}>{amount.buying ? "You pay" : "You sell"}</label>
          <span id={`${id}-help`} className={amount.error ? styles.error : undefined}><AmountHelp amount={amount} asset={asset} compactSell={compactSell} /></span>
        </div>
        <div className={swapStyles.amtRow}>
          <AmountFit value={state.input.amount}>
            <TextField
              id={`${id}-amount`}
              value={state.input.amount}
              placeholder="0"
              inputMode="decimal"
              autoComplete="off"
              disabled={!amount.editable || !ready}
              aria-invalid={Boolean(amount.error)}
              aria-describedby={`${id}-help`}
              onChange={(event) => controller.edit({ ...state.input, amount: event.target.value })}
            />
          </AmountFit>
          {paymentControl ?? <AmountUnit asset={asset} buying={amount.buying} />}
        </div>
      </FieldGroup>
      {presets}
      <TradeReceive asset={receiveAsset} received={received} buying={amount.buying} compactSell={compactSell} />
    </div>
  );
}

function receiveLabel(asset: Asset | null, buying: boolean, compactSell: boolean) {
  if (compactSell) return "Estimated receive";
  if (!buying && asset) return `Receive ${asset.quote.symbol}`;
  return "You get";
}

function TradeReceive({ asset, received, buying, compactSell }: Readonly<{
  asset: Asset | null; received: bigint | null; buying: boolean; compactSell: boolean;
}>) {
  const decimals = (buying ? asset?.decimals : asset?.quote.decimals) ?? 0;
  const empty = compactSell ? NO_VALUE : "0";
  const receivedText = received === null ? empty : amtExact({ n: received, scale: decimals });
  const exact = received === null ? undefined : atomsGrouped(received, decimals);
  return (
    <div className={clsx(swapStyles.amt, swapStyles.amtOut, compactSell && styles.sellReceive)} aria-live="polite">
      <div className={swapStyles.amtTop}><span className={swapStyles.lbl}>{receiveLabel(asset, buying, compactSell)}</span></div>
      <div className={swapStyles.amtRow}>
        <AmountFit value={receivedText}>
          <b className={clsx(swapStyles.amtVal, "num", compactSell && styles.sellReceiveValue, exact === undefined && swapStyles.zero)}>
            {exact === undefined ? receivedText : <InspectValue label="receive amount" value={exact}>{receivedText}</InspectValue>}
          </b>
        </AmountFit>
        <AmountUnit asset={asset} buying={!buying} />
      </div>
    </div>
  );
}

function TradeAmountPresets<Input extends TradeInput>({ ready, amount, state, controller }: Readonly<{
  ready: boolean;
  amount: ReturnType<typeof amountView>;
  state: ActionState<Input>;
  controller: ActionController<Input>;
}>) {
  return <AmountPresets disabled={!ready || !amount.editable || amount.balance === null} onPick={(preset) => {
    if (amount.balance === null || amount.decimals === null) return;
    controller.edit({ ...state.input, amount: tradePresetAmount(preset, amount.balance, amount.decimals) });
  }} />;
}

function AmountHelp({ amount, asset, compactSell }: Readonly<{
  amount: ReturnType<typeof amountView>; asset: Asset | null; compactSell: boolean;
}>) {
  const wallet = useCoinTradeWallet();
  if (amount.error) return amount.error;
  if (amount.balanceText === null) return <>
    {missingBalanceHelp(wallet, amount.balancesPending)}
    {amount.retryBalance && <> <Button variant="ghost" size="xs" onClick={amount.retryBalance}>Retry balance</Button></>}
  </>;

  const ticker = amount.buying ? asset?.quote.symbol : asset?.symbol;
  const exact = [amount.balanceText, ticker].filter(Boolean).join(" ");
  const displayTicker = amount.buying && asset ? coinDisplay(asset.quote.coinType, asset.quote.symbol, asset.quote.symbol).symbol : ticker;
  const displayed = [amount.balanceShort, displayTicker].filter(Boolean).join("\u00a0");
  return <span className={compactSell ? styles.sellBalance : undefined}>
    Balance: <InspectValue label="balance" value={exact}>{displayed}</InspectValue>
  </span>;
}

function missingBalanceHelp(wallet: ReturnType<typeof useCoinTradeWallet>, balancesPending?: boolean) {
  if (wallet?.pending || balancesPending) return <SkeletonRegion inline label="Reading your wallet"><SkeletonBox /></SkeletonRegion>;
  if (wallet?.problem) return wallet.problem;
  if (wallet?.identity) return "Your wallet is connected. Balance is unavailable.";
  return wallet ? "Sign in to review" : "Connect a wallet to review";
}

function reviewedEstimate<Input>(state: ActionState<Input>, venue?: string): IndicativeEstimate | null {
  if (venue || state.phase !== "review") return null;
  const facts = Object.fromEntries(state.review.facts.map((fact) => [fact.key, fact.value]));
  return {
    receive: facts["meme-out"] ?? facts["quote-out"] ?? "Unavailable",
    minimum: facts["minimum-out"] ?? "Unavailable",
    detail: facts.fees,
    refund: facts.refund,
    burn: facts.burn,
  };
}

/** Display-only parsing of the SDK estimate or fresh review's already formatted amount. */
function receiveAmount(preview: IndicativeEstimate | null | undefined, asset: Asset | null, direction: TradeDirection): bigint | null {
  if (!preview || !asset) return null;
  const symbol = direction === "buy" ? asset.symbol : asset.quote.symbol;
  if (!preview.receive.endsWith(` ${symbol}`)) return null;
  return parseFormattedAtomic(preview.receive.slice(0, -(symbol.length + 1)), direction === "buy" ? asset.decimals : asset.quote.decimals);
}

function curveLabel(direction: TradeDirection, input: string, asset: Asset | null, received: bigint | null): string {
  const verb = direction === "buy" ? "Buy" : "Sell";
  if (!asset) return verb;
  const sold = parseTradeAmount(input, asset.decimals);
  const atoms = direction === "buy" ? received : sold.ok ? sold.atomic : null;
  return `${verb} ${atoms === null ? "" : `${amtExact({ n: atoms, scale: asset.decimals })} `}${asset.symbol}`;
}

function curveRate(input: string, payment: Asset | null, asset: Asset | null, direction: TradeDirection, received: bigint | null): string | null {
  if (!payment || !asset || received === null) return null;
  const buying = direction === "buy";
  const given = parseTradeAmount(input, buying ? payment.quote.decimals : asset.decimals);
  if (!given.ok) return null;
  const rate = ratioText(received * 10n ** BigInt(buying ? payment.quote.decimals : asset.decimals), given.atomic * 10n ** BigInt(buying ? asset.decimals : asset.quote.decimals));
  return `1 ${buying ? payment.quote.symbol : asset.symbol} = ${rate} ${buying ? asset.symbol : asset.quote.symbol}`;
}

type EstimateProps = Readonly<{
  preview?: IndicativeEstimate | null;
  price?: string | null;
  asset: Asset | null;
  paymentNote?: ReactNode;
  rate: string | null;
}>;

function TradeEstimate({ preview, price, asset, paymentNote, rate }: EstimateProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className={swapStyles.tx}>
      <DisclosureButton aria-label="Trade details" aria-controls={id} aria-expanded={open} className={swapStyles.txSum} onClick={() => setOpen(!open)} variant="ghost">
        <span className="num"><QuoteText text={rate ?? price ?? "Trade details"} asset={asset} /></span>
      </DisclosureButton>
      <Collapse id={id} open={open}>
        <div className={swapStyles.txDetailSpace}>
          <QuoteFacts preview={preview} asset={asset} className={clsx(swapStyles.terms, swapStyles.txDet)} compact />
          {paymentNote}
        </div>
      </Collapse>
    </div>
  );
}

function SellQuote({ preview, price, rate, asset, paymentNote, bps, slippage }: EstimateProps & Readonly<{
  bps: bigint;
  slippage: ReactNode;
}>) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const displayRate = rate ?? price;
  return <div className={styles.sellQuote}>
    <QuoteFacts preview={preview} asset={asset} className={styles.facts} />
    <DisclosureButton aria-controls={id} aria-expanded={open} className={styles.sellSettings} onClick={() => setOpen(!open)} variant="ghost">
      <span>Trade settings</span><span>{bpsPercent(bps)} slippage</span>
    </DisclosureButton>
    <Collapse id={id} open={open}>
      <div className={styles.sellSettingsPanel}>
        <span aria-hidden="true" className={styles.label}>{SLIPPAGE_LABEL}</span>
        {slippage}
        {displayRate ? <p className={styles.note}><QuoteText text={displayRate} asset={asset} /></p> : null}
        {paymentNote}
      </div>
    </Collapse>
  </div>;
}

function QuoteFacts({ preview, asset, className, compact }: Readonly<{
  preview?: IndicativeEstimate | null; asset: Asset | null; className: string; compact?: boolean;
}>) {
  if (!preview) return null;
  const facts = [
    ["Minimum receive", preview.minimum],
    [compact ? "Fee" : "Trade fee", preview.detail ?? (compact ? undefined : null)],
    ["Refund", preview.refund],
    ["Burned", preview.burn],
  ] as const;
  return <dl className={className} aria-label="Estimated trade">
    {facts.map(([label, value]) => value !== undefined && <Fact key={label} label={label}>
      {value === null ? "None" : <InspectValue label={label.toLowerCase()} value={value}>
        <QuoteText text={compact ? compactTradeText(value, asset) : value} asset={asset} />
      </InspectValue>}
    </Fact>)}
  </dl>;
}

function Fact({
  label,
  children,
}: Readonly<{ label: ReactNode; children: ReactNode }>) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

const PENDING_LABELS = {
  connecting: "Connecting wallet",
  preflighting: "Checking trade and simulation",
  signing: "Waiting for wallet signature",
  reconciling: "Confirming trade",
};

function TradeAction<Input extends TradeInput>(props: StateProps<Input>) {
  const { state, controller } = props;
  if (!props.venue) return <CurveTradeAction {...props} />;
  switch (state.phase) {
    case "connecting":
    case "preflighting":
    case "signing":
    case "reconciling":
      return (
        <Button
          variant="primary"
          size="lg"
          loading
          loadingLabel={PENDING_LABELS[state.phase]}
        >
          {props.verb}
          {props.asset ? ` ${props.asset.symbol}` : ""}
        </Button>
      );
    case "choosing-signer":
      return <SignerChoice controller={controller} />;
    case "review":
      return <TradeReview {...props} state={state} />;
    case "ambiguous":
      return (
        <div className={styles.actions}>
          <p role="alert" className={styles.note}>
            {state.message}
          </p>
          <p className={styles.digest}>{state.digest}</p>
          <Button size="lg" onClick={controller.recheck}>
            Check transaction
          </Button>
        </div>
      );
    case "succeeded":
      return <TradeReceipt {...props} state={state} />;
    default:
      return <TradeEntry {...props} state={state} />;
  }
}

/** Keep the purchase form and its action in place throughout a curve trade. */
function CurveTradeAction<Input extends TradeInput>(props: StateProps<Input>) {
  return (
    <div className={clsx(styles.actions, styles.curveActions)}>
      <CurveTradeFeedback {...props} />
      <CurveTradeButton {...props} />
    </div>
  );
}

function CurveTradeButton<Input extends TradeInput>(props: StateProps<Input>) {
  const { state, controller, verb } = props;
  switch (state.phase) {
    case "connecting":
    case "preflighting":
    case "signing":
    case "reconciling":
      return (
        <Button
          variant="primary"
          size="lg"
          loading
          loadingLabel={PENDING_LABELS[state.phase]}
          data-trade=""
        >
          {props.label ?? tradeLabel(verb, props.asset)}
        </Button>
      );
    case "choosing-signer":
      return <SignerChoice controller={controller} />;
    case "ambiguous":
      return (
        <Button size="lg" onClick={controller.recheck}>
          Check transaction
        </Button>
      );
    case "blocked":
      return (
        <Button
          size="lg"
          onClick={() => {
            controller.cancel();
            props.refresh();
          }}
        >
          Refresh quote
        </Button>
      );
    case "review":
      return (
        <>
          <Button
            data-trade=""
            variant="primary"
            size="lg"
            disabled={!props.canReview || props.blockedByOther}
            onClick={() => controller.approve(state.review.id)}
          >
            {props.label ?? tradeLabel(verb, props.asset)}
          </Button>
          <Button variant="ghost" onClick={controller.cancel}>
            Cancel
          </Button>
        </>
      );
    default:
      return <TradeEntry {...props} />;
  }
}

function CurveTradeFeedback<Input extends TradeInput>({
  state,
  verb,
}: StateProps<Input>) {
  const confirmed = state.phase === "succeeded";
  return (
    <div className={styles.feedback} aria-live="polite" aria-atomic="true">
      {confirmed ? (
        <>
          <p className={styles.note}>{verb} confirmed.</p>
          {state.explorerUrl ? (
            <TransactionLink href={state.explorerUrl} />
          ) : null}
        </>
      ) : state.phase === "ambiguous" ? (
        <p role="alert" className={styles.note}>
          {state.message} <span className={styles.digest}>{state.digest}</span>
        </p>
      ) : state.phase === "review" ? (
        <p className={styles.note}>
          Check the updated trade before confirming.
        </p>
      ) : entryMessage(state) ? (
        <p role="alert" className={styles.note}>
          {entryMessage(state)}
        </p>
      ) : null}
    </div>
  );
}

function SignerChoice<Input>({
  controller,
}: Readonly<{ controller: ActionController<Input> }>) {
  const signers = useLaunchpadSigners();
  return (
    <div className={styles.actions}>
      {signers.kinds.map((kind) => (
        <Button
          key={kind}
          size="lg"
          onClick={() => controller.chooseSigner(kind)}
        >
          {kind === "privy"
            ? "Continue with Blast wallet"
            : "Connect Sui wallet"}
        </Button>
      ))}
      <Button variant="ghost" onClick={controller.cancel}>
        Cancel
      </Button>
    </div>
  );
}

function reviewFactText(
  key: string,
  value: string,
  asset: Asset | null,
  verb: string,
): string {
  if (key === "trade" && asset) return `${verb} ${asset.symbol}`;
  if (key === "fee")
    return value.replace(/\b(Cetus|Bluefin) pool fee/, "pool fee");
  return value;
}

function TradeReview<Input extends TradeInput>({
  state,
  controller,
  asset,
  blockedByOther,
  canReview,
  verb,
  venue,
}: StateProps<Input> & {
  state: Extract<ActionState<Input>, { phase: "review" }>;
}) {
  return (
    <div className={styles.review}>
      <h3>Review {verb.toLowerCase()}</h3>
      {state.changes.length ? (
        <p role="alert" className={styles.note}>
          The trade changed. Check the updated values before confirming.
        </p>
      ) : null}
      <dl className={styles.facts}>
        {state.review.facts.map((fact) => (
          <Fact
            key={fact.key}
            label={
              fact.key === "balance-quote" ? "Your quote balance" : fact.label
            }
          >
            {fact.key === "venue" && venue ? (
              <>
                <DexIdentity venue={venue} iconOnly size={20} />{" "}
                {fact.value.slice(fact.value.indexOf("pool ") + 5)}
              </>
            ) : (
              <QuoteText
                text={reviewFactText(fact.key, fact.value, asset, verb)}
                asset={asset}
              />
            )}
          </Fact>
        ))}
      </dl>
      <Button
        variant="primary"
        size="lg"
        disabled={!canReview || blockedByOther}
        onClick={() => controller.approve(state.review.id)}
      >
        {verb} and sign
      </Button>
      <Button variant="ghost" onClick={controller.cancel}>
        Cancel
      </Button>
    </div>
  );
}

function TradeReceipt<Input extends TradeInput>({
  state,
  controller,
  receipt,
}: StateProps<Input> & {
  state: Extract<ActionState<Input>, { phase: "succeeded" }>;
}) {
  return (
    <div className={styles.actions}>
      <div className={styles.feedback}>
        <p className={styles.receiptDetails} role="status">
          {receipt(state.digest) ?? "Trade confirmed. Transaction details are still loading."}
        </p>
        {state.explorerUrl ? <TransactionLink href={state.explorerUrl} /> : null}
      </div>
      <Button size="lg" onClick={controller.acknowledge}>
        Trade again
      </Button>
    </div>
  );
}

function entryMessage<Input>(state: ActionState<Input>): string | undefined {
  if (state.phase === "blocked") return state.block.message;
  if (state.phase === "failed" || state.phase === "rejected")
    return state.message;
  return state.phase === "editing" ? state.notice?.message : undefined;
}

function tradeLabel(verb: string, asset: Asset | null): string {
  return asset ? `${verb} ${asset.symbol}` : verb;
}

function submitTrade<Input extends TradeInput>(props: Pick<StateProps<Input>, "controller" | "state" | "minimumOut" | "venue">) {
  if (!props.venue) props.controller.edit({ ...props.state.input, minimumOut: props.minimumOut });
  props.controller.submit({ confirmInWallet: !props.venue });
}

function TradeEntry<Input extends TradeInput>({
  state,
  controller,
  asset,
  canReview,
  verb,
  venue,
  minimumOut,
  label,
  sellHint,
}: StateProps<Input>) {
  const wallet = useCoinTradeWallet();
  const gate = useSignInGate();
  const hintId = useId();
  const message = venue ? entryMessage(state) : undefined;
  const disabled = !canReview || Boolean(wallet && (wallet.pending || !wallet.identity));
  const hint = disabled && !entryMessage(state) ? walletSellHint(wallet, sellHint) : undefined;
  const buttonLabel = tradeEntryLabel({ disabled, compactSell: sellHint !== undefined, verb, venue, label, asset });
  const submit = () => submitTrade({ controller, state, minimumOut, venue });
  const action = walletEntryAction(wallet, gate) ?? (
    <>
      {hint ? <p id={hintId} className={styles.note} role="status">{hint}</p> : null}
      <Button data-trade="" variant="primary" size="lg" aria-describedby={hint ? hintId : undefined} disabled={disabled} onClick={submit}>{buttonLabel}</Button>
    </>
  );
  return (
    <div className={styles.actions}>
      {message ? (
        <p role="alert" className={styles.note}>
          <QuoteText text={message} asset={asset} />
        </p>
      ) : null}
      {action}
    </div>
  );
}

function walletEntryAction(wallet: ReturnType<typeof useCoinTradeWallet>, gate: ReturnType<typeof useSignInGate>) {
  if (wallet && !wallet.signedIn) return <ButtonLink variant="primary" size="lg" href={gate.signInHref} onClick={gate.openSignIn}>Sign in to trade</ButtonLink>;
  if (wallet?.problem) return <Button size="lg" onClick={wallet.retry}>Try again</Button>;
  return null;
}

function walletSellHint(wallet: ReturnType<typeof useCoinTradeWallet>, hint?: string) {
  if (hint === undefined) return undefined;
  if (wallet?.pending) return "Checking your wallet…";
  if (wallet && !wallet.identity) return "Connect a wallet to sell.";
  return hint;
}

function tradeEntryLabel({ disabled, compactSell, verb, venue, label, asset }: Readonly<{
  disabled: boolean; compactSell: boolean; verb: string; venue?: MigratorVenue; label?: string; asset: Asset | null;
}>) {
  if (compactSell && disabled) return verb;
  if (venue) return `Review ${verb.toLowerCase()}`;
  return label ?? tradeLabel(verb, asset);
}
