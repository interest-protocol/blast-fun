"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { track } from "@vercel/analytics";
import clsx from "clsx";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import type { Quote } from "@mayanfinance/swap-sdk";

import { NO_VALUE } from "@blast/core/web/format.ts";

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
import { readBrowserStorage, writeBrowserStorage } from "#web/lib/browser-storage.ts";
import { decimalText, dropDecimal, pasteDecimal } from "#web/lib/decimal-input.ts";
import { useDebouncedValue } from "#web/lib/use-debounced-value.ts";

import coinStyles from "../coins/coins.module.css";
import { fmtLive } from "../trade/trade-ticket.ts";

import { BRIDGE_CHAINS, type BridgeChain } from "./bridge-config.ts";
import { guardQuote, quoteFacts, type BridgeRequest } from "./bridge-guard.ts";
import {
  actionDisabled,
  actionLabel,
  actionReason,
  amountAtoms,
  BALANCE_FAILED_TEXT,
  bridgeAction,
  bridgeAmountField,
  type BridgeAction,
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
import { SourceTokenPicker } from "./SourceTokenPicker.tsx";
import { readSolanaSubmission, SOLANA_RETRY_UNAVAILABLE, subscribeSolanaSubmission, withSolanaSubmissionLock } from "./solana-submission.ts";

/** The source wallets Privy has connected, and how to connect one. */
export type BridgeWallets = Readonly<{
  evm: EvmWallet | null;
  solana: SolanaWallet | null;
  connect(kind: ChainInfo["kind"]): void;
}>;

export type BridgeFormProps = Readonly<{
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
const INDEXING_WINDOW_MS = 60_000;
const BUSY_TEXT = "Confirm in your wallet.";
const CHECKING_TEXT = "Checking Solana transfer.";

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
    enabled: settled !== null && !typing && !paused,
    // No interval: each bound quote opens an order at Mayan. A stale one is re-asked when the tab returns.
    staleTime: QUOTE_FRESH_MS,
    refetchOnWindowFocus: true,
    // Only the amount may differ. Never show a previous pair's amounts under a new coin.
    placeholderData: (previous, query) => (
      query?.queryKey.every((part, index) => index === 4 || part === quoteKey[index]) ? previous : undefined
    ),
    retry: (count, error) => count < 3 && retryable(error),
    retryDelay: (attempt) => 1000 * 2 ** attempt,
  });
  const shown: Quote | undefined = atoms === null ? undefined : quote.data;
  const current = shown !== undefined && !quote.isPlaceholderData && !typing;
  return { typing, quote, quoteKey, shown, current, settled, bound: swapper !== undefined };
}

/** The source wallet's balance and, for an ERC-20 on the right chain, whether the router may spend the amount. */
function useSourceReads({ sdk, selection, wallet }: ReadArgs, { quote, settled, current, bound }: ReturnType<typeof useBridgeQuote>) {
  const { chain, info, token, to } = selection;
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
  const allowanceKey = ["bridge", "allowance", chain, token.mayan, evmWallet?.address ?? null, settled, to.coinType] as const;
  const allowance = useQuery({
    queryKey: allowanceKey,
    queryFn: () => sdk.allowanceEnough(quote.data!, evmWallet!, chain),
    enabled: evmWallet !== null && !token.native && !wrongChain && current && bound,
    staleTime: Infinity,
    retry: 1,
  });
  return { balance, evmWallet, wrongChain, allowance, allowanceKey };
}

function recentSubmissionKey(blastAddress: string) {
  return `blast:bridge-submissions:${blastAddress.toLowerCase()}`;
}

/** Tab-local index hints expire after one minute. Mayan supplies all amounts and status. */
function recentSubmissions(blastAddress: string) {
  const cutoff = Date.now() - INDEXING_WINDOW_MS;
  return (readBrowserStorage("session", recentSubmissionKey(blastAddress)) ?? "").split(",").flatMap((entry) => {
    const [at, hash] = entry.split(":");
    return Number(at) > cutoff && hash ? [{ at, hash }] : [];
  });
}

function rememberSubmission(blastAddress: string, hash: string) {
  const existing = recentSubmissions(blastAddress);
  if (existing.some((entry) => entry.hash === hash)) return;
  const recent = [{ at: Date.now(), hash }, ...existing].slice(0, 5);
  writeBrowserStorage("session", recentSubmissionKey(blastAddress), recent.map((entry) => `${entry.at}:${entry.hash}`).join(","));
}

function forgetSubmission(blastAddress: string, hash: string) {
  const remaining = recentSubmissions(blastAddress).filter((entry) => entry.hash !== hash);
  writeBrowserStorage("session", recentSubmissionKey(blastAddress), remaining.map((entry) => `${entry.at}:${entry.hash}`).join(","));
}

/** Bridges Mayan lists for the Blast address. */
function useBridgeHistory(sdk: BridgeSdk, blastAddress: string | null) {
  return useQuery({
    queryKey: ["bridge", "history", blastAddress],
    queryFn: () => sdk.history(blastAddress!),
    enabled: blastAddress !== null,
    // Read on open. Only tabs with a recent, not-yet-indexed submission retry.
    staleTime: Infinity,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchInterval: (query) => {
      const listed = query.state.data ?? [];
      return blastAddress && recentSubmissions(blastAddress).some(({ hash }) => !listed.some((row) => row.hash === hash)) ? STATUS_POLL_MS : false;
    },
    retry: 1,
  });
}

type SendKeys = Readonly<{ quoteKey: readonly unknown[]; allowanceKey: readonly unknown[] }>;

/** Approve, switch and bridge: each re-asks Mayan for a bound quote and checks it before any wallet call. */
function useBridgeSend({ sdk, selection, keys, shown, now, onPaused, onSent, solanaAddress }: Readonly<{
  sdk: BridgeSdk;
  selection: Selection;
  keys: SendKeys;
  shown: Quote | undefined;
  now: () => number;
  onPaused: (error: unknown) => void;
  onSent: () => void;
  solanaAddress: string | null;
}>) {
  const { chain, info, token, to } = selection;
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState<string | null>(null);
  // The quote inputs a lower fresh rate was found for; any new input clears the prompt.
  const [rateChangedFor, setRateChangedFor] = useState<string | null>(null);
  const [sent, setSent] = useState<readonly BridgeRow[]>([]);
  const [solanaNotice, setSolanaNotice] = useState<Readonly<{ address: string; text: string; error: boolean }> | null>(null);
  const activeSolana = useRef(solanaAddress);
  useLayoutEffect(() => { activeSolana.current = solanaAddress; }, [solanaAddress]);
  const running = useRef(false);
  // Closing the screen aborts: no wallet opens afterwards, from here or inside the SDK.
  const life = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    return () => controller.abort();
  }, []);
  const signal = () => life.current!.signal;
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
    if (signal().aborted) return null;
    const checked = guardQuote(fresh, ask, now());
    if (checked.ok) return fresh;
    console.error("Bridge quote refused before signing", checked.reason);
    setFailed(QUOTE_FAILED_TEXT);
    return null;
  };

  // One wallet step at a time; its pending state is the card's busy state.
  const step = useMutation({
    mutationFn: ({ work }: { work: () => Promise<void>; checkingAddress: string | null }) => work(),
    // Run now even offline: the quote fails with its copy, instead of pausing and prompting the wallet on reconnect.
    networkMode: "always",
    onError: (error, { checkingAddress }) => {
      // The person said no in the wallet: nothing to explain.
      if (rejected(error)) return;
      console.error("Bridge failed", error);
      // Closed: no card left to explain it on.
      if (signal().aborted) return;
      if (checkingAddress) {
        if (activeSolana.current === checkingAddress) {
          setSolanaNotice({ address: checkingAddress, text: "Couldn’t check the Solana transfer. Check again before sending. Code: bridge_solana_status_failed.", error: true });
        }
        return;
      }
      if ((error as { code?: unknown } | null)?.code === SOLANA_RETRY_UNAVAILABLE) {
        setFailed("Couldn’t secure a Solana send. Close other Bridge tabs or use a current browser with storage enabled. Code: bridge_solana_retry_unavailable.");
        return;
      }
      if (isPausedError(error)) onPaused(error);
      setFailed(isPausedError(error) ? PAUSED_TEXT : SEND_FAILED_TEXT);
    },
    // An approval or a bridge spends from the source wallet, gas included.
    // Not awaited, so the button frees up before the balance comes back.
    onSuccess: (_result, { checkingAddress }) => {
      if (!checkingAddress) void queryClient.invalidateQueries({ queryKey: ["bridge", "balance"] });
    },
    onSettled: () => { running.current = false; },
  });
  const run = (work: () => Promise<void>, checkingAddress: string | null = null) => {
    // The ref also stops a second press that lands before the busy render.
    if (running.current) return;
    running.current = true;
    setFailed(null);
    setSolanaNotice(null);
    step.mutate({ work, checkingAddress });
  };

  const approve = (ask: BridgeRequest, source: EvmWallet) => run(async () => {
    const fresh = await freshQuote(ask);
    if (!fresh) return;
    await sdk.approve(fresh, source, chain, signal());
    // Re-check on the quote the approval was made for.
    queryClient.setQueryData(keys.allowanceKey, await sdk.allowanceEnough(fresh, source, chain));
  });

  const sendBridge = async (ask: BridgeRequest, source: SourceWallet, fromAmount: string) => {
    if (source.kind === "solana" && readSolanaSubmission(source.address)) return;
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
    if (signal().aborted || (source.kind === "solana" && activeSolana.current !== source.address)) return;
    let signedHash: string | undefined;
    const record = (hash: string) => {
      signedHash = hash;
      rememberSubmission(ask.blastAddress, hash);
      setSent((rows) => rows.some((row) => row.hash === hash) ? rows : [{ hash, chain, fromAmount, fromSymbol: token.symbol, toAmount: String(fresh.expectedAmountOut), toSymbol: to.symbol, state: "pending", at: new Date(now()).toISOString() }, ...rows]);
    };
    try {
      const hash = await sdk.send(fresh, ask, source, record, signal());
      if (!signedHash) record(hash);
    } catch (error) {
      if (source.kind !== "solana" || !signedHash) throw error;
      console.error("Solana bridge submission could not be confirmed", error);
    }
    routeEvent(fresh, chain, token);
    if (source.kind !== "solana" || activeSolana.current === source.address) onSent();
    setRateChangedFor(null);
    // The send spent the allowance; the same amount again must check it afresh.
    queryClient.removeQueries({ queryKey: ["bridge", "allowance"] });
  };

  const bridge = (ask: BridgeRequest, source: SourceWallet, amount: string) => run(() =>
    source.kind === "solana"
      ? withSolanaSubmissionLock(source.address, () => sendBridge(ask, source, amount))
      : sendBridge(ask, source, amount));

  const checkSolana = (source: SolanaWallet, blastAddress: string) => run(async () => {
    const result = await sdk.checkSolanaSubmission(source.address);
    if (!result || signal().aborted || activeSolana.current !== source.address) return;
    if (result.state === "failed") {
      forgetSubmission(blastAddress, result.signature);
      setSent((rows) => rows.filter((row) => row.hash !== result.signature));
      setSolanaNotice({ address: source.address, text: "The Solana transfer didn’t go through. You can bridge again. Code: bridge_solana_not_sent.", error: true });
    } else if (result.state === "confirmed") {
      onSent();
      setSolanaNotice({ address: source.address, text: "Your transfer was confirmed on Solana.", error: false });
      void queryClient.invalidateQueries({ queryKey: ["bridge", "history", blastAddress] });
      void queryClient.invalidateQueries({ queryKey: ["bridge", "balance", "solana"] });
    } else {
      setSolanaNotice({ address: source.address, text: "Solana is still confirming your transfer. Check again in a moment.", error: false });
    }
  }, source.address);

  const switchTo = (source: EvmWallet) => run(() => source.switchChain(info.chainId!));

  const notice = solanaNotice?.address === solanaAddress ? solanaNotice : null;
  return { busy: step.isPending, busyText: step.variables?.checkingAddress ? CHECKING_TEXT : BUSY_TEXT, failed: failed ?? (notice?.error ? notice.text : null), setFailed, solanaNotice: notice?.error ? null : notice?.text, rateChanged: rateChangedFor === inputs, sent, approve, bridge, checkSolana, switchTo };
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
function useBridgeInputs() {
  const [chain, setChain] = useState<BridgeChain>(BRIDGE_CHAINS[0]);
  const [token, setToken] = useState<SourceToken>(CHAINS[BRIDGE_CHAINS[0]].tokens[0]);
  const [toIndex, setToIndex] = useState<0 | 1>(0);
  const [amount, setAmount] = useState("");
  const info = CHAINS[chain];
  const selection: Selection = { chain, info, token, to: DESTINATIONS[toIndex]! };
  const chooseChain = (next: BridgeChain) => {
    if (next === chain) return;
    const pinned = info.tokens.indexOf(token);
    const nextToken = CHAINS[next].tokens[pinned === 1 ? 1 : 0];
    setChain(next);
    setToken(nextToken);
    if (pinned < 0 || nextToken.symbol !== token.symbol) setAmount("");
  };
  const chooseToken = (next: SourceToken) => {
    if (next.mayan === token.mayan) return;
    setToken(next);
    setToIndex(next === info.tokens[1] ? 1 : 0);
    setAmount("");
  };
  return { selection, toIndex, setToIndex, amount, setAmount, chooseChain, chooseToken };
}

type ActionInputs = Readonly<{
  reads: ReturnType<typeof useBridgeReads>;
  send: ReturnType<typeof useBridgeSend>;
  selection: Selection;
  wallet: SourceWallet | null;
  atoms: bigint | null;
  id: string;
  paused: boolean;
  solanaPending: boolean;
  signedIn: boolean;
  blastAddress: string | null;
}>;

/** What the button does now, and why the last quote failed if it did. */
function formAction({ reads, send, selection, wallet, atoms, id, paused, signedIn, blastAddress, solanaPending }: ActionInputs) {
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
    balanceReady: reads.balance.isSuccess,
    insufficient: atoms !== null && reads.balance.data !== undefined && exceedsBalance(atoms, reads.balance.data, token),
    quoting: reads.typing || reads.quote.isFetching,
    quoteFailed: quoteError === QUOTE_FAILED_TEXT,
    hasQuote: reads.current,
    busy: send.busy,
    solanaPending,
    needsApproval: reads.allowance.data === false,
    rateChanged: send.rateChanged,
  });
  const message = noteText(paused, send.failed, quoteError);
  const balanceFailed = reads.balance.isError && !reads.balance.isFetching;
  const blockedByBalance = action.kind === "balance" && balanceFailed;
  const reason = blockedByBalance ? null : actionReason(action, token);
  const noteId = `${id}-bridge-note`;
  const actionDescription = blockedByBalance ? `${id}-balance-error` : message || reason ? noteId : undefined;
  const balance = reads.balance.isSuccess ? reads.balance.data : undefined;
  return { action, actionDescription, balance, balanceFailed, message, noteId, reason };
}

export function BridgeForm({ sdk, wallets, blastAddress, signedIn, onSignIn, onArrived, now = Date.now }: BridgeFormProps) {
  const id = useId();
  const { selection, toIndex, setToIndex, amount, setAmount, chooseChain, chooseToken } = useBridgeInputs();
  const { chain, info, token } = selection;
  const [paused, setPaused] = useState(false);
  const onPaused = useCallback((error: unknown) => {
    setPaused(true);
    console.error("Mayan refused this SDK version: upgrade @mayanfinance/swap-sdk", error);
  }, []);

  const wallet: SourceWallet | null = info.kind === "evm" ? wallets.evm : wallets.solana;
  const solanaAddress = wallet?.kind === "solana" ? wallet.address : null;
  const solanaPending = useSyncExternalStore(
    solanaAddress ? subscribeSolanaSubmission : noSubscription,
    () => solanaAddress ? readSolanaSubmission(solanaAddress) !== null : false,
    () => false,
  );
  const atoms = amountAtoms(amount, token);
  const reads = useBridgeReads({ sdk, selection, wallet, blastAddress, atoms: solanaPending ? null : atoms, paused, onPaused });
  const send = useBridgeSend({ sdk, selection, keys: reads, shown: reads.shown, now, onPaused, onSent: () => setAmount(""), solanaAddress });
  const { action, actionDescription, balance, balanceFailed, message, noteId, reason } = formAction({ reads, send, selection, wallet, atoms, id, paused, signedIn, blastAddress, solanaPending });

  const request = (): BridgeRequest => ({ chain, token, to: selection.to, amountIn64: atoms!.toString(), blastAddress: blastAddress!, sourceAddress: wallet!.address });
  const press = () => pressAction(action.kind, {
    signIn: onSignIn,
    connect: () => wallets.connect(info.kind),
    switch: () => { if (reads.evmWallet) send.switchTo(reads.evmWallet); },
    retry: () => { void reads.quote.refetch(); },
    approve: () => { if (reads.evmWallet) send.approve(request(), reads.evmWallet); },
    checkSolana: () => { if (wallet?.kind === "solana" && blastAddress) send.checkSolana(wallet, blastAddress); },
    bridge: () => { if (wallet) send.bridge(request(), wallet, amount.replace(/,/g, "")); },
  });

  const facts = reads.shown ? quoteRows(quoteFacts(reads.shown, token), token, selection.to) : null;
  const refreshing = facts !== null && (reads.quote.isFetching || reads.typing);
  // Nothing to change while a wallet is asked or Mayan has paused this SDK.
  const locked = send.busy || paused;
  const rows = mergeRows(send.sent, reads.history.data ?? []);

  return (
    <div className={styles.form}>
      <ChainChoice chain={chain} disabled={locked} onChange={(next) => { chooseChain(next); send.setFailed(null); }} />
      <div className={styles.panels}>
        <SendPanel
          amount={amount}
          balance={balance}
          balanceFailed={balanceFailed}
          busy={locked || solanaPending}
          chain={chain}
          connected={wallet !== null}
          id={id}
          onAmount={(next) => { setAmount(next); send.setFailed(null); }}
          onRetryBalance={() => { void reads.balance.refetch(); }}
          onToken={(next) => { chooseToken(next); send.setFailed(null); }}
          sdk={sdk}
          token={token}
        />
        <GetPanel
          blastAddress={blastAddress}
          busy={locked || solanaPending}
          facts={facts}
          onTo={setToIndex}
          refreshing={refreshing}
          failed={atoms !== null && message !== null}
          toIndex={toIndex}
          waiting={atoms !== null && !message}
        />
      </div>
      <QuoteNotes
        amount={amount}
        busyText={action.kind === "busy" ? send.busyText : null}
        facts={atoms === null ? null : facts}
        info={info}
        message={message}
        noteId={noteId}
        rateChanged={send.rateChanged}
        reason={reason}
        refreshing={refreshing}
        token={token}
      />
      {solanaAddress && send.solanaNotice ? <p className={clsx(coinStyles.status, styles.note)} role="status">{send.solanaNotice}</p> : null}
      <Button
        aria-describedby={actionDescription}
        className={styles.action}
        disabled={actionDisabled(action) && action.kind !== "busy"}
        loading={action.kind === "busy"}
        loadingLabel={send.busyText}
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

const noSubscription = () => () => undefined;

type PressHandlers = Readonly<{ signIn(): void; connect(): void; switch(): void; retry(): void; approve(): void; checkSolana(): void; bridge(): void }>;

function pressAction(kind: BridgeAction["kind"], handlers: PressHandlers): void {
  switch (kind) {
    case "signIn":
    case "connect":
    case "switch":
    case "retry":
    case "approve":
    case "checkSolana":
    case "bridge":
      return handlers[kind]();
    case "requote":
      return handlers.bridge();
    default:
      return;
  }
}

/** The source chain: six choices, so a menu (a tab row holds three at most). */
function ChainChoice({ chain, disabled, onChange }: Readonly<{ chain: BridgeChain; disabled: boolean; onChange: (chain: BridgeChain) => void }>) {
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
        {BRIDGE_CHAINS.map((key) => (
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

function SendPanel({ id, amount, onAmount, balance, balanceFailed, onRetryBalance, busy, connected, chain, sdk, token, onToken }: Readonly<{
  id: string;
  amount: string;
  onAmount: (amount: string) => void;
  balance: bigint | undefined;
  balanceFailed: boolean;
  onRetryBalance: () => void;
  busy: boolean;
  connected: boolean;
  chain: BridgeChain;
  sdk: BridgeSdk;
  token: SourceToken;
  onToken: (token: SourceToken) => void;
}>) {
  const balanceText = balance === undefined
    ? <SkeletonText>Balance 0.0000 {token.symbol}</SkeletonText>
    : `Balance ${bridgeAmountField(balance, token.decimals)} ${token.symbol}`;
  return (
    <div className={coinStyles.amt}>
      <div className={coinStyles.amtTop}>
        <label htmlFor={`${id}-amount`}>You send</label>
        {connected && balanceFailed ? (
          <Button disabled={busy} onClick={onRetryBalance} size="xs" variant="ghost">Retry balance</Button>
        ) : connected ? (
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
        <SourceTokenPicker chain={chain} disabled={busy} key={chain} onChange={onToken} sdk={sdk} token={token} />
      </div>
      <div className={coinStyles.amtFoot}>
        <span>{connected ? (balanceFailed ? `Balance ${NO_VALUE}` : balanceText) : `Your ${CHAINS[chain].label} wallet`}</span>
      </div>
      {connected && balanceFailed ? <p className={clsx(coinStyles.status, styles.note)} id={`${id}-balance-error`} role="alert"><DiagnosticText message={BALANCE_FAILED_TEXT} /></p> : null}
    </div>
  );
}

function GetPanel({ facts, waiting, failed, refreshing, toIndex, onTo, busy, blastAddress }: Readonly<{
  facts: QuoteRows | null;
  /** An amount is typed and nothing went wrong: a quote is on its way. */
  waiting: boolean;
  /** An amount is typed and the quote or send failed: there is no amount to show. */
  failed: boolean;
  refreshing: boolean;
  toIndex: 0 | 1;
  onTo: (index: 0 | 1) => void;
  busy: boolean;
  blastAddress: string | null;
}>) {
  let value: ReactNode = "0";
  if (facts) value = facts.amount;
  else if (waiting) value = <SkeletonText>0.0000</SkeletonText>;
  else if (failed) value = NO_VALUE;
  return (
    <div aria-live="polite" className={clsx(coinStyles.amt, coinStyles.amtOut)}>
      <div className={coinStyles.amtTop}>
        <span className={coinStyles.lbl}>You get on Sui</span>
      </div>
      <div className={coinStyles.amtRow}>
        <AmountFit value={facts?.amount ?? (failed ? NO_VALUE : "0")}>
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

function QuoteNotes({ facts, amount, info, token, refreshing, message, noteId, rateChanged, reason, busyText }: Readonly<{
  facts: QuoteRows | null;
  amount: string;
  info: ChainInfo;
  token: SourceToken;
  refreshing: boolean;
  message: string | null;
  noteId: string;
  rateChanged: boolean;
  reason: string | null;
  busyText: string | null;
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
      {message ? <p className={clsx(coinStyles.status, styles.note)} id={noteId} role="alert"><DiagnosticText message={message} /></p> : null}
      {rateChanged ? <p className={clsx(coinStyles.status, styles.note)} role="status">The rate changed. Check the new numbers.</p> : null}
      {reason && !message ? <p className={clsx(coinStyles.status, styles.note)} id={noteId}>{reason}</p> : null}
      {busyText ? <p aria-hidden="true" className={clsx(coinStyles.status, styles.note)}>{busyText}</p> : null}
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
      if (next.state === "done" && before !== "done") {
        // The source transaction is mined by now; the balance read right after sending was too early.
        void queryClient.invalidateQueries({ queryKey: ["bridge", "balance"] });
        // A failing announcement must not fail the read, or its retry would announce again.
        try {
          onArrived(row, next.toAmount);
        } catch (error) {
          console.error("Bridge arrival announcement failed", error);
        }
      }
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
