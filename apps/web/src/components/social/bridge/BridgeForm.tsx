"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { track } from "@vercel/analytics";
import clsx from "clsx";
import { useCallback, useId, useRef, useState, type ReactNode } from "react";

import type { Quote } from "@mayanfinance/swap-sdk";

import { AmountFit } from "#web/components/blast-ui/AmountFit.tsx";
import { BlastMenu, BlastMenuRadioGroup, BlastMenuRadioItem, BlastMenuTrigger } from "#web/components/blast-ui/BlastMenu.tsx";
import { Button, DisclosureButton } from "#web/components/blast-ui/Button.tsx";
import { CopyAddress } from "#web/components/blast-ui/CopyAddress.tsx";
import { DiagnosticText } from "#web/components/blast-ui/DiagnosticText.tsx";
import { CheckIcon } from "#web/components/blast-ui/Icons.tsx";
import { Segmented } from "#web/components/blast-ui/Segmented.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { TextField } from "#web/components/blast-ui/TextField.tsx";
import { TransactionLink } from "#web/components/blast-ui/TransactionLink.tsx";
import { decimalText, dropDecimal, pasteDecimal } from "#web/lib/decimal-input.ts";
import { useDebouncedValue } from "#web/lib/use-debounced-value.ts";

import coinStyles from "../coins/coins.module.css";
import { atomsToField, fmtLive } from "../trade/trade-ticket.ts";

import type { BridgeChain, BridgeConfig } from "./bridge-config.ts";
import { guardQuote, quoteFacts, type BridgeRequest } from "./bridge-guard.ts";
import {
  actionDisabled,
  actionLabel,
  actionReason,
  amountAtoms,
  bridgeAction,
  type BridgeAction,
  bridgeChains,
  CHAINS,
  DESTINATIONS,
  displayAmount,
  exceedsBalance,
  isPausedError,
  maxField,
  PAUSED_TEXT,
  QUOTE_FAILED_TEXT,
  quoteErrorText,
  quoteRows,
  SEND_FAILED_TEXT,
  type ChainInfo,
  type DestinationToken,
  type QuoteRows,
  type SourceToken,
  type TransferState,
  usdBand,
} from "./bridge-model.ts";
import { explorerLink, mergeRows, type BridgeRow, type BridgeSdk, type EvmWallet, type SolanaWallet, type SourceWallet, type TransferStatus } from "./bridge-sdk.ts";
import styles from "./bridge.module.css";

/** The source wallets Privy has connected, and how to connect one. */
export type BridgeWallets = Readonly<{
  evm: EvmWallet | null;
  solana: SolanaWallet | null;
  connect(kind: ChainInfo["kind"]): void;
}>;

export type BridgeFormProps = Readonly<{
  config: BridgeConfig;
  sdk: BridgeSdk;
  wallets: BridgeWallets;
  /** The Blast account's Sui address; null while it loads or when signed out. */
  blastAddress: string | null;
  signedIn: boolean;
  onSignIn: () => void;
  /** A bridge this card watched has arrived: refresh balances, say so once. */
  onArrived: (row: BridgeRow, toAmount: string | null) => void;
  now?: () => number;
}>;

const QUOTE_DEBOUNCE_MS = 400;
const QUOTE_FRESH_MS = 60_000;
const STATUS_POLL_MS = 5_000;
const STATUS_GIVE_UP_MS = 30 * 60_000;
const BUSY_TEXT = "Confirm in your wallet.";

/** Retry only what may pass on a second try: rate limits, server errors, the network. */
function retryable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return !isPausedError(error) && typeof code !== "string";
}

/** The wallet said no: back to the button, no banner. */
function rejected(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return code === 4001 || code === "ACTION_REJECTED" || (typeof message === "string" && /reject|denied|cancel/i.test(message));
}

type Selection = Readonly<{ chain: BridgeChain; info: ChainInfo; token: SourceToken; to: DestinationToken }>;

type ReadArgs = Readonly<{
  sdk: BridgeSdk;
  selection: Selection;
  wallet: SourceWallet | null;
  blastAddress: string | null;
  atoms: bigint | null;
  paused: boolean;
  onPaused: (error: unknown) => void;
}>;

/** Mayan's quote for what is typed, the source balance, the router allowance and the Blast address's history. */
function useBridgeReads(args: ReadArgs) {
  const quoted = useBridgeQuote(args);
  const source = useSourceReads(args, quoted);
  const history = useBridgeHistory(args.sdk, args.blastAddress);
  return { ...quoted, ...source, history };
}

/** Mayan's quote for the settled amount, bound to the source wallet and the Blast address once both are known. */
function useBridgeQuote({ sdk, selection, wallet, blastAddress, atoms, paused, onPaused }: ReadArgs) {
  const { chain, token, to } = selection;
  const typed = atoms?.toString() ?? null;
  const settled = useDebouncedValue(typed, QUOTE_DEBOUNCE_MS);
  const typing = settled !== typed;
  // A bound quote names the source wallet and the Blast address and carries a Blink order.
  const swapper = wallet && blastAddress ? wallet.address : undefined;
  const destination = swapper ? blastAddress! : undefined;
  const quoteKey = ["bridge", "quote", chain, token.mayan, settled, to.coinType, swapper ?? null, destination ?? null] as const;
  const quote = useQuery({
    queryKey: quoteKey,
    queryFn: async () => {
      try {
        return await sdk.quote({ chain, token, to, amountIn64: settled!, swapper, destination });
      } catch (error) {
        if (isPausedError(error)) onPaused(error);
        throw error;
      }
    },
    enabled: settled !== null && !paused,
    // No interval: each bound quote opens an order at Mayan. A stale one is re-asked when the tab returns.
    staleTime: QUOTE_FRESH_MS,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
    retry: (count, error) => count < 3 && retryable(error),
    retryDelay: (attempt) => 1000 * 2 ** attempt,
  });
  const shown: Quote | undefined = atoms === null ? undefined : quote.data;
  const current = shown !== undefined && !quote.isPlaceholderData && !typing;
  return { typing, quote, quoteKey, shown, current, settled, bound: swapper !== undefined };
}

/** The source wallet's balance and, for an ERC-20 on the right chain, whether the router may spend the amount. */
function useSourceReads({ sdk, selection, wallet }: ReadArgs, { quote, settled, current, bound }: ReturnType<typeof useBridgeQuote>) {
  const { chain, info, token } = selection;
  const balanceKey = ["bridge", "balance", chain, token.mayan, wallet?.address ?? null] as const;
  const balance = useQuery({
    queryKey: balanceKey,
    queryFn: () => sdk.balance(chain, token, wallet!.address),
    enabled: wallet !== null,
    staleTime: Infinity,
    retry: 1,
  });

  const evmWallet = wallet?.kind === "evm" ? wallet : null;
  const wrongChain = evmWallet !== null && evmWallet.chainId !== info.chainId;
  const allowanceKey = ["bridge", "allowance", chain, token.mayan, evmWallet?.address ?? null, settled] as const;
  const allowance = useQuery({
    queryKey: allowanceKey,
    queryFn: () => sdk.allowanceEnough(quote.data!, evmWallet!, chain),
    enabled: evmWallet !== null && !token.native && !wrongChain && current && bound,
    staleTime: Infinity,
    retry: 1,
  });
  return { balance, evmWallet, wrongChain, allowance, allowanceKey };
}

/** Bridges Mayan lists for the Blast address. */
function useBridgeHistory(sdk: BridgeSdk, blastAddress: string | null) {
  return useQuery({
    queryKey: ["bridge", "history", blastAddress],
    queryFn: () => sdk.history(blastAddress!),
    enabled: blastAddress !== null,
    // Read once when the screen opens; rows this card sends are added locally.
    staleTime: Infinity,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

type SendKeys = Readonly<{ quoteKey: readonly unknown[]; allowanceKey: readonly unknown[] }>;

/** Approve, switch and bridge: each re-asks Mayan for a bound quote and checks it before any wallet call. */
function useBridgeSend({ sdk, selection, keys, shown, now, onPaused, onSent }: Readonly<{
  sdk: BridgeSdk;
  selection: Selection;
  keys: SendKeys;
  shown: Quote | undefined;
  now: () => number;
  onPaused: (error: unknown) => void;
  onSent: () => void;
}>) {
  const { chain, info, token, to } = selection;
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState<string | null>(null);
  // The quote inputs a lower fresh rate was found for; any new input clears the prompt.
  const [rateChangedFor, setRateChangedFor] = useState<string | null>(null);
  const [sent, setSent] = useState<readonly BridgeRow[]>([]);
  const running = useRef(false);
  const inputs = keys.quoteKey.join("|");

  // Quote errors get quote copy here; anything after this point gets the send copy in `run`.
  const freshQuote = async (ask: BridgeRequest): Promise<Quote | null> => {
    let fresh: Quote;
    try {
      fresh = await sdk.quote({ chain, token, to, amountIn64: ask.amountIn64, swapper: ask.sourceAddress, destination: ask.blastAddress });
    } catch (error) {
      if (isPausedError(error)) onPaused(error);
      console.error("Bridge quote failed before signing", error);
      setFailed(quoteErrorText(error, info, token));
      return null;
    }
    const checked = guardQuote(fresh, ask, now());
    if (checked.ok) return fresh;
    console.error("Bridge quote refused before signing", checked.reason);
    setFailed(QUOTE_FAILED_TEXT);
    return null;
  };

  // One wallet step at a time; its pending state is the card's busy state.
  const step = useMutation({
    mutationFn: (work: () => Promise<void>) => work(),
    onError: (error) => {
      if (rejected(error)) return;
      if (isPausedError(error)) onPaused(error);
      console.error("Bridge failed", error);
      setFailed(isPausedError(error) ? PAUSED_TEXT : SEND_FAILED_TEXT);
    },
    // An approval or a bridge spends from the source wallet, gas included.
    // Not awaited, so the button frees up before the balance comes back.
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["bridge", "balance"] }); },
    onSettled: () => { running.current = false; },
  });
  const run = (work: () => Promise<void>) => {
    // The ref also stops a second press that lands before the busy render.
    if (running.current) return;
    running.current = true;
    setFailed(null);
    step.mutate(work);
  };

  const approve = (ask: BridgeRequest, source: EvmWallet) => run(async () => {
    const fresh = await freshQuote(ask);
    if (!fresh) return;
    await sdk.approve(fresh, source, chain);
    // Re-check on the quote the approval was made for.
    queryClient.setQueryData(keys.allowanceKey, await sdk.allowanceEnough(fresh, source, chain));
  });

  const bridge = (ask: BridgeRequest, source: SourceWallet, fromAmount: string) => run(async () => {
    const fresh = await freshQuote(ask);
    if (!fresh) return;
    queryClient.setQueryData(keys.quoteKey, fresh);
    if (shown && fresh.minReceived < shown.minReceived) {
      setRateChangedFor(inputs);
      return;
    }
    if (source.kind === "evm" && !token.native && !(await sdk.allowanceEnough(fresh, source, chain))) {
      queryClient.setQueryData(keys.allowanceKey, false);
      return;
    }
    const record = (hash: string) => setSent((rows) => rows.some((row) => row.hash === hash) ? rows : [{ hash, chain, fromAmount, fromSymbol: token.symbol, toAmount: String(fresh.expectedAmountOut), toSymbol: to.symbol, state: "pending", at: new Date(now()).toISOString() }, ...rows]);
    record(await sdk.send(fresh, ask, source, record));
    routeEvent(fresh, chain, token);
    onSent();
    setRateChangedFor(null);
    // The send spent the allowance; the same amount again must check it afresh.
    queryClient.removeQueries({ queryKey: ["bridge", "allowance"] });
  });

  const switchTo = (source: EvmWallet) => run(() => source.switchChain(info.chainId!));

  return { busy: step.isPending, failed, setFailed, rateChanged: rateChangedFor === inputs, sent, approve, bridge, switchTo };
}

/**
 * One `bridge_route` event per started bridge: Mayan's route, the source and a
 * coarse USD band (never an amount or a wallet), to measure how often amounts
 * near the BLINK cap come up.
 */
function routeEvent(quote: Quote, chain: BridgeChain, token: SourceToken) {
  try {
    track("bridge_route", { route: quote.type, source: `${chain}:${token.symbol}`, band: usdBand(quoteFacts(quote, token).amountInUsd) });
  } catch {
    // Analytics never breaks the card.
  }
}

/** The line under the panels: paused, a failed send, or why the quote failed. */
function noteText(paused: boolean, failed: string | null, quoteError: string | null): string | null {
  if (paused) return PAUSED_TEXT;
  return failed ?? quoteError;
}

/** The chain, coins and amount the user picked; a new coin starts with an empty amount. */
function useBridgeInputs(chains: readonly BridgeChain[]) {
  const [chain, setChain] = useState<BridgeChain>(chains[0]!);
  const [tokenIndex, setTokenIndex] = useState<0 | 1>(0);
  const [toIndex, setToIndex] = useState<0 | 1>(0);
  const [amount, setAmount] = useState("");
  const info = CHAINS[chain];
  const token = info.tokens[tokenIndex];
  const selection: Selection = { chain, info, token, to: DESTINATIONS[toIndex]! };
  const chooseChain = (next: BridgeChain) => {
    setChain(next);
    // 0.1 ETH is not 0.1 SOL: a new coin starts empty, the same coin keeps its amount.
    if (CHAINS[next].tokens[tokenIndex].symbol !== token.symbol) setAmount("");
  };
  const chooseToken = (next: 0 | 1) => {
    setTokenIndex(next);
    setToIndex(info.tokens[next].symbol === "USDC" ? 1 : 0);
    setAmount("");
  };
  return { selection, tokenIndex, toIndex, setToIndex, amount, setAmount, chooseChain, chooseToken };
}

type ActionInputs = Readonly<{
  reads: ReturnType<typeof useBridgeReads>;
  send: ReturnType<typeof useBridgeSend>;
  selection: Selection;
  wallet: SourceWallet | null;
  atoms: bigint | null;
  paused: boolean;
  signedIn: boolean;
  blastAddress: string | null;
}>;

/** What the button does now, and why the last quote failed if it did. */
function formAction({ reads, send, selection, wallet, atoms, paused, signedIn, blastAddress }: ActionInputs) {
  const { info, token } = selection;
  const quoteSettled = reads.quote.isError && !reads.quote.isFetching && atoms !== null && !reads.typing && !paused;
  const quoteError = quoteSettled ? quoteErrorText(reads.quote.error, info, token) : null;
  const action = bridgeAction({
    paused,
    signedIn,
    blastAddress,
    sourceConnected: wallet !== null,
    wrongChain: reads.wrongChain,
    atoms,
    insufficient: atoms !== null && reads.balance.data !== undefined && exceedsBalance(atoms, reads.balance.data, token),
    quoting: reads.typing || reads.quote.isFetching,
    quoteFailed: quoteError === QUOTE_FAILED_TEXT,
    hasQuote: reads.current,
    busy: send.busy,
    needsApproval: reads.allowance.data === false,
    rateChanged: send.rateChanged,
  });
  return { quoteError, action };
}

export function BridgeForm({ config, sdk, wallets, blastAddress, signedIn, onSignIn, onArrived, now = Date.now }: BridgeFormProps) {
  const id = useId();
  const chains = bridgeChains(config);
  const { selection, tokenIndex, toIndex, setToIndex, amount, setAmount, chooseChain, chooseToken } = useBridgeInputs(chains);
  const { chain, info, token } = selection;
  const [paused, setPaused] = useState(false);
  const onPaused = useCallback((error: unknown) => {
    setPaused(true);
    console.error("Mayan refused this SDK version: upgrade @mayanfinance/swap-sdk", error);
  }, []);

  const wallet: SourceWallet | null = info.kind === "evm" ? wallets.evm : wallets.solana;
  const atoms = amountAtoms(amount, token);
  const reads = useBridgeReads({ sdk, selection, wallet, blastAddress, atoms, paused, onPaused });
  const send = useBridgeSend({ sdk, selection, keys: reads, shown: reads.shown, now, onPaused, onSent: () => setAmount("") });
  const { quoteError, action } = formAction({ reads, send, selection, wallet, atoms, paused, signedIn, blastAddress });

  const request = (): BridgeRequest => ({ chain, token, to: selection.to, amountIn64: atoms!.toString(), blastAddress: blastAddress!, sourceAddress: wallet!.address });
  const press = () => pressAction(action.kind, {
    signIn: onSignIn,
    connect: () => wallets.connect(info.kind),
    switch: () => { if (reads.evmWallet) send.switchTo(reads.evmWallet); },
    retry: () => { void reads.quote.refetch(); },
    approve: () => { if (reads.evmWallet) send.approve(request(), reads.evmWallet); },
    bridge: () => { if (wallet) send.bridge(request(), wallet, amount.replace(/,/g, "")); },
  });

  const facts = reads.shown ? quoteRows(quoteFacts(reads.shown, token), token, selection.to) : null;
  const refreshing = facts !== null && (reads.quote.isFetching || reads.typing);
  const message = noteText(paused, send.failed, quoteError);
  // Nothing to change while a wallet is asked or Mayan has paused this SDK.
  const locked = send.busy || paused;
  const rows = mergeRows(send.sent, reads.history.data ?? []);

  return (
    <div className={styles.form}>
      <ChainChoice chain={chain} chains={chains} disabled={locked} onChange={(next) => { chooseChain(next); send.setFailed(null); }} />
      <div className={styles.panels}>
        <SendPanel
          amount={amount}
          balance={reads.balance.data}
          busy={locked}
          connected={wallet !== null}
          id={id}
          info={info}
          onAmount={(next) => { setAmount(next); send.setFailed(null); }}
          onToken={(next) => { chooseToken(next); send.setFailed(null); }}
          token={token}
          tokenIndex={tokenIndex}
        />
        <GetPanel
          blastAddress={blastAddress}
          busy={locked}
          facts={facts}
          onTo={setToIndex}
          refreshing={refreshing}
          toIndex={toIndex}
          waiting={atoms !== null && !message}
        />
      </div>
      <QuoteNotes
        amount={amount}
        busy={action.kind === "busy"}
        facts={atoms === null ? null : facts}
        info={info}
        message={message}
        rateChanged={send.rateChanged}
        reason={actionReason(action, token)}
        refreshing={refreshing}
        token={token}
      />
      <Button
        className={styles.action}
        disabled={actionDisabled(action) && action.kind !== "busy"}
        loading={action.kind === "busy"}
        loadingLabel={BUSY_TEXT}
        onClick={press}
        size="lg"
        variant="primary"
      >
        {actionLabel(action, info, token)}
      </Button>
      <p className={styles.powered}>Powered by Mayan</p>
      <RecentBridges id={id} now={now} onArrived={onArrived} rows={rows} sdk={sdk} />
    </div>
  );
}

type PressHandlers = Readonly<{ signIn(): void; connect(): void; switch(): void; retry(): void; approve(): void; bridge(): void }>;

function pressAction(kind: BridgeAction["kind"], handlers: PressHandlers): void {
  switch (kind) {
    case "signIn":
    case "connect":
    case "switch":
    case "retry":
    case "approve":
    case "bridge":
      return handlers[kind]();
    case "requote":
      return handlers.bridge();
    default:
      return;
  }
}

/** The source chain: four choices, so a menu (a tab row holds three at most). */
function ChainChoice({ chain, chains, disabled, onChange }: Readonly<{ chain: BridgeChain; chains: readonly BridgeChain[]; disabled: boolean; onChange: (chain: BridgeChain) => void }>) {
  const chosen = CHAINS[chain];
  return (
    <BlastMenu
      className={styles.chainMenu}
      label="From chain"
      placement={() => ({ side: "bottom", align: "start", sideOffset: 6, avoid: "flip", originX: "1.5rem" })}
      trigger={
        <BlastMenuTrigger
          aria-label={`From ${chosen.label}. Change chain`}
          className={styles.chainPick}
          disabled={disabled}
          render={<DisclosureButton><Logo size={24} src={chosen.logo} />From {chosen.label}</DisclosureButton>}
        />
      }
    >
      <BlastMenuRadioGroup onValueChange={(next: string) => onChange(next as BridgeChain)} value={chain}>
        {chains.map((key) => (
          <BlastMenuRadioItem closeOnClick className={styles.chainOption} key={key} label={CHAINS[key].label} value={key}>
            <Logo size={24} src={CHAINS[key].logo} />
            <b>{CHAINS[key].label}</b>
            {key === chain ? <CheckIcon strong /> : null}
          </BlastMenuRadioItem>
        ))}
      </BlastMenuRadioGroup>
    </BlastMenu>
  );
}

function SendPanel({ id, amount, onAmount, balance, busy, connected, info, token, tokenIndex, onToken }: Readonly<{
  id: string;
  amount: string;
  onAmount: (amount: string) => void;
  balance: bigint | undefined;
  busy: boolean;
  connected: boolean;
  info: ChainInfo;
  token: SourceToken;
  tokenIndex: 0 | 1;
  onToken: (index: 0 | 1) => void;
}>) {
  const balanceText = balance === undefined
    ? <SkeletonText>Balance 0.0000 {token.symbol}</SkeletonText>
    : `Balance ${atomsToField(balance, token.decimals)} ${token.symbol}`;
  return (
    <div className={coinStyles.amt}>
      <div className={coinStyles.amtTop}>
        <label htmlFor={`${id}-amount`}>You send</label>
        {connected ? (
          <Button
            disabled={balance === undefined || busy}
            onClick={() => onAmount(maxField(balance!, token))}
            size="xs"
            variant="ghost"
          >
            Max
          </Button>
        ) : null}
      </div>
      <div className={coinStyles.amtRow}>
        <AmountFit value={amount}>
          <TextField
            autoComplete="off"
            className={styles.amountInput}
            data-coin-focus=""
            disabled={busy}
            id={`${id}-amount`}
            inputMode="decimal"
            onChange={(event) => onAmount(fmtLive(decimalText(event), token.decimals))}
            onDrop={(event) => dropDecimal(event, (text) => onAmount(fmtLive(text, token.decimals)))}
            onPaste={(event) => pasteDecimal(event, (text) => onAmount(fmtLive(text, token.decimals)))}
            placeholder="0"
            value={amount}
          />
        </AmountFit>
        <Segmented
          className={styles.coinPick}
          disabled={busy}
          label="Coin to send"
          onChange={onToken}
          options={info.tokens.map((option, index) => [index as 0 | 1, <Named key={option.symbol} logo={option.logo} name={option.symbol} />] as const)}
          size="sm"
          value={tokenIndex}
        />
      </div>
      <div className={coinStyles.amtFoot}>
        <span>{connected ? balanceText : `Your ${info.label} wallet`}</span>
      </div>
    </div>
  );
}

function GetPanel({ facts, waiting, refreshing, toIndex, onTo, busy, blastAddress }: Readonly<{
  facts: QuoteRows | null;
  /** An amount is typed and nothing went wrong: a quote is on its way. */
  waiting: boolean;
  refreshing: boolean;
  toIndex: 0 | 1;
  onTo: (index: 0 | 1) => void;
  busy: boolean;
  blastAddress: string | null;
}>) {
  let value: ReactNode = "0";
  if (facts) value = facts.amount;
  else if (waiting) value = <SkeletonText>0.0000</SkeletonText>;
  return (
    <div aria-live="polite" className={clsx(coinStyles.amt, coinStyles.amtOut)}>
      <div className={coinStyles.amtTop}>
        <span className={coinStyles.lbl}>You get on Sui</span>
      </div>
      <div className={coinStyles.amtRow}>
        <AmountFit value={facts?.amount ?? "0"}>
          <b className={clsx(coinStyles.amtVal, "num", !facts && coinStyles.zero, refreshing && coinStyles.pending)}>{value}</b>
        </AmountFit>
        <Segmented
          className={styles.coinPick}
          disabled={busy}
          label="Coin to receive"
          onChange={onTo}
          options={DESTINATIONS.map((option, index) => [index as 0 | 1, <Named key={option.symbol} logo={option.logo} name={option.symbol} />] as const)}
          size="sm"
          value={toIndex}
        />
      </div>
      <div className={coinStyles.amtFoot}>
        {blastAddress ? <CopyAddress copyLabel="Copy address" label="Your Blast wallet" value={blastAddress} /> : <span>Your Blast wallet</span>}
      </div>
    </div>
  );
}

function QuoteNotes({ facts, amount, info, token, refreshing, message, rateChanged, reason, busy }: Readonly<{
  facts: QuoteRows | null;
  amount: string;
  info: ChainInfo;
  token: SourceToken;
  refreshing: boolean;
  message: string | null;
  rateChanged: boolean;
  reason: string | null;
  busy: boolean;
}>) {
  return (
    <>
      {facts ? (
        <div className={clsx(styles.summary, refreshing && styles.refreshing)}>
          <p className={styles.sentence}>
            Send {displayAmount(amount.replace(/,/g, ""), token.symbol)} from {info.label}. You get at least {facts.minimum}.
          </p>
          <dl className={coinStyles.terms}>
            <div><dt>Fee</dt><dd>{facts.fee}</dd></div>
            <div><dt>Arrives</dt><dd>{facts.eta}</dd></div>
          </dl>
        </div>
      ) : null}
      {message ? <p className={clsx(coinStyles.status, styles.note)} role="alert"><DiagnosticText message={message} /></p> : null}
      {rateChanged ? <p className={clsx(coinStyles.status, styles.note)} role="status">The rate changed. Check the new numbers.</p> : null}
      {reason && !message ? <p className={clsx(coinStyles.status, styles.note)}>{reason}</p> : null}
      {busy ? <p aria-hidden="true" className={clsx(coinStyles.status, styles.note)}>{BUSY_TEXT}</p> : null}
    </>
  );
}

function RecentBridges({ id, rows, sdk, onArrived, now }: Readonly<{ id: string; rows: readonly BridgeRow[]; sdk: BridgeSdk; onArrived: BridgeFormProps["onArrived"]; now: () => number }>) {
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby={`${id}-recent`} className={styles.recent}>
      <h3 id={`${id}-recent`}>Recent bridges</h3>
      <ul>
        {rows.map((row) => <BridgeRowView key={row.hash} now={now} onArrived={onArrived} row={row} sdk={sdk} />)}
      </ul>
    </section>
  );
}

function BridgeRowView({ row, sdk, onArrived, now }: Readonly<{ row: BridgeRow; sdk: BridgeSdk; onArrived: BridgeFormProps["onArrived"]; now: () => number }>) {
  const age = now() - Date.parse(row.at);
  const watching = row.state === "pending" && age < STATUS_GIVE_UP_MS;
  const queryClient = useQueryClient();
  const statusKey = ["bridge", "status", row.hash] as const;
  const status = useQuery({
    queryKey: statusKey,
    // Announced where the read lands, and only on a change to "done": a "done" cached from an earlier visit is not news.
    queryFn: async () => {
      const before = queryClient.getQueryData<TransferStatus>(statusKey)?.state;
      const next = await sdk.status(row.hash);
      if (next.state === "done" && before !== "done") onArrived(row, next.toAmount);
      return next;
    },
    enabled: watching,
    // Every 5 s while the page is visible; it stops once Mayan settles it.
    refetchInterval: (query) => (query.state.data?.state ?? "pending") === "pending" && now() - Date.parse(row.at) < STATUS_GIVE_UP_MS ? STATUS_POLL_MS : false,
    retry: 1,
  });
  const state = status.data?.state ?? row.state;
  const toAmount = status.data?.toAmount ?? row.toAmount;
  const info = row.chain ? CHAINS[row.chain] : null;
  const chain = info?.label ?? "another chain";
  const sentText = displayAmount(row.fromAmount, row.fromSymbol);
  const line = statusLine(state, chain, toAmount, row.toSymbol, age >= STATUS_GIVE_UP_MS);
  return (
    <li className={styles.row} data-state={state}>
      <Logo size={24} src={info?.logo ?? null} />
      <div className={styles.rowText}>
        <b>{sentText} from {chain}</b>
        <span role={state === "pending" ? undefined : "status"}>{line}</span>
      </div>
      <TransactionLink href={explorerLink(row.hash)} label="View on Mayan" />
    </li>
  );
}

function statusLine(state: TransferState, chain: string, toAmount: string | null | undefined, symbol: string, gaveUp: boolean): string {
  const received = toAmount ? displayAmount(toAmount, symbol) : null;
  if (state === "done") return `Arrived · ${received ?? symbol}`;
  if (state === "refunded") return `Refunded to your ${chain} wallet`;
  if (gaveUp) return "Still on the way. Check on Mayan.";
  return received ? `On the way · ≈ ${received}` : "On the way";
}

/** A chain's or coin's logo: decorative beside its name, and its box stays if the file fails to load. */
function Logo({ src, size }: Readonly<{ src: string | null; size: 16 | 24 }>) {
  if (src === null) return <span aria-hidden="true" className={styles.logo} data-size={size} />;
  // Local brand marks, as DexIdentity draws them.
  // eslint-disable-next-line @next/next/no-img-element
  return <img alt="" aria-hidden="true" className={styles.logo} data-size={size} draggable={false} height={size} onError={(event) => { event.currentTarget.style.visibility = "hidden"; }} src={src} width={size} />;
}

function Named({ logo, name }: Readonly<{ logo: string; name: string }>) {
  return <span className={styles.named}><Logo size={16} src={logo} />{name}</span>;
}
