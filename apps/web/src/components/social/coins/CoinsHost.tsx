"use client";

import { findBrowserRoute } from "../trade/trade-estimate.ts";
import { diagnosticMessage, publicErrorMessage } from "#web/lib/errors.ts";

import { shortAddress } from "@blast/core/web/format.ts";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { useQuery } from "@tanstack/react-query";
import { PUBLIC_STALE_MS } from "#web/lib/query/client.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SocialPresaleDetail } from "@blast/core/web/contracts/presales.ts";

import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { useCoinPins } from "./coin-pins";
import { coinView } from "./coin-model";
import { useDevicePrefs } from "#web/components/blast-ui/device-prefs.ts";
import { EXPLORER_NAMES, explorerTransactionUrl } from "@blast/core/lib/explorer.ts";
import { useShellActions } from "#web/components/blast-ui/shell-actions.tsx";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { usePrivySessionMounted } from "#web/components/presale/providers/PrivySessionProvider.tsx";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { SUI_MAINNET_GRPC_URL } from "@blast/core/lib/sui-mainnet.ts";
import type { SocialWallet } from "@blast/core/web/contracts/coins.ts";

import { useTradeKit } from "../feed-ui/shell-bridge";
import { presaleDetailQuery, walletIdentityQuery, walletIdentityScope, walletQuery } from "../queries";
import { useSocialViewer } from "../SignInGate";
import { requestTradeQuote } from "../trades/trades-client";
import { useBalancesContext } from "./balances";
import { CoinSheet, type CoinSheetProps, type CoinSheetTrading, type CoinSheetWallet, type TradeAsk, type TradeOutcome, type WithdrawAsk } from "./CoinSheet";
import { coinAmt, coinDraftKey, parseSavedCoinScreen, walletCoinViews, type CoinOpening, type CoinScreen, type WalletCoinView } from "./coin-model";
import { useSignInDraft } from "../sign-in-draft";
import { PrivyCoinSignerBridge, type PrivyCoinSigner } from "./signers";
import { walletSessionSigner } from "./signers-model";
import { blastWalletSigner } from "../commit/commit-signers";
import { fetchListedTradeCoins, fetchTradeCoins, presaleCoinView } from "./swap-client";
import { encodeTradeAction, tradableCoinView, tradeOpening, type TradeAction } from "./swap-model";
import { runWithdraw } from "./withdraw-flow";
import { refreshWalletCoinBalance } from "./use-wallet-coin-balance";

/** How often an open deposit screen reads the wallet again, and for how long at most. */
export const DEPOSIT_POLL_MS = 5_000;
export const DEPOSIT_POLL_LIMIT_MS = 10 * 60_000;

/** Mainnet's node client, loaded at the first withdrawal (its gRPC code stays out of the sheet's load); null when it cannot load. */
const mainnet = () => import("@mysten/sui/grpc").then(({ SuiGrpcClient: Client }) => new Client({ network: "mainnet", baseUrl: SUI_MAINNET_GRPC_URL }), () => null);

function newRequestId(): string {
  return crypto.randomUUID();
}

/** The words for a wallet the sheet cannot sign with (OA-13). */
const WALLET_NOT_READY = "Your Blast wallet is not ready. Reload and try again.";

function initialCoinState(sale: SocialPresaleDetail["presale"] | undefined, trade: TradeAction | undefined) {
  const action = trade ?? (sale ? { side: "buy" as const, coin: {
    coin_type: sale.sale_token, symbol: sale.symbol, name: sale.name,
    decimals: sale.sale_decimals, icon_url: sale.icon_url || null,
    usd_price: sale.price_usd, presale_id: sale.presale_id,
  } } : undefined);
  const opening = action ? tradeOpening(encodeTradeAction(action)) : null;
  return {
    inline: sale !== undefined || trade !== undefined,
    draftOwner: sale?.presale_id ?? trade?.coin.coin_type,
    first: opening?.screen ?? { kind: "dep" } as const,
    coins: opening?.action ? [tradableCoinView(opening.action.coin)] : [],
  };
}

function showsDepositAddress(screen: CoinScreen | null): boolean {
  return screen?.kind === "fund" || screen?.kind === "dep";
}

/** Retain the form's draft while discarding capabilities from its previous visible session. */
function useCoinWalletRead(open: boolean, inline: boolean) {
  const [walletRead, setRead] = useState<Readonly<({ status: "loading" | "error" | "creating"; message?: string } | { status: "ready"; wallet: SocialWallet }) & { owner: string | null }>>({ status: "loading", owner: null });
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open && inline) setRead({ status: "loading", owner: null });
  }
  return [walletRead, setRead] as const;
}

function useCoinSheetState(initial: ReturnType<typeof initialCoinState>, active: boolean, opening?: CoinOpening) {
  const [sheetOpen, setOpen] = useState(false);
  const open = initial.inline ? active : sheetOpen;
  const [walletRead, setRead] = useCoinWalletRead(open, initial.inline);
  const [session, setSession] = useState(0);
  const [first, setFirst] = useState<CoinScreen>(initial.first);
  const [screen, setScreen] = useState<CoinScreen | null>(null);
  const [extraCoins, setExtraCoins] = useState<readonly WalletCoinView[]>(initial.coins);
  const [lastOpening, setLastOpening] = useState<CoinOpening>();

  const show = useCallback((next: CoinScreen, coins?: readonly WalletCoinView[]) => {
    if (coins) setExtraCoins(coins);
    setFirst(next);
    setScreen(next);
    setSession((value) => value + 1);
    setRead((current) => (current.status === "ready" ? current : { status: "loading", owner: null }));
    setOpen(true);
  }, [setRead]);

  if (opening && opening !== lastOpening) {
    setLastOpening(opening);
    show(opening.screen, opening.coins);
  }

  return { open, setOpen, walletRead, setRead, session, first, screen, setScreen, extraCoins, show };
}

function walletReadFor(walletRead: ReturnType<typeof useCoinWalletRead>[0], owner: string | null) {
  return walletRead.owner === owner ? walletRead : { status: "loading" as const };
}

function tradeWallet(read: ReturnType<typeof walletReadFor>, signedIn: boolean) {
  if (!signedIn || read.status !== "ready") return { walletAddress: null, balanceKnown: false };
  return { walletAddress: read.wallet.address, balanceKnown: read.wallet.coins !== null };
}

function useCoinNavigationDraft(
  owner: string | undefined,
  open: boolean,
  signedIn: boolean,
  screen: CoinScreen,
  show: (screen: CoinScreen) => void,
): void {
  useSignInDraft(coinDraftKey("open", owner), open && !signedIn ? { screen: JSON.stringify(screen) } : null, (saved) => {
    const next = parseSavedCoinScreen(saved.screen);
    if (next) show(next);
  });
}

/**
 * The wallet and transaction logic for the shell's coins sheet and inline tickets.
 * It reads the Blast wallet when opened, signs withdrawals and
 * trades with the right wallet (Privy's embedded key, or Slush for a wallet
 * session), toasts the outcome and makes the balances move. A visitor can explore the same forms and quotes; signing requires a session.
 *
 * R3-33: a trade runs R3-31's path (`runTrade`): the server records it
 * (R3-27's log) and builds it over the quote's pinned route before anything
 * is signed; Blast sponsors the fee for an embedded wallet and a wallet
 * session alike (owner ruling 2026-11-20, reversing OA-17), and a wallet
 * session pays its own only for a trade past the day's cap.
 */
export function CoinsHost({ inlineSale, inlineTrade, opening, active = true }: Readonly<{ inlineSale?: SocialPresaleDetail["presale"]; inlineTrade?: TradeAction; opening?: CoinOpening; active?: boolean }>) {
  const { hideSmallBalances } = useShellPrefs();
  const pinnedKeys = JSON.stringify(useCoinPins());
  const viewer = useSocialViewer();
  const accountId = viewer.signedIn ? walletIdentityScope(viewer) : null;
  const walletSession = useRef<AbortController | null>(null);
  const tradeKit = useTradeKit();
  const run = useShellActions();
  const toast = useToast();
  const { explorer } = useDevicePrefs();
  const balances = useBalancesContext();
  const privyMounted = usePrivySessionMounted();
  const privy = useRef<PrivyCoinSigner | null>(null);
  const onPrivy = useCallback((signer: PrivyCoinSigner | null) => {
    privy.current = signer;
  }, []);

  const client = useRef<SuiGrpcClient | null>(null);
  const initial = initialCoinState(inlineSale, inlineTrade);
  const { inline, draftOwner } = initial;
  const { open, setOpen, walletRead, setRead, session, first, screen, setScreen, extraCoins, show } = useCoinSheetState(initial, active, opening);
  const read = walletReadFor(walletRead, accountId);
  /** The withdrawal in flight per request: its id and digest survive a retry of the same ask. */
  const attempt = useRef<{ key: string; requestId: string; digest: string | null } | null>(null);
  const getAccessToken = viewer.getAccessToken;
  const api = useMemo(() => ({ getAccessToken: getAccessToken ?? (async () => null) }), [getAccessToken]);

  // Opening a money form needs the signer. Holdings and their metadata load when the person browses them.
  const queries = useAppQueryClient();
  const { unheldKey, selectedCoin } = useUnheldCoin(open, first, viewer, read, queries);
  const { key: firstKey, mode: listMode } = walletListing(first, screen);
  const listing = useMemo(() => ({ page: 1, hide_small: hideSmallBalances, key: firstKey, keys: pinnedKeys, mode: listMode }), [hideSmallBalances, firstKey, pinnedKeys, listMode]);
  const currentScreen = screen ?? first;
  const identityOnly = currentScreen.kind === "trade" || currentScreen.kind === "wd";
  const readWallet = useCallback(
    async (fresh: boolean, signal?: AbortSignal) => {
      if (signal?.aborted) return null;
      if (identityOnly) {
        const identity = walletIdentityQuery(accountId ?? "", api.getAccessToken);
        return queries.fetchQuery({ ...identity, ...(fresh ? { staleTime: 0 } : {}) }).catch(() => null);
      }
      const query = walletQuery(api.getAccessToken, listing);
      // A shared read started before this return can settle, but cannot supply this session's capabilities.
      if (fresh && queries.getQueryState(query.queryKey)?.fetchStatus === "fetching") {
        await queries.fetchQuery(query).catch(() => null);
      }
      if (signal?.aborted) return null;
      return queries.fetchQuery({ ...query, ...(fresh ? { staleTime: 0 } : {}) }).catch(() => null);
    },
    [accountId, api, identityOnly, queries, listing],
  );

  const load = useCallback(async (signal?: AbortSignal, fresh = false): Promise<SocialWallet | null> => {
    const activeSignal = signal ?? walletSession.current?.signal;
    if (!activeSignal || activeSignal.aborted) return null;
    return readWallet(fresh, activeSignal).then(async (answer) => {
      if (activeSignal.aborted) return null;
      const walletKey = identityOnly
        ? walletIdentityQuery(accountId ?? "", api.getAccessToken).queryKey
        : walletQuery(api.getAccessToken, listing).queryKey;
      if (answer === null) {
        setRead({ status: "error", owner: accountId, message: publicErrorMessage(queries.getQueryState(walletKey)?.error, "Your wallet could not load. Try again.", "service_unavailable") });
        return null;
      }
      let wallet = answer;
      if (wallet.address === null && wallet.signer === "privy" && privy.current) {
        // Sui is an extended chain in Privy: the embedded wallet is created on first use.
        setRead({ status: "creating", owner: accountId });
        try {
          await privy.current.createWallet();
          const again = await readWallet(true, activeSignal);
          if (again !== null) wallet = again;
        } catch {
          // Falls through to the error state below.
        }
      }
      if (activeSignal.aborted) return null;
      if (wallet.address === null || (!identityOnly && wallet.coins === null)) {
        setRead({ status: "error", owner: accountId, message: publicErrorMessage(queries.getQueryState(walletKey)?.error, "Your Blast wallet is not ready. Reload and try again.", "blast_wallet_missing") });
        return null;
      }
      setRead((current) => {
        // Keep previously loaded coin names and prices for the picker and receive side.
        const held = current.status === "ready" && current.owner === accountId && current.wallet.address === wallet.address ? current.wallet : null;
        return { status: "ready", wallet: identityOnly && held?.coins ? { ...wallet, coins: held.coins, listing: held.listing } : wallet, owner: accountId };
      });
      return wallet;
    });
  }, [readWallet, accountId, identityOnly, queries, api, listing, setRead]);

  useCoinNavigationDraft(draftOwner, open, viewer.signedIn, screen ?? first, show);
  // Sign-in updates balances in the existing sheet; it never starts a transaction or resets its inputs.
  useLayoutEffect(() => {
    walletSession.current?.abort();
    if (!open || !viewer.signedIn || viewer.sessionPending || accountId === null) return;
    const controller = new AbortController();
    walletSession.current = controller;
    void load(controller.signal, inline);
    return () => controller.abort();
  }, [open, viewer.signedIn, viewer.sessionPending, accountId, load, inline]);

  // "It shows up here in a few seconds": while a deposit screen is open, read the wallet again and move the balances when a coin grew.
  const depositing = open && viewer.signedIn && !viewer.sessionPending && showsDepositAddress(screen);
  useEffect(() => {
    if (!depositing) return;
    const controller = new AbortController();
    const started = Date.now();
    let before = read.status === "ready" ? walletCoinViews(read.wallet) : null;
    const timer = setInterval(async () => {
      if (Date.now() - started > DEPOSIT_POLL_LIMIT_MS || document.visibilityState !== "visible") return;
      const wallet = await readWallet(true);
      if (controller.signal.aborted || wallet === null || !wallet.coins) return;
      // The first read only seeds the comparison when the sheet had none yet.
      const currentCoins = walletCoinViews(wallet);
      const grew = before !== null && currentCoins.some(coin => coin.atoms > (before?.find(old => old.coinType === coin.coinType)?.atoms ?? BigInt(0)));
      before = currentCoins;
      setRead({ status: "ready", wallet, owner: accountId });
      if (grew) balances.changed();
    }, DEPOSIT_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
    // Starts once per deposit screen; `read` seeds the comparison only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depositing, readWallet, balances.changed, accountId]);

  const sheetWallet = coinSheetWallet(viewer, read, unheldKey !== null && !selectedCoin.data, selectedCoin.isPending, selectedCoin.error);

  const withdraw: CoinSheetProps["onWithdraw"] = async (ask: WithdrawAsk) => {
    if (!viewer.signedIn || viewer.sessionPending || read.status !== "ready") return false;
    const signal = walletSession.current?.signal;
    const wallet = read.wallet;
    const signer = blastWalletSigner(wallet, () => privy.current?.signer() ?? null, walletSessionSigner);
    if (!signer || signer.address !== wallet.address) {
      toast(diagnosticMessage("Your Blast wallet is not ready. Reload and try again.", { code: "blast_wallet_missing" }));
      return false;
    }
    const key = `${accountId}|${signer.address}|${ask.coin.coinType}|${ask.atoms}|${ask.recipient}`;
    if (attempt.current?.key !== key) attempt.current = { key, requestId: newRequestId(), digest: null };
    const current = attempt.current;
    const releaseAttempt = () => {
      if (attempt.current === current) attempt.current = null;
    };
    client.current ??= await mainnet();
    if (client.current === null) {
      releaseAttempt();
      toast("Your withdrawal could not start. Check your connection and try again.");
      return false;
    }
    const result = await runWithdraw(
      {
        api,
        client: client.current,
        signer,
        knownDigest: current.digest,
        onDigest: (digest) => {
          current.digest = digest;
        },
      },
      { requestId: current.requestId, coinType: ask.coin.coinType, atoms: ask.atoms, recipient: ask.recipient },
    );
    if (result.status === "pending") {
      current.digest = result.digest;
      toast(`${diagnosticMessage("Withdrawal is still being confirmed. Retry to check it; this will not send it again.", { code: "execution_unconfirmed" })} Transaction: ${result.digest}.`);
      balances.changed();
      return "pending";
    }
    if (result.status === "failed") {
      toast(result.message);
      if (result.digest) {
        // It reached Sui: whatever happened, the balances may have changed.
        balances.changed();
        releaseAttempt();
      } else if (result.balanceChanged) {
        void refreshWalletCoinBalance(queries, signer.address, ask.coin.coinType);
      }
      return false;
    }
    releaseAttempt();
    const href = explorerTransactionUrl(explorer, result.digest);
    if (!signal?.aborted) setOpen(false);
    toast(`Sent ${coinAmt(ask.coin, ask.amount)}`, {
      sub: `To ${shortAddress(ask.recipient)}`,
      ...(href ? { href, link: `View on ${EXPLORER_NAMES[explorer]}` } : {}),
    });
    balances.changed();
    void load(signal);
    return true;
  };

  // R3-33 on R3-55's one trade path (`useTradeKit().send`, `trade/trade-send.ts`): the signer is picked from the
  // wallet at the press, the trade runs R3-31's `runTrade`, and the kit toasts (the sheet's words), plays the
  // Feel layer's land/error and moves the balances. A fill settles on the button; a pending send closes immediately.
  const runTradeAsk = async (ask: TradeAsk): Promise<TradeOutcome> => {
    if (!viewer.signedIn || viewer.sessionPending || tradeKit === null || read.status !== "ready" || !read.wallet.address || ask.quote.quote_id === null || ask.quote.amount_in === null || ask.quote.min_out === null) {
      return { status: "failed", message: diagnosticMessage(WALLET_NOT_READY, { code: "blast_wallet_missing" }), code: "blast_wallet_missing" };
    }
    const signal = walletSession.current?.signal;
    const result = await tradeKit.send({
      quote: ask.quote,
      coins: { in: ask.inCoin, out: ask.outCoin },
      walletAddress: read.wallet.address,
      acceptFee: ask.acceptFee,
      idempotencyKey: ask.idempotencyKey,
    });
    if (result.status === "fee_required") return result;
    if (result.status === "refused") return { status: "failed", message: result.message, code: result.code };
    if (result.status === "pending" && !signal?.aborted) setOpen(false);
    void load(signal);
    return { status: result.status };
  };

  const requestQuote = useCallback<CoinSheetTrading["requestQuote"]>((body, signal) => requestTradeQuote({ ...api, signal }, body), [api]);
  // A reopened picker shows the catalog it already read (a minute), not a fresh read on every open.
  const listCoins = useCallback<CoinSheetTrading["listCoins"]>(async (query, signal, cursor) => {
    const page = await queries.fetchQuery({
      queryKey: queryKeys.tradeCoins(query, cursor ?? null),
      queryFn: ({ signal: own }) => fetchListedTradeCoins({ q: query, cursor }, own),
      staleTime: 60_000,
      retry: false,
    });
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return { coins: page.coins.map(tradableCoinView), nextCursor: page.next_cursor };
  }, [queries]);
  const trading: CoinSheetTrading = {
    signedIn: viewer.signedIn,
    sessionPending: walletSessionPending(viewer, read.status, accountId),
    ...tradeWallet(read, viewer.signedIn),
    onSignIn: () => {
      run("openSignIn");
    },
    requestQuote,
    findRoute: findBrowserRoute,
    listCoins,
    trade: runTradeAsk,
  };

  const listHoldings = useCallback(async (page: number, search: string, mode: string, signal: AbortSignal) => {
    const result = await queries.fetchQuery(walletQuery(api.getAccessToken, { ...listing, page, q: search, mode }));
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (result.coins === null || !result.listing) throw new Error("Your coins could not load. Try again.");
    return { coins: result.coins.map(coinView), total: result.listing.total, page: result.listing.page };
  }, [api, queries, listing]);

  const copy = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      return true;
    } catch {
      toast(diagnosticMessage("Copying is blocked here. Select the address instead.", { code: "request_failed" }));
      return false;
    }
  };

  return (
    <>
      {privyMounted ? <PrivyCoinSignerBridge onChange={onPrivy} /> : null}
      <CoinSheet
        extraCoins={selectedCoin.data ? [...extraCoins, selectedCoin.data] : extraCoins}
        first={first}
        inline={inline}
        draftKey={coinDraftKey("trade", draftOwner)}
        onClose={() => setOpen(false)}
        onCopy={copy}
        onRetry={() => {
          if (unheldKey !== null) void selectedCoin.refetch();
          setRead({ status: "loading", owner: accountId });
          void load();
        }}
        onScreen={setScreen}
        holdingsOwner={accountId}
        listHoldings={viewer.signedIn ? listHoldings : undefined}
        onWithdraw={withdraw}
        open={open}
        session={session}
        trading={trading}
        wallet={sheetWallet}
      />
    </>
  );
}
function coinSheetWallet(
  viewer: Readonly<{ signedIn: boolean; sessionPending?: boolean }>,
  read: Readonly<{ status: "loading" | "error" | "creating"; message?: string }> | Readonly<{ status: "ready"; wallet: SocialWallet }>,
  missingCoin: boolean,
  coinPending: boolean,
  coinError: unknown,
): CoinSheetWallet {
  if (viewer.sessionPending) return { status: "loading" };
  if (!viewer.signedIn) return { status: "visitor" };
  if (missingCoin) return coinPending ? { status: "loading" } : { status: "error", message: publicErrorMessage(coinError, "This coin could not load. Refresh and try again.", "service_unavailable") };
  if (read.status !== "ready") return read;
  return { status: "ready", address: read.wallet.address!, fee: read.wallet.fee, coins: walletCoinViews(read.wallet), total: read.wallet.listing?.total, value: read.wallet.listing?.value_usd };
}

function useUnheldCoin(open: boolean, first: CoinScreen, viewer: Readonly<{ signedIn: boolean }>, read: Readonly<{ status: "loading" | "error" | "creating"; message?: string }> | Readonly<{ status: "ready"; wallet: SocialWallet }>, queries: ReturnType<typeof useAppQueryClient>) {
  const wallet = viewer.signedIn && read.status === "ready" ? read.wallet : null;
  const unheldKey = open && first.kind === "coin" && !["usdc", "sui"].includes(first.key) && !(wallet && walletCoinViews(wallet).some((coin) => coin.key === first.key)) ? first.key : null;
  // A coin outside any sale is keyed by its type (`0x…::module::NAME`); a sale coin by its presale id.
  const coinType = unheldKey?.includes("::") ? unheldKey : null;
  const saleCoin = useQuery({
    ...presaleDetailQuery(unheldKey ?? ""),
    enabled: unheldKey !== null && coinType === null,
    select: (body) => presaleCoinView(body, unheldKey ?? ""),
  }, queries);
  const typedCoin = useQuery({
    queryKey: queryKeys.tradeCoin(coinType ?? ""),
    queryFn: ({ signal }) => fetchTradeCoins({ q: coinType }, signal),
    enabled: coinType !== null,
    staleTime: PUBLIC_STALE_MS,
    select: (page) => {
      const coin = page.coins.find((each) => each.presale_id === null && each.coin_type === coinType);
      return coin ? tradableCoinView(coin) : null;
    },
  }, queries);
  return { unheldKey, selectedCoin: coinType === null ? saleCoin : typedCoin };
}

function walletSessionPending(viewer: Readonly<{ signedIn: boolean; sessionPending?: boolean }>, status: string, accountId: string | null): boolean {
  return !!viewer.sessionPending || (viewer.signedIn && status !== "ready" && status !== "error" && accountId !== null);
}

function screenKey(screen: CoinScreen | null): string { return screen && "key" in screen ? screen.key : ""; }

function walletListing(first: CoinScreen, screen: CoinScreen | null) {
  const active = screen ?? first;
  const mode = active.kind === "pick" || active.kind === "wd" ? "withdraw" :
    active.kind === "trade" || active.kind === "pickt" ? "swap" : "all";
  return { key: screenKey(active) || screenKey(first), mode };
}
