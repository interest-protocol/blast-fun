"use client";

import { invalidateAfter } from "#web/lib/query/invalidate.ts";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";

import { useFeelSound } from "#web/components/blast-feel/index.ts";
import { useDevicePrefs } from "#web/components/blast-ui/device-prefs.ts";
import { useShellActions } from "#web/components/blast-ui/shell-actions.tsx";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { usePrivySessionMounted } from "#web/components/presale/providers/PrivySessionProvider.tsx";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { SUI_MAINNET_GRPC_URL } from "@blast/core/lib/sui-mainnet.ts";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";

import { useBalancesContext, type Balances } from "../coins/balances";
import { PrivyCoinSignerBridge, type PrivyCoinSigner } from "../coins/signers";
import { quoteWalletQuery } from "../commit/commit-quote";
import { walletIdentityQuery, walletIdentityScope, walletQuery } from "../queries";
import { useSocialViewer } from "../SignInGate";
import { requestTradeQuote } from "../trades/trades-client";
import type { TradeKit, TradeSendResult } from "./trade-kit";
import type { TradeRouteFinder } from "./trade-estimate";
import { walletCoinBalanceQuery } from "../coins/use-wallet-coin-balance";


const loadTradeFlow = () => import("../trades/trade-flow");
/** The send path (the wallet signers, the node client), loaded at the first trade. */
const loadTradeSend = () => Promise.all([import("./trade-send"), import("../commit/commit-signers"), import("@mysten/sui/grpc")]);
/** The browser's route estimate, loaded at the first estimate. */
const findBrowserRoute: TradeRouteFinder = (request) => import("./trade-estimate").then(({ findBrowserRoute: find }) => find(request));

/**
 * The shell's trade host (R3-55; the commit dialog's host is the model,
 * `commit/CommitHost.tsx`): the one `TradeKit` every trade surface runs,
 * handed down through `FeedOverlaysProvider` (`useTradeKit()`).
 *
 * - `quote` is R3-30's route through the session helper (`callSocialApi`:
 *   the Privy token or the wallet session's cookie, never a hand-built
 *   header, OA-16). A visitor may quote; the answer is shown, not offered.
 * - `wallet` is the Blast wallet read (`GET /api/social/me/wallet`), shared
 *   by every surface for a few seconds and read again once balances move.
 * - `send` is R3-31's `runTrade`, with the signer read at the press from that
 *   wallet: an embedded Blast wallet signs with Privy's key, a wallet session
 *   signs in Slush, and Blast's gas pool pays for both within the day's cap
 *   (owner ruling 2026-11-20, reversing OA-17); where the server answers
 *   wallet-pays, the wallet session pays its own fee. It plays the Feel layer's `land` on
 *   a fill and `error` on a refusal (FEEL-LAYER.md: the gate wraps
 *   `executeTrade` with `land`), toasts `Traded 100 USDC for 47,566 KSTL`
 *   with the route and the viewer's explorer, and moves the balances.
 *
 * Trading is not gated on the presale deployment: the route builds and the
 * wallet pays when Blast cannot sponsor (R3-31's `sponsorship_unavailable`).
 * The flow, the signers and the node client are imported when a trade
 * runs, so the SDK, the wallet kit and the transaction builder stay out of
 * a page's first load.
 */

/** How long one wallet read serves every surface (a fresh balance after a trade is asked for explicitly). */
export const TRADE_WALLET_MAX_AGE_MS = 5_000;

export type TradeHostOptions = Readonly<{
  /** The shell's balances (it calls this hook above its own `BalancesProvider`). */
  balances?: Balances;
}>;

export type TradeHostValue = Readonly<{ tradeKit: TradeKit; node: ReactNode }>;

export function useTradeHost({ balances: shellBalances }: TradeHostOptions = {}): TradeHostValue {
  const viewer = useSocialViewer();
  const run = useShellActions();
  const toast = useToast();
  const { explorer } = useDevicePrefs();
  const feel = useFeelSound();
  const contextBalances = useBalancesContext();
  const balances = shellBalances ?? contextBalances;
  const privyMounted = usePrivySessionMounted();
  const privy = useRef<PrivyCoinSigner | null>(null);
  const onPrivy = useCallback((signer: PrivyCoinSigner | null) => {
    privy.current = signer;
  }, []);
  const client = useRef<SuiGrpcClient | null>(null);
  const getAccessToken = viewer.getAccessToken;
  const api = useMemo(() => ({ getAccessToken: getAccessToken ?? (async () => null) }), [getAccessToken]);
  const signedIn = viewer.signedIn;
  const viewerKey = walletIdentityScope(viewer);
  // A panel can disappear and return while the same quote is still executing.
  const submitted = useRef(new Map<string, Promise<TradeSendResult>>()).current;

  // One wallet read per few seconds for every surface: the shared `/me/wallet` entry (OA-38). A deposit
  // landing, a withdrawal or a trade going out (the balances moving) marks it stale, so no surface reads
  // the balance from before it moved; a failed read is not kept.
  const queries = useAppQueryClient();
  const walletReads = useMemo(() => {
    const query = quoteWalletQuery(walletQuery(api.getAccessToken), TRADE_WALLET_MAX_AGE_MS);
    return {
      get: () => queries.fetchQuery(query).catch(() => null),
      clear: () => void invalidateAfter(queries, { kind: "wallet-stale" }),
    };
  }, [api, queries]);
  const balancesVersion = balances.version;
  const seenVersion = useRef(balancesVersion);
  useEffect(() => {
    if (seenVersion.current === balancesVersion) return;
    seenVersion.current = balancesVersion;
    walletReads.clear();
  }, [balancesVersion, walletReads]);

  // The kit's send runs with the shell as it is at the call.
  const readyViewer = signedIn && !viewer.sessionPending ? viewerKey : null;
  const latest = useRef({ toast, explorer, feel, balances, readyViewer });
  useLayoutEffect(() => {
    latest.current = { toast, explorer, feel, balances, readyViewer };
  }, [toast, explorer, feel, balances, readyViewer]);

  const tradeKit = useMemo<TradeKit>(
    () => ({
      signedIn,
      signIn: () => run("openSignIn"),
      async quote(request, signal) {
        const answer = await requestTradeQuote(signal === undefined ? api : { ...api, signal }, request);
        return answer.status === "ok" ? { status: "ok", quote: answer.body } : answer;
      },
      route: findBrowserRoute,
      wallet: () => (signedIn ? walletReads.get() : Promise.resolve(null)),
      send(input) {
        if (readyViewer === null || readyViewer !== latest.current.readyViewer) return Promise.resolve({ status: "refused" as const, code: "sign_in", message: "Sign in before trading." });
        const quoteId = input.quote.quote_id === null ? null : `${viewerKey}:${input.quote.quote_id}`;
        const existing = quoteId === null ? undefined : submitted.get(quoteId);
        if (existing) return existing;
        const shell = latest.current;
        const outcome = loadTradeSend().then(([{ sendTrade }, { walletCommitSigner }, { SuiGrpcClient }]) => sendTrade(
          {
            api,
            client: () => {
              if (client.current === null) client.current = new SuiGrpcClient({ network: "mainnet", baseUrl: SUI_MAINNET_GRPC_URL });
              return client.current;
            },
            wallet: async () => {
              const wallet = await queries.fetchQuery(walletIdentityQuery(readyViewer, api.getAccessToken)).catch(() => null);
              return readyViewer === latest.current.readyViewer ? wallet : null;
            },
            suiBalance: (address) => queries.fetchQuery({ ...walletCoinBalanceQuery(address, SUI_COIN_TYPE, api.getAccessToken), staleTime: 0 }).then((balance) => balance.atoms, () => null),
            // The withdraw sheet's embedded signer signs bytes and executes nothing: the sponsored arm.
            embedded: () => {
              const embedded = privy.current?.signer() ?? null;
              return embedded?.fee === "sponsored" ? embedded : null;
            },
            walletSigner: walletCommitSigner,
            flow: () => loadTradeFlow(),
            key: () => crypto.randomUUID(),
            play: (cue) => shell.feel.play(cue),
            toast: shell.toast,
            explorer: shell.explorer,
            moved: () => {
              walletReads.clear();
              shell.balances.changed();
            },
          },
          input,
        ), (): TradeSendResult => {
          // Nothing was sent: the code did not load, so the same quote may be pressed again.
          shell.feel.play({ kind: "error" });
          return { status: "refused", code: null, message: "The trade could not start. Check your connection and try again." };
        });
        if (quoteId !== null) {
          submitted.set(quoteId, outcome);
          void outcome.then((result) => {
            // A real refusal or fee offer can be explicitly submitted again.
            if (result.status === "refused" || result.status === "fee_required") submitted.delete(quoteId);
          }, () => { /* An unknown result must not re-arm this quote. */ });
        }
        return outcome;
      },
    }),
    [api, queries, readyViewer, run, signedIn, submitted, viewerKey, walletReads],
  );

  const node = privyMounted ? <PrivyCoinSignerBridge onChange={onPrivy} /> : null;
  return { tradeKit, node };
}
