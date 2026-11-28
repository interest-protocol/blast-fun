"use client";


import { diagnosticMessage } from "#web/lib/errors.ts";

import type { AllowlistProof } from "@interest-protocol/blast-sdk/presale";
import type { QueryClient } from "@tanstack/react-query";
import { unwrapApiResult } from "#web/lib/query/client.ts";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { useDevicePrefs } from "#web/components/blast-ui/device-prefs.ts";
import { EXPLORER_NAMES, explorerTransactionUrl } from "@blast/core/lib/explorer.ts";
import { useFeelSound } from "#web/components/blast-feel/index.ts";
import { useShellActions } from "#web/components/blast-ui/shell-actions.tsx";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { PersonAvatar } from "#web/components/social/PersonAvatar.tsx";
import { usePrivySessionMounted } from "#web/components/presale/providers/PrivySessionProvider.tsx";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { SocialWallet } from "@blast/core/web/contracts/coins.ts";
import { commitBlockers, type CommitBlocker } from "@blast/core/web/contracts/commit.ts";
import type { FeedItem } from "@blast/core/web/contracts/items.ts";
import type { SocialPresaleViewerEntry } from "@blast/core/web/contracts/presales.ts";
import type { SocialApiOptions } from "#web/components/social/social-api.ts";
import type { SponsoredSigner } from "#web/components/social/sponsored-transaction.ts";

import { useBalancesContext, type Balances } from "../coins/balances";
import { PrivyCoinSignerBridge, type PrivyCoinSigner } from "../coins/signers";
import { refreshWalletCoinBalance, walletCoinBalanceReader } from "../coins/use-wallet-coin-balance";
import { fetchTradeCoins } from "../coins/swap-client";
import { tradableCoinView } from "../coins/swap-model";
import { allowlistLeafQuery, presaleViewerQuery, settingsQuery, walletIdentityQuery, walletIdentityScope } from "../queries";
import type { FeedOverlays } from "../feed-ui/shell-bridge";
import { useSignInDraft } from "../sign-in-draft";
import { useSocialViewer, type SocialViewer } from "../SignInGate";
import { useViewerFollow, useViewerStateStore } from "../ViewerState";
import { useSocialAccount } from "../use-social-account";
import { useCommitClock } from "./commit-clock";
import type { CommitFacts, CommitKit } from "./commit-kit";
import { createCommitQuotes } from "./commit-quote";
import { contributionReceipt, type ContributionReceipt } from "./commit-receipt";
import { CommitDialog, SaleDialog, type SaleDialogProps } from "./CommitDialog";
import type { CommitBlastInput, CommitPanelProps } from "./CommitPanel";
import { fetchCommitSale } from "./commit-client";
import { commitFactsAt, allowlistLeafOf, publicBuyActive, commitSaleOf, commitViewerOf, quoteCoinOf, sourceThroughName, type CommitSaleRead } from "./commit-view";
import type { CommitPhase, CommitSigner } from "./commit-flow";
import { blastWalletSigner } from "./commit-signers";

import { requestTradeQuote } from "../trades/trades-client";

const loadCommitRun = () => import("./commit-run");

/**
 * The commit and sale dialogs under the app shell (OA-7: "Blast" opens a
 * dialog, superseding T-028's inline panel and AC-091).
 *
 * `useCommitHost()` gives the shell two things: the `FeedOverlays` value to
 * provide around the page (so every post's "Blast" and "View presale"
 * become buttons that open a dialog instead of links to the sale page), and
 * the node to mount in the shell's overlay slot.
 *
 * What it does on open: reads the sale (`GET /api/social/presales/{id}`), the
 * Blast wallet (`GET /api/social/me/wallet`) and — for an allowlisted sale —
 * the viewer's allowlist leaf, then shows the panel. A visitor gets the
 * same public form and sale dialog; only private reads and signing require a session.
 *
 * What it does on a blast: has the server build the commit
 * (`POST /api/social/me/commits`, which holds the presale deployment), has it
 * signed, registers the intent between the digest and the execute (T-024),
 * toasts the result with the viewer's own explorer, and makes the balances
 * move.
 *
 * **Signing stays gated.** `presaleDeployed` comes from the server's
 * `PRESALE_DEPLOYMENT_MANIFEST` read; while it is false, `commitBlockers`
 * answers `presale_not_deployed`, the panel's note says when blasting opens,
 * the primary button is disabled, and `runCommit` refuses before it builds
 * anything. Exactly as Create's publishing is gated.
 */


type SaleState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "ready"; detail: CommitSaleRead }>;

type Dialog =
  | Readonly<{ kind: "none" }>
  | Readonly<{
    kind: "commit";
    presaleId: string;
    /** The post "Blast" was pressed on; null from the sale page. */
    source: FeedItem | null;
    /** The entry the intent credits: the post's, or a sale page's `via=`. */
    sourceEntryId: string | null;
  }>
  | Readonly<{ kind: "sale"; presaleId: string }>
  | Readonly<{ kind: "confirmed" | "closed"; presaleId: string; receipt: ContributionReceipt | null; detail: CommitSaleRead; sale: NonNullable<ReturnType<typeof commitSaleOf>> }>;

function dialogSnapshot(dialog: Dialog) {
  return dialog.kind === "confirmed" || dialog.kind === "closed" ? dialog : null;
}

function commitNavigation(dialog: Dialog): Readonly<Record<string, string>> | null {
  if (dialog.kind === "none" || dialog.kind === "confirmed" || dialog.kind === "closed") return null;
  return { presaleId: dialog.presaleId, sourceEntryId: dialog.kind === "commit" ? dialog.sourceEntryId ?? "" : "" };
}

/**
 * What the viewer brings to one sale beyond their balances: their own
 * position (it counts against the wallet cap) and, for an allowlisted sale,
 * their leaf — its cap for the panel and its proof for the transaction.
 */
type ViewerFacts = Readonly<{
  entry: SocialPresaleViewerEntry | null;
  allowlist: Readonly<{ on: boolean; cap: number | null }> | null;
  proof: AllowlistProof | null;
  allowlistUnreadable: boolean;
}>;

const NO_FACTS: ViewerFacts = Object.freeze({ entry: null, allowlist: null, proof: null, allowlistUnreadable: false });

/** How long one answer serves every quote, dialog and panel asking at once: a burst shares one read, a later ask reads again. */
const SHARED_READ_MS = 5_000;

/** One sale, as the dialogs read it, shared by every reader in the same burst; a failed answer is never reused. */
function sharedCommitSale(queries: QueryClient, api: SocialApiOptions, presaleId: string) {
  return queries.fetchQuery({
    queryKey: [...queryKeys.presales.detail(presaleId), "commit"],
    queryFn: ({ signal }) => fetchCommitSale({ ...api, signal }, presaleId),
    staleTime: (query) => (query.state.data?.status === "ok" ? SHARED_READ_MS : 0),
  });
}

/** The viewer's own position in one sale, from the sale page's own viewer read when it is fresh; null when none or unreadable. */
function sharedViewerEntry(queries: QueryClient, api: SocialApiOptions, presaleId: string): Promise<SocialPresaleViewerEntry | null> {
  return queries
    .fetchQuery({ ...presaleViewerQuery(api.getAccessToken, [presaleId]), staleTime: SHARED_READ_MS, retry: false })
    .then((read) => read.presales[presaleId] ?? null, () => null);
}

/**
 * Reads the viewer's facts about one sale, in parallel. A position that cannot
 * be read counts as none (the chain still enforces the cap; the panel just
 * cannot warn first). An allowlist leaf: "not on the list" is a state of the
 * panel; anything else means the list could not be read at all, which is a
 * blocker, not a refusal.
 */
async function readViewerFacts(queries: QueryClient, api: SocialApiOptions, detail: CommitSaleRead, address: string | null): Promise<ViewerFacts> {
  const presaleId = detail.presale.presale_id;
  const quoteCoin = quoteCoinOf(detail.presale.quote_symbol);
  const needsLeaf = detail.presale.allowlisted && !publicBuyActive(detail, Date.now());
  const [entry, leaf] = await Promise.all([
    sharedViewerEntry(queries, api, presaleId),
    // A cancelled shared read (sign-out, unmount) rejects; it reads as the failure the direct call returned.
    needsLeaf && address
      ? queries.fetchQuery(allowlistLeafQuery(api.getAccessToken, presaleId, address)).catch(() => ({ status: "error", code: "request_cancelled" }) as const)
      : Promise.resolve(null),
  ]);
  if (!needsLeaf || !address || leaf === null) return { ...NO_FACTS, entry };
  if (leaf.status === "ok" && quoteCoin) {
    const parsed = allowlistLeafOf(leaf.body, address, quoteCoin, detail.presale.quote_decimals);
    if (parsed) return { entry, allowlist: { on: true, cap: parsed.cap }, proof: parsed.proof, allowlistUnreadable: false };
  }
  if (leaf.status === "refused" && leaf.code === "not_eligible") return { ...NO_FACTS, entry, allowlist: { on: false, cap: null } };
  return { ...NO_FACTS, entry, allowlistUnreadable: true };
}

export type CommitHostOptions = Readonly<{
  /** The server's manifest read: a mainnet presale deployment exists. */
  presaleDeployed: boolean;
  /**
   * The shell's balances, so a commit makes them move. The shell calls this
   * hook above its own `BalancesProvider`, where the context is still the
   * inert default, so it passes them in.
   */
  balances?: Balances;
}>;

export type CommitHostValue = Readonly<{ overlays: FeedOverlays; node: ReactNode }>;

export function useCommitHost({ presaleDeployed, balances: shellBalances }: CommitHostOptions): CommitHostValue {
  const viewer = useSocialViewer();
  const { account } = useSocialAccount();
  const run = useShellActions();
  const toast = useToast();
  const { explorer } = useDevicePrefs();
  const contextBalances = useBalancesContext();
  const balances = shellBalances ?? contextBalances;
  const privyMounted = usePrivySessionMounted();
  const feel = useFeelSound();
  const privy = useRef<PrivyCoinSigner | null>(null);
  const onPrivy = useCallback((signer: PrivyCoinSigner | null) => {
    privy.current = signer;
  }, []);
  const [dialog, updateDialog] = useState<Dialog>({ kind: "none" });
  const currentDialog = useRef(dialog);
  const reopening = useRef<Dialog | null>(null);
  const setDialog = useCallback((next: Dialog) => {
    currentDialog.current = next;
    updateDialog(next);
  }, []);
  useEffect(() => () => { currentDialog.current = { kind: "none" }; }, []);
  const sending = useRef(false);
  const confirmed = useRef(new Set<string>());
  const dialogSaleId = dialog.kind === "none" ? null : dialog.presaleId;
  const getAccessToken = viewer.getAccessToken;
  const api = useMemo(() => ({ getAccessToken: getAccessToken ?? (async () => null) }), [getAccessToken]);
  const queries = useAppQueryClient();
  const walletScope = walletIdentityScope(viewer);
  const readIdentity = useCallback(() => queries.fetchQuery(walletIdentityQuery(walletScope, api.getAccessToken)).catch(() => null),
    [api, queries, walletScope]);
  const { sale, wallet, facts, walletCoinsState } = useCommitDialogRead(dialogSaleId, api, queries, viewer, readIdentity);
  // Read only by the open dialog, so with none open the app shell has no clock redrawing it.
  const nowMs = useCommitClock(dialog.kind !== "none");

  const openCommit = useCallback(
    (item: FeedItem) => {
      if (!item.presale) return;
      setDialog({ kind: "commit", presaleId: item.presale.presale_id, source: item, sourceEntryId: item.entry_id });
    },
    [setDialog],
  );

  /** The sale page's "Blast in": the commit dialog with no post in hand, crediting `via=` when the page has one. */
  const openCommitTo = useCallback(
    (presaleId: string, sourceEntryId: string | null) => {
      setDialog({ kind: "commit", presaleId, source: null, sourceEntryId });
    },
    [setDialog],
  );

  const openSale = useCallback(
    (presaleId: string) => {
      // The reference's own `openSale`: an open sale goes straight to the
      // commit dialog, every other state to the sale dialog.
      setDialog({ kind: "sale", presaleId });
    },
    [setDialog],
  );

  useSignInDraft("commit:open", !viewer.signedIn ? commitNavigation(dialog) : null, (saved) => {
    if (saved.presaleId) setDialog({ kind: "commit", presaleId: saved.presaleId, source: null, sourceEntryId: saved.sourceEntryId || null });
  });

  const { detail, commitSale, commitViewer, blockers, through, throughName } = useCommitReadView(sale, wallet, facts, presaleDeployed, dialog, viewer.callsign, nowMs);
  const snapshot = dialogSnapshot(dialog);
  const { detail: displayedDetail, sale: displayedSale, receipt } = snapshot ?? { detail, sale: commitSale, receipt: null };
  const reopen = () => { if (dialog.kind === "closed" && reopening.current) setDialog(reopening.current); };
  const close = () => {
    reopening.current = dialog;
    if (displayedDetail && displayedSale) setDialog({ kind: "closed", presaleId: displayedDetail.presale.presale_id, receipt, detail: displayedDetail, sale: displayedSale });
    else setDialog({ kind: "none" });
  };
  const closed = () => {
    if (dialog.kind === "closed" && currentDialog.current === dialog) setDialog({ kind: "none" });
  };

  const blastWith: ReturnType<typeof createCommitSender> = (...args) => {
    if (sending.current) return Promise.resolve({ ok: false, message: diagnosticMessage("A contribution is already pending. Check your wallet before trying again.", { code: "execution_unconfirmed" }) });
    sending.current = true;
    return createCommitSender({ api, privy, feel, explorer, toast, balances, queries, confirmed })(...args)
      .finally(() => { sending.current = false; });
  };

  /** The dialog's own blast: the sale it is showing, and the item it was opened from. */
  const blast: CommitPanelProps["onBlast"] = (input, onPhase) => {
    if (!viewer.signedIn || viewer.sessionPending || !detail || !commitSale) {
      return Promise.resolve({ ok: false, message: diagnosticMessage("This sale could not be read. Close this and try again.", { code: "service_unavailable" }) });
    }
    return blastWith(commitSale, input, dialog.kind === "commit" ? dialog.sourceEntryId : null, facts.proof, throughName, {
      wallet,
      blockers,
      onPhase,
      onConfirmed(receipt) {
        if (currentDialog.current !== dialog) return;
        setDialog({ kind: "confirmed", presaleId: receipt.presaleId, receipt, detail, sale: commitSale });
      },
    });
  };

  /*
   * The kit (R3-54): Blast mode's composer and quick blast commit through this
   * host without opening the dialog, and so does hold to blast on every Blast
   * button (R3-13, `use-held-blast.ts`), crediting the post it came through. Its quote reads the same facts the
   * dialog reads when it opens — the sale, the Blast wallet, the viewer's own
   * position and, for an allowlisted sale, their leaf — and its send is
   * `blastWith`, so nothing about the commit itself is new.
   */
  const quoteSignedIn = viewer.signedIn;
  const readQuote = useCallback(async (presaleId: string, signal: AbortSignal): Promise<CommitFacts | null> => {
    const signedIn = quoteSignedIn;
    const [read, quoteWallet] = await Promise.all([
      sharedCommitSale(queries, api, presaleId),
      signedIn ? readIdentity() : Promise.resolve(null),
    ]);
    const detail = unwrapApiResult(read);
    if (detail.presale.presale_id !== presaleId) return null;
    const quoteSale = commitSaleOf(detail, { suiUsd: null });
    const own = signedIn ? await readViewerFacts(queries, { ...api, signal }, detail, quoteWallet?.address ?? null) : NO_FACTS;
    return commitFactsAt({
      detail,
      sale: quoteSale,
      viewer: commitViewerOf({ wallet: quoteWallet, sale: quoteSale, entry: own.entry, allowlist: own.allowlist }),
      blockers: commitBlockers({
        deployed: presaleDeployed,
        wallet: quoteWallet?.address ?? null,
        allowlistUnreadable: own.allowlistUnreadable,
      }),
      proof: own.proof,
      wallet: quoteWallet,
    }, Date.now());
  }, [api, presaleDeployed, quoteSignedIn, readIdentity, queries]);
  // The kit's send runs the host's blast as it is at the call, not as it was when the kit was made.
  const blastRef = useRef(blastWith);
  useEffect(() => {
    blastRef.current = blastWith;
  });
  // One quote source per viewer, its answers keyed by that viewer: a sign-in or a sign-out drops every cached answer.
  const quotes = useMemo(() => createCommitQuotes<CommitFacts>({ read: readQuote, client: queries, viewer: walletScope }), [queries, readQuote, walletScope]);
  useEffect(() => () => quotes.dispose(), [quotes]);
  const accountId = account?.account_id;
  const kit = useMemo<CommitKit>(
    () => ({
      signedIn: viewer.signedIn,
      holdCoin: {
        peek: () => queries.getQueryData(settingsQuery(api.getAccessToken, accountId).queryKey)?.commit_too_coin_type,
        read: async () => (await queries.fetchQuery(settingsQuery(api.getAccessToken, accountId))).commit_too_coin_type,
      },
      signIn: () => run("openSignIn"),
      deposit: () => run("openDeposit"),
      quotes,
      inputBalance: walletCoinBalanceReader(queries, api.getAccessToken),
      paymentCoin: {
        peek: (type) => {
          const state = queries.getQueryState<Awaited<ReturnType<typeof fetchTradeCoins>>>(queryKeys.tradeCoins(type, null));
          return state && Date.now() - state.dataUpdatedAt < SHARED_READ_MS ? paymentCoinOf(state.data, type) : null;
        },
        read: async (type) => {
          const page = await queries.fetchQuery({
            queryKey: queryKeys.tradeCoins(type, null),
            queryFn: ({ signal }) => fetchTradeCoins({ q: type }, signal),
            staleTime: SHARED_READ_MS,
            retry: false,
          });
          return paymentCoinOf(page, type);
        },
      },
      quotePayment: (body, signal) => requestTradeQuote({ ...api, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) }, body),
      async send(cached, input, options) {
        const facts = commitFactsAt(cached, Date.now());
        if (!viewer.signedIn || viewer.sessionPending) return { status: "refused", message: diagnosticMessage("Sign in before blasting.", { code: "unauthorized" }) };
        if (facts.sale === null) return { status: "refused", message: diagnosticMessage("This sale could not be read. Nothing was sent.", { code: "service_unavailable" }) };
        const source = options?.source ?? null;
        const sent = await blastRef.current(facts.sale, input, source?.entryId ?? null, facts.proof, source?.through ?? null, {
          wallet: facts.wallet,
          blockers: facts.blockers,
          onPhase: options?.onPhase,
          onConfirmed: options?.onConfirmed,
        });
        if (!sent.ok) return { status: "refused", message: sent.message ?? null };
        return sent.pending ? { status: "pending", digest: sent.digest, message: sent.pending } : { status: "sent", digest: sent.digest };
      },
    }),
    [accountId, api, queries, quotes, run, viewer.signedIn, viewer.sessionPending],
  );

  const overlays = useMemo<FeedOverlays>(
    () => ({ openCommit, openSale, openCommitTo, commitKit: kit }),
    [kit, openCommit, openCommitTo, openSale],
  );

  const openDeposit = () => {
    close();
    run("openDeposit");
  };

  const commitOpen = isCommitOpen(dialog, detail);
  const saleOpen = dialog.kind === "sale" && !commitOpen;
  // "7 you follow": the followed backers the viewer read returns (at most 100).
  const followedCount = facts.entry?.following.length ?? 0;

  const node = (
    <>
      {privyMounted ? <PrivyCoinSignerBridge onChange={onPrivy} /> : null}
      {displayedDetail && displayedSale ? (
        <CommitDialog
          key={`commit:${displayedDetail.presale.presale_id}`}
          onRequestOpen={reopen}
          blockers={blockers}
          detail={displayedDetail}
          receipt={receipt}
          onClosed={closed}
          nowMs={nowMs}
          onBlast={blast}
          onDeposit={openDeposit}
          onRequestClose={close}
          open={commitOpen}
          followed={followedCount}
          sale={displayedSale}
          through={through}
          viewer={commitViewer}
          walletAddress={wallet?.address}
          walletCoinsState={walletCoinsState}
          walletFee={wallet?.fee}
        />
      ) : null}
      {displayedDetail ? (
        <NotifyingSaleDialog key={`sale:${displayedDetail.presale.presale_id}`} onClosed={closed} detail={displayedDetail} followed={followedCount} nowMs={nowMs} onRequestClose={close} open={saleOpen} />
      ) : null}
    </>
  );

  return { overlays, node };
}

function paymentCoinOf(page: Awaited<ReturnType<typeof fetchTradeCoins>> | undefined, coinType: string) {
  const found = page?.coins.find((coin) => coin.coin_type === coinType);
  return found ? tradableCoinView(found) : null;
}

/**
 * The sale dialog with its "Notify me" (§11, a pending sale): the presale
 * follow every other surface uses (`setFollowing` on the viewer-state store),
 * so the sale page's own bell and this button are one state. A visitor gets
 * the sign-in sheet.
 */
function NotifyingSaleDialog(props: Omit<SaleDialogProps, "notify">) {
  const sale = props.detail.presale;
  const viewer = useSocialViewer();
  const run = useShellActions();
  const store = useViewerStateStore();
  const target = useMemo(() => ({ kind: "presale", presale_id: sale.presale_id }) as const, [sale.presale_id]);
  const on = useViewerFollow(target) === true;
  const toggle = async () => {
    if (!viewer.signedIn) {
      run("openSignIn");
      return;
    }
    await store?.setFollowing(target, !on);
  };
  return <SaleDialog {...props} notify={{ on, toggle: () => void toggle() }} />;
}

function signerForWallet(wallet: SocialWallet | null, readEmbedded: () => CommitSigner | null): SponsoredSigner | null {
  return blastWalletSigner(wallet, readEmbedded);
}

function createCommitSender({ api, privy, feel, explorer, toast, balances, queries, confirmed }: Readonly<{
  api: SocialApiOptions;
  privy: RefObject<PrivyCoinSigner | null>;
  feel: ReturnType<typeof useFeelSound>;
  explorer: ReturnType<typeof useDevicePrefs>["explorer"];
  confirmed: RefObject<Set<string>>;
  toast: ReturnType<typeof useToast>;
  balances: Balances;
  queries: QueryClient;
}>) {
  const showConfirmation = (receipt: ContributionReceipt, onConfirmed: ((receipt: ContributionReceipt) => void) | undefined, through: string | null) => {
    // Once execution succeeds, feedback must never make it look retryable.
    try { onConfirmed?.(receipt); } catch { /* The toast still confirms this contribution. */ }
    try {
      toast("Contribution confirmed", {
        sub: `${receipt.amount} ${receipt.currency} to the ${receipt.symbol} presale${through ? ` · through ${through}’s post` : ""}`,
        href: receipt.href ?? undefined, link: `View on ${EXPLORER_NAMES[explorer]}`,
      });
      feel.play({ kind: "land" });
    } catch { /* The confirmed transaction remains successful. */ }
  };
  return async (
    target: NonNullable<ReturnType<typeof commitSaleOf>>,
    input: CommitBlastInput,
    sourceEntryId: string | null,
    proof: AllowlistProof | null,
    /** The toast's "through <name>'s post": the post this blast came through, when it names someone. */
    through: string | null,
    /**
     * The wallet and the blockers this blast is judged by: the dialog's own
     * reads, a held post's, or a Blast-mode quote's (R3-54). Passed, never
     * taken from whichever sale the dialog last read.
     */
    from: Readonly<{ wallet: SocialWallet | null; blockers: readonly CommitBlocker[]; onPhase?: (phase: CommitPhase) => void; onConfirmed?: (receipt: ContributionReceipt) => void }>,
  ): Promise<Readonly<{ ok: true; digest: string; pending?: string } | { ok: false; message?: string }>> => {
    const wallet = from.wallet;
    const address = wallet?.address ?? null;
    // The embedded wallet's signer is the withdraw sheet's, which signs bytes
    // and executes nothing: exactly the sponsored arm of `CommitSigner`, the only one a commit takes.
    const readEmbedded = () => privy.current?.signer() ?? null;
    const signer = signerForWallet(wallet, readEmbedded);
    if (!signer || !address || signer.address !== address) {
      feel.play({ kind: "error" });
      return { ok: false, message: diagnosticMessage("Your Blast wallet is not ready. Reload and try again.", { code: "blast_wallet_missing" }) };
    }
    const { runCommitFor } = await loadCommitRun();
    const result = await runCommitFor({
      api,
      signer,
      blockers:
        input.payWith === target.quoteCoin ? from.blockers : [...from.blockers, "swap_unavailable" as const],
      sale: target,
      input,
      sourceEntryId,
      allowlist: proof,
      onPhase: from.onPhase,
    });
    if (result.status === "pending") {
      try { toast("Contribution pending", { sub: result.message, href: explorerTransactionUrl(explorer, result.digest) ?? undefined, link: `View on ${EXPLORER_NAMES[explorer]}` }); } catch { /* Recovery remains pending if feedback is unavailable. */ }
      void Promise.resolve().then(() => balances.changed({ kind: "commit", presaleId: target.presaleId })).catch(() => {});
      return { ok: true, digest: result.digest, pending: result.message };
    }
    if (result.status !== "sent") {
      if (result.status === "failed" && result.code === "insufficient_balance") {
        void refreshWalletCoinBalance(queries, address);
      }
      feel.play({ kind: "error" });
      return { ok: false, message: result.status === "blocked" ? undefined : result.message };
    }
    if (confirmed.current.has(result.digest)) return { ok: true, digest: result.digest };
    confirmed.current.add(result.digest);
    const href = explorerTransactionUrl(explorer, result.digest);
    const receipt = contributionReceipt(target, result.amount, result.digest, href);
    showConfirmation(receipt, from.onConfirmed, sourceEntryId === null ? null : through);
    void Promise.resolve().then(() => balances.changed({ kind: "commit", presaleId: target.presaleId })).catch(() => {});
    return { ok: true, digest: result.digest };
  };
}

function useCommitReadView(sale: SaleState, wallet: SocialWallet | null, facts: ViewerFacts, presaleDeployed: boolean, dialog: Dialog, callsign: string | null, nowMs: number) {
  const detail = sale.status === "ready" ? sale.detail : null;
  const commitSale = useMemo(() => (detail ? commitSaleOf(detail, { suiUsd: null }, nowMs) : null), [detail, nowMs]);
  const commitViewer = useMemo(
    () => commitViewerOf({ wallet, sale: commitSale, entry: facts.entry, allowlist: facts.allowlist }),
    [commitSale, facts.allowlist, facts.entry, wallet],
  );
  const blockers = useMemo<readonly CommitBlocker[]>(
    () => commitBlockers({ deployed: presaleDeployed, wallet: wallet?.address ?? null, allowlistUnreadable: !!commitSale?.allowlisted && facts.allowlistUnreadable }),
    [commitSale?.allowlisted, facts.allowlistUnreadable, presaleDeployed, wallet?.address],
  );

  const source = dialog.kind === "commit" ? dialog.source : null;
  const throughName = sourceThroughName(source, callsign);
  const sourceActor = source?.actor;
  const through =
    throughName && sourceActor?.type === "account"
      ? {
        name: throughName,
        avatar: (
          <PersonAvatar
            person={{ callsign: sourceActor.callsign, avatar_url: sourceActor.avatar_url }}
            size={26}
          />
        ),
      }
      : null;

  return { detail, commitSale, commitViewer, blockers, through, throughName };
}

function useCommitDialogRead(dialogSaleId: string | null, api: SocialApiOptions, queries: QueryClient, viewer: SocialViewer, readIdentity: () => Promise<SocialWallet | null>) {
  const scope = viewer.signedIn && !viewer.sessionPending ? walletIdentityScope(viewer) : null;
  const [saleRead, setSaleRead] = useState<Readonly<{ presaleId: string; state: SaleState }> | null>(null);
  const [privateRead, setPrivateRead] = useState<Readonly<{ scope: string; presaleId: string; wallet: SocialWallet | null; facts: ViewerFacts }> | null>(null);
  useEffect(() => {
    if (!dialogSaleId) return;
    const controller = new AbortController();
    const signal = controller.signal;
    let cancelled = false;
    void (async () => {
      const pendingWallet = scope === null ? null : readIdentity();
      const read = await sharedCommitSale(queries, api, dialogSaleId);
      if (cancelled) return;
      if (read.status !== "ok") {
        setSaleRead({ presaleId: dialogSaleId, state: { status: "error" } });
        return;
      }
      setSaleRead({ presaleId: dialogSaleId, state: { status: "ready", detail: read.body } });
      if (scope === null) return;
      const walletRead = await pendingWallet;
      const nextFacts = await readViewerFacts(queries, { ...api, signal }, read.body, walletRead?.address ?? null);
      if (cancelled) return;
      setPrivateRead({ scope, presaleId: dialogSaleId, wallet: walletRead, facts: nextFacts });
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [dialogSaleId, api, queries, readIdentity, scope]);

  const sale: SaleState = saleRead?.presaleId === dialogSaleId && saleRead !== null ? saleRead.state : { status: "loading" };
  const ownRead = scope !== null && privateRead?.scope === scope && privateRead.presaleId === dialogSaleId ? privateRead : null;
  const walletCoinsState: "loading" | "ready" | "unavailable" = viewer.sessionPending || (scope !== null && ownRead === null) ? "loading" : ownRead?.wallet?.address ? "ready" : "unavailable";
  return { sale, wallet: ownRead?.wallet ?? null, facts: ownRead?.facts ?? NO_FACTS, walletCoinsState };
}

function isCommitOpen(dialog: Dialog, detail: CommitSaleRead | null): boolean {
  return dialog.kind === "confirmed" || dialog.kind === "commit" || (dialog.kind === "sale" && detail?.presale.phase === "open");
}
