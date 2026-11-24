"use client";
import { parseAtoms } from "#web/components/social/trade/trade-ticket.ts";
import { IconButton, Button } from "#web/components/blast-ui/Button.tsx";
import { FieldGroup, TextField, TextArea } from "#web/components/blast-ui/TextField.tsx";

import workspaceStyles from "../WorkspaceHost.module.css";
import clsx from "clsx";
import {
  type ReactNode,
  useCallback,
  useContext,
  useId,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Sheet, SheetClose, SheetHeading } from "#web/components/blast-ui/Sheet.tsx";
import { isValidStructTag, normalizeStructTag } from "@mysten/sui/utils";
import { validateWhy } from "@blast/core/modules/social/whys/validate.ts";
import { Collapse } from "#web/components/blast-ui/Collapse.tsx";
import { InfoIcon } from "#web/components/blast-ui/Icons.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import {
  USED_ALLOCATION_MESSAGE,
  commitPrimary,
  commitRefusal,
  commitTerms,
  minimumLabel,
  capLabel,
  type CommitInput,
} from "@blast/core/modules/social/commit/quote.ts";
import type { SocialPresaleDetail } from "@blast/core/web/contracts/presales.ts";
import { useCommitClock } from "#web/components/social/commit/commit-clock.ts";
import { commitFactsAt, commitSaleOf, saleFacts } from "#web/components/social/commit/commit-view.ts";
import type { CommitFacts, CommitKit } from "#web/components/social/commit/commit-kit.ts";
import type { QuoteSnapshot } from "#web/components/social/commit/commit-quote.ts";
import {
  payWithOf,
  prepareCommitPayment,
  routedPayment,
  saleQuoteCoin,
} from "#web/components/social/commit/commit-payment.ts";
import { PaymentCoinSelector } from "#web/components/social/commit/PaymentCoinSelector.tsx";
import {
  useCompactPayment,
  compactPaymentPrimary,
} from "#web/components/social/commit/use-commit-swap.ts";
import {
  coinTypeName,
  PUBLIC_BASE_COINS,
  SUI_FEE_RESERVE_ATOMS,
  walletCoinViews,
  withPreferredCoins,
  type WalletCoinView,
} from "#web/components/social/coins/coin-model.ts";
import { atomsText, atomsValue } from "@blast/core/web/format.ts";
import { useWalletCoinBalance, type WalletCoinBalance } from "#web/components/social/coins/use-wallet-coin-balance.ts";
import { WHY_TEXT_MESSAGES } from "#web/components/social/post/why-client.ts";
import type { PresalePanelProps } from "./PresalePanel";
import type { PresaleAsset } from "./presale-reads";
import { PresaleAmount } from "./PresaleContent";
import { PresalePaymentFacts } from "./PresalePaymentFacts";
import { ActionConfirmation, PreferenceStatus } from "../ActionConfirmation";
import { PanelAssetContext } from "./panel-context";
import styles from "./PresalePanel.module.css";
import { useCoinRead } from "./use-coin-read";
import { useWorkspaceLiveClock, useWorkspaceLiveKey } from "../live-clock";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { decimalText, dropDecimal, pasteDecimal } from "#web/lib/decimal-input.ts";

type Props = Readonly<{
  /** This account's existing commitment, shown beside the costs; omitted for a guest. */
  yourCommit?: ReactNode;
  asset: PresaleAsset;
  setup: PresalePanelProps["presale_setup"];
  onSetupChange: PresalePanelProps["onSetupChange"];
  visible: boolean;
  actions: PresalePanelProps["actions"];
  detail: SocialPresaleDetail | null;
  detail_status: "pending" | "ready" | "error";
}>;
const EMPTY: QuoteSnapshot<CommitFacts> = Object.freeze({
  facts: null,
  at: null,
  loading: false,
  failed: false,
});
const noSubscription = () => () => {};
function matches(facts: CommitFacts | null, asset: PresaleAsset) {
  return (
    !!facts?.sale &&
    asset.network === "mainnet" &&
    facts.sale.presaleId === asset.presale_id &&
    normalizeStructTag(facts.detail.presale.sale_token) === asset.coin_type
  );
}
function whyError(why: string) {
  if (!why.trim()) return null;
  const result = validateWhy(why);
  return result.ok ? null : WHY_TEXT_MESSAGES[result.code];
}
function inputOf(
  facts: CommitFacts | null,
  props: Props,
  pay: string,
  nowMs: number,
): CommitInput | null {
  if (!facts?.sale) return null;
  return {
    sale: facts.sale,
    viewer: facts.viewer,
    typed: props.setup.commitment.amount,
    payWith: pay,
    why: props.setup.commitment.why,
    whyError: whyError(props.setup.commitment.why),
    blockers: facts.blockers,
    nowMs,
  };
}

function exactPaymentInput(input: CommitInput | null, coin: WalletCoinView | undefined) {
  if (!input || !coin || routedPayment(input.sale, coin)) return input;
  return { ...input, viewer: { ...input.viewer, quoteCoin: input.sale.quoteCoin, quoteBalance: coin.amount } };
}

function coinWithAtoms(coin: WalletCoinView, atoms: bigint): WalletCoinView {
  return { ...coin, atoms, amount: atomsValue(atoms, coin.decimals) ?? 0 };
}
function readyFacts(
  facts: CommitFacts | null,
  props: Props,
  failed: boolean,
  nowMs: number,
) {
  return (
    matches(facts, props.asset) &&
    props.detail_status === "ready" &&
    !!props.detail?.terms &&
    !!facts?.detail.terms &&
    !failed &&
    facts?.sale?.presalePrice != null &&
    facts.sale.presalePrice > 0 &&
    facts.detail.presale.start_ms <= nowMs
  );
}

function presalePrimary(
  authenticated: boolean,
  valid: boolean,
  payment: ReturnType<typeof useCompactPayment>,
) {
  return !authenticated
    ? {
        label: "Sign in to commit",
        disabled: false,
        action: "sign-in" as const,
      }
    : valid && payment.funded
      ? compactPaymentPrimary(commitPrimary(payment.funded), payment)
      : {
          label: "Commit unavailable",
          disabled: true,
          action: "none" as const,
        };
}

function commitAmountError(typed: string, symbol: string, decimals: number) {
  const amount = typed.replace(/,/g, "").trim();
  if (!amount) return "Enter an amount to commit.";
  if (parseAtoms(amount, decimals) === null)
    return `Enter a valid amount in ${symbol}.`;
  if ((amount.split(".")[1]?.length ?? 0) > decimals)
    return `${symbol} supports up to ${decimals} decimal places. Edit the amount to continue.`;
  return null;
}

/** The pay coin of `type`: the sale's own coin, a wallet coin, the coin just picked from the catalog, or a public base coin; undefined when its decimals are unknown. */
function payCoinOf(type: string | null, accepted: WalletCoinView | null, coins: readonly WalletCoinView[], picked: WalletCoinView | null) {
  if (type === null) return undefined;
  if (accepted?.coinType === type) return accepted;
  return [...withPreferredCoins(coins), ...(picked ? [picked] : []), ...PUBLIC_BASE_COINS].find((coin) => coin.coinType === type);
}

function commitModel(
  facts: CommitFacts | null,
  props: Props,
  nowMs: number,
  failed: boolean,
  picked: WalletCoinView | null,
  metadata: WalletCoinView | null,
) {
  const { setup } = props;
  // Before (or without) the viewer's facts, the published sale still names its coin.
  const sale = facts?.sale ?? (props.detail ? commitSaleOf(props.detail, { suiUsd: null }) : null);
  const coins = walletCoinViews(facts?.wallet ?? null);
  const accepted = sale ? saleQuoteCoin(sale, coins) : null;
  const type =
    setup.commitment.payment_coin_type ??
    accepted?.coinType ??
    props.detail?.presale.quote_type ??
    null;
  const selected = payCoinOf(type, accepted, coins, picked) ?? (metadata?.coinType === type ? metadata : undefined);
  const pay = selected ? (sale ? payWithOf(sale, selected) : selected.symbol) : "";
  const input = inputOf(facts, props, pay, nowMs);
  const amountError = selected
    ? commitAmountError(
        setup.commitment.amount,
        selected.symbol,
        selected.decimals,
      )
    : null;
  const ready = readyFacts(facts, props, failed, nowMs);
  const valid =
    !amountError &&
    ready &&
    selected &&
    input &&
    parseAtoms(input.typed, selected.decimals) !== null;
  const allocationPrimary = ready && input && commitRefusal(input) === "allocation_used" ? commitPrimary(input) : null;
  const closed = props.detail && (props.detail.presale.phase !== "open" || props.detail.presale.end_ms <= nowMs);
  return { accepted, coins, type, selected, input, valid, amountError, allocationPrimary, closed };
}

function commitReadUnavailable(
  props: Props,
  snapshot: QuoteSnapshot<CommitFacts>,
  facts: CommitFacts | null,
  hasPayment: boolean,
) {
  return (
    props.actions.authenticated &&
    props.detail_status === "ready" &&
    !!props.detail?.terms &&
    !snapshot.loading &&
    (snapshot.failed || !facts || !facts.detail.terms || !hasPayment)
  );
}

function usePresaleCommitRead({ asset, actions, visible }: Props, id: string) {
  const kit = actions.commit;
  const active = visible && actions.authenticated && asset.network === "mainnet" && !!kit;
  const shared = useSyncExternalStore(
    active ? kit.quotes.subscribe : noSubscription,
    () => active ? kit.quotes.peek(id) : EMPTY,
    () => EMPTY,
  );
  const readFacts = useCallback(async () => {
    const facts = await kit?.quotes.refresh(id);
    if (!facts) throw new Error("Commitment facts unavailable");
    return facts;
  }, [kit, id]);
  const liveFacts = useCoinRead(
    active,
    `${actions.actor_key}:${id}`,
    readFacts,
  );
  // A shared cache update is displayable only after this presentation's forced refresh.
  const snapshot = useMemo<QuoteSnapshot<CommitFacts>>(() => {
    if (liveFacts.status === "pending") return { ...EMPTY, loading: active };
    if (liveFacts.status === "error") return { ...EMPTY, failed: true };
    return shared;
  }, [liveFacts.status, active, shared]);
  return { snapshot, retry: liveFacts.retry };
}

function useStoredPaymentMetadata({ setup, actions, visible }: Props, facts: CommitFacts | null, picked: WalletCoinView | null) {
  const storedType = setup.commitment.payment_coin_type;
  const source = actions.commit?.paymentCoin;
  const accepted = facts?.sale ? saleQuoteCoin(facts.sale) : null;
  const known = payCoinOf(storedType, accepted, walletCoinViews(facts?.wallet ?? null), picked);
  const read = useCallback(async () => storedType ? await source?.read(storedType) ?? null : null, [source, storedType]);
  const active = visible && actions.authenticated && !!source && !!storedType && isValidStructTag(storedType) && !known;
  const metadata = useCoinRead(active, storedType ?? "", read, undefined, null);
  return { ...metadata, loading: active && metadata.status === "pending" };
}

function usePresaleFunding(props: Props, facts: CommitFacts | null, snapshot: QuoteSnapshot<CommitFacts>, nowMs: number, picked: WalletCoinView | null) {
  const { visible, actions } = props;
  const metadata = useStoredPaymentMetadata(props, facts, picked);
  const model = commitModel(facts, props, nowMs, snapshot.failed, picked, metadata.value);
  const exactRequired = !!actions.commit?.inputBalance;
  const balance = useWalletCoinBalance(facts?.wallet?.address, model.type ?? "", exactRequired && visible && actions.authenticated, snapshot.loading);
  const payment = balance.status === "ready" ? fundedModel(model, balance.atoms) : { selected: model.selected, input: model.input, insufficient: false };
  return {
    ...model,
    ...payment,
    balance,
    balanceKnown: !exactRequired || balance.status === "ready",
    amountError: payment.insufficient ? "Insufficient balance." : model.amountError,
    readUnavailable: commitReadUnavailable(props, snapshot, facts, !!payment.selected || metadata.loading),
    retryMetadata: metadata.retry,
  };
}

function fundedModel(model: ReturnType<typeof commitModel>, atoms: bigint) {
  const selected = model.selected && coinWithAtoms(model.selected, atoms);
  const input = exactPaymentInput(model.input, selected);
  const inputAtoms = selected && input ? parseAtoms(input.typed, selected.decimals) : null;
  return { selected, input, insufficient: inputAtoms !== null && inputAtoms > atoms };
}

function presaleReviewKey(actions: Props["actions"], setup: Props["setup"], facts: CommitFacts | null, quote: ReturnType<typeof useCompactPayment>["quote"]) {
  return JSON.stringify([actions.actor_key, actions.confirmation, setup.commitment, facts?.sale, facts?.wallet, facts?.detail.terms, quote]);
}

function usePresaleCommit(props: Props) {
  const { asset, setup, onSetupChange, actions, visible } = props;
  const kit = actions.commit;
  const id = asset.presale_id ?? "";
  const { snapshot, retry } = usePresaleCommitRead(props, id);
  const clock = useWorkspaceLiveClock();
  const presentationKey = useWorkspaceLiveKey(visible);
  const [refreshed, setRefreshed] = useState<Readonly<{
    facts: CommitFacts;
    source: typeof snapshot;
    kit: typeof kit;
  }> | null>(null);
  const candidate =
    refreshed?.source === snapshot && refreshed.kit === kit
      ? refreshed.facts
      : snapshot.facts;
  const nowMs = useCommitClock() || snapshot.at || 0;
  const facts = actions.authenticated && matches(candidate, asset) ? commitFactsAt(candidate, nowMs) : null;
  const [picked, setPicked] = useState<WalletCoinView | null>(null);
  const funding = usePresaleFunding(props, facts, snapshot, nowMs, picked);
  const { accepted, coins, type, valid, allocationPrimary, closed, selected, input } = funding;
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("Preparing commitment");
  const [message, setMessage] = useState<string | null>(null);
  const held = useRef(false);
  const [review, setReview] = useState<string | null>(null);
  const generation = useRef(0);
  const current = useRef({ visible, actions, setup, onSetupChange });
  useLayoutEffect(() => {
    current.current = { visible, actions, setup, onSetupChange };
  }, [visible, actions, setup, onSetupChange]);
  useEffect(
    () => () => {
      current.current = { ...current.current, visible: false };
    },
    [],
  );
  const allocationUsed = allocationPrimary !== null;
  const payment = useCompactPayment(
    input,
    selected ?? null,
    busy,
    visible && actions.authenticated && !allocationUsed,
    kit?.quotePayment,
    `${facts?.wallet?.address ?? ""}:${presentationKey}`,
    clock,
  );
  const funded = funding.balanceKnown && !funding.insufficient;
  const primary = allocationPrimary ?? presalePrimary(actions.authenticated, !!valid && funded, payment);
  const preferenceReady = actions.confirmation?.status === "ready";
  const reviewKey = presaleReviewKey(actions, setup, facts, payment.quote);
  const currentReview = useRef(reviewKey);
  useLayoutEffect(() => { currentReview.current = reviewKey; });
  const cancelReview = () => { generation.current++; setReview(null); };
  const draft = (patch: Partial<typeof setup.commitment>) => {
    setMessage(null);
    onSetupChange({ ...setup, commitment: { ...setup.commitment, ...patch } });
  };

  function submit(confirmed = false) {
    if (!current.current.visible || held.current) return;
    if (!actions.authenticated) {
      actions.signIn();
      return;
    }
    if (
      primary.disabled ||
      !kit ||
      !kit.signedIn ||
      !input ||
      !facts ||
      !selected
    )
      return;
    if (primary.action === "deposit") {
      kit.deposit();
      return;
    }
    if (primary.action !== "commit" || !preferenceReady) return;
    if (actions.confirmation?.status === "ready" && actions.confirmation.enabled && !confirmed) {
      setReview(reviewKey);
      return;
    }
    if (confirmed && review !== reviewKey) return;
    const reviewGeneration = generation.current;
    held.current = true;
    setBusy(true);
    setMessage(null);
    setPhase("Preparing commitment");
    const actor = actions.actor_key;
    void attemptCommit({
      asset,
      id,
      kit,
      facts,
      input,
      selected,
      payment,
      confirmEconomics: confirmed,
      isCurrent: () =>
        current.current.visible &&
        (!confirmed || (generation.current === reviewGeneration && currentReview.current === reviewKey)) &&
        current.current.actions.commit === kit &&
        current.current.actions.actor_key === actor &&
        current.current.actions.authenticated &&
        kit.signedIn,
      onFacts: (fresh) =>
        setRefreshed({ facts: fresh, source: kit.quotes.peek(id), kit }),
      setMessage,
      setPhase,
      // A sent commitment leaves an empty box, so the next one is never typed into the old amount (#1012).
      onSent: () => {
        const { setup: latest, onSetupChange: save } = current.current;
        save({ ...latest, commitment: { ...latest.commitment, amount: "" } });
      },
      onDone: () => {
        held.current = false;
        setBusy(false);
        setReview(null);
      },
    });
  }

  return {
    props,
    allocationUsed,
    setup,
    selected,
    balance: funding.balance,
    balanceKnown: funding.balanceKnown,
    type,
    accepted,
    coins,
    setPicked,
    draft,
    busy,
    facts,
    input,
    payment,
    valid,
    amountError: funding.amountError,
    readUnavailable: funding.readUnavailable,
    snapshot,
    message,
    phase,
    primary,
    preferenceReady,
    review,
    reviewKey,
    cancelReview,
    closed,
    submit,
    retry: () => {
      setRefreshed(null);
      retry();
      funding.retryMetadata();
    },
  };
}

export function PresaleCommit(props: Props) {
  return <CommitForm state={usePresaleCommit(props)} />;
}
/** The commit controls, directly on the card: amount and payment coin, then a full-width Commit, then the expected allocation. Costs, route facts and the note sit behind Details; the confirmation still states the fee before signing. */
function CommitForm({
  state,
}: Readonly<{ state: ReturnType<typeof usePresaleCommit> }>) {
  const {
    allocationUsed,
    props,
    selected,
    facts,
    input,
    payment,
  } = state;
  const { visible } = props;
  const inCard = useContext(PanelAssetContext) !== null;
  const [details, setDetails] = useState(false);
  const [wasVisible, setWasVisible] = useState(visible);
  if (wasVisible !== visible) {
    setWasVisible(visible);
    if (!visible) setDetails(false);
  }
  const detailsId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => setDetails(false);
  const content = (
    <>
      <CommitFactsView
        facts={facts}
        input={input}
        payment={payment}
        selected={selected}
        balanceKnown={state.balanceKnown}
        authenticated={props.actions.authenticated}
        showPurchase={!allocationUsed}
        routeStatus={false}
      />
      {!allocationUsed && <CommitWhy state={state} />}
    </>
  );
  return (
    <section className={styles.commit} aria-label="Commit">
      <CommitSubmit state={state} />
      <div className={styles.meta}>
        <CommitMeta state={state} />
        <IconButton variant="ghost" size="sm"
          ref={trigger}
          className={styles.more}
          type="button"
          aria-label="Commit details"
          title="Commit details"
          aria-expanded={details}
          aria-controls={inCard ? undefined : detailsId}
          aria-haspopup={inCard ? "dialog" : undefined}
          onClick={() => setDetails(!details)}
        >
          <InfoIcon />
        </IconButton>
      </div>
      <CommitStatus state={state} />
      {inCard ? (
        <Sheet className={workspaceStyles.tradeSheet} open={details && visible} onRequestClose={close} labelledBy={detailsId}>
          <SheetClose onClick={close} />
          <SheetHeading id={detailsId} title="Commit details" />
          <div className={styles.feesBody}>{content}</div>
        </Sheet>
      ) : (
        <div className={styles.fees}>
          <Collapse open={details} id={detailsId} focusOnClose={() => trigger.current}>
            <div className={styles.feesBody}>{content}</div>
          </Collapse>
        </div>
      )}
      {!allocationUsed && <CommitConfirmation state={state} />}
    </section>
  );
}

function CommitSubmit({ state }: Readonly<{ state: ReturnType<typeof usePresaleCommit> }>) {
  const { allocationUsed, busy, closed, phase, preferenceReady, primary, props, submit } = state;
  const allocationId = useId();
  const canCommit = primary.action === "commit";
  return (
    <>
      {allocationUsed ? (
        <div className={styles.notices}>
          <p id={allocationId} role="status">{USED_ALLOCATION_MESSAGE}</p>
        </div>
      ) : (
        <div className={styles.trayRow}>
          <CommitFields state={state} />
        </div>
      )}
      <Button variant="primary" size="lg"
        className={clsx(" ", styles.cta)}
        type="button"
        data-presale-submit=""
        aria-keyshortcuts={allocationUsed ? undefined : "Shift+Space"}
        aria-describedby={allocationUsed ? allocationId : undefined}
        loading={busy}
        loadingLabel={phase}
        disabled={!props.visible || busy || primary.disabled || !!closed || (canCommit && !preferenceReady)}
        onClick={() => void submit()}
      >
        {canCommit ? "Commit" : primary.label}
      </Button>
    </>
  );
}

/** The tray's second row: what the typed amount buys (once there is one), and what this account already committed when it has. */
function CommitMeta({ state }: Readonly<{ state: ReturnType<typeof usePresaleCommit> }>) {
  const { props, payment, setup } = state;
  const hidden = useShellPrefs().amountsHidden;
  const tokens = allocationTokens(payment);
  return (
    <>
      {props.detail?.presale.phase === "open" && !state.closed && !state.allocationUsed && setup.commitment.amount.trim() !== "" && (
        <span>
          Allocation{" "}
          <b>{tokens === null ? "—" : hidden ? "••••" : `≈ ${tokens} ${props.detail?.presale.symbol ?? ""}`.trim()}</b>
        </span>
      )}
      {props.yourCommit != null && (
        <span>
          Your commit <b>{props.yourCommit}</b>
        </span>
      )}
    </>
  );
}
function CommitStatus({ state }: Readonly<{ state: ReturnType<typeof usePresaleCommit> }>) {
  const { allocationUsed, props, payment } = state;
  return (
      <div className={styles.notices}>
        <CommitNotices state={state} />
        {payment.routed && !allocationUsed && <p role="status">{payment.message ?? "Swap route unavailable"}{!payment.ready && <Button variant="secondary" size="sm" type="button"  onClick={payment.refresh}>Refresh payment quote</Button>}</p>}
        {!allocationUsed && <PreferenceStatus preference={props.actions.confirmation} />}
      </div>
  );
}

function CommitConfirmation({ state }: Readonly<{ state: ReturnType<typeof usePresaleCommit> }>) {
  const { props, busy, primary, closed, input, selected, facts, payment, submit } = state;
  const { visible } = props;
  return (
      <ActionConfirmation open={!!state.review && visible} busy={busy} valid={state.review === state.reviewKey && state.preferenceReady && !primary.disabled && !closed} action="Commit" asset={input?.sale.symbol ?? "presale"} onCancel={state.cancelReview} onConfirm={() => submit(true)}>
        <p>Commit {state.setup.commitment.amount} {selected?.symbol} to {input?.sale.symbol}.</p>
        <p>Network: {props.asset.network}</p>
        <p>{allocationText(input, payment)} · Network fee: {currentFee(facts, payment)}</p>
        {input && <p>Minimum {minimumLabel(input) ?? "set by eligibility"} · Wallet cap {capLabel(input) ?? "set by eligibility"}</p>}
        <CommitFactsView facts={facts} input={input} payment={payment} selected={selected} balanceKnown={state.balanceKnown} authenticated={props.actions.authenticated} />
      </ActionConfirmation>
  );
}

type CommitPurchaseFactsProps = Readonly<{
  facts: CommitFacts | null;
  input: CommitInput | null;
  payment: ReturnType<typeof useCompactPayment>;
  selected: WalletCoinView | undefined;
  balanceKnown: boolean;
  authenticated: boolean;
}>;

function CommitFactsView({
  showPurchase = true,
  routeStatus = true,
  ...purchase
}: CommitPurchaseFactsProps & Readonly<{
  showPurchase?: boolean;
  /** The tray already states the route's status beside its notices. */
  routeStatus?: boolean;
}>) {
  const { facts, input, payment, selected } = purchase;
  const routed = showPurchase && payment.routed;
  const buyerVesting = facts
    ? saleFacts(facts.detail).find((fact) => fact.label === "Buyer vesting")
    : null;
  return (
    <>
      <dl className={styles.facts} aria-label="Commit facts">
        {showPurchase && <CommitPurchaseFacts {...purchase} />}
        <div>
          <dt>Buyer vesting</dt>
          <dd>{buyerVesting?.value ?? "Unavailable"}{buyerVesting?.note && <span> · {buyerVesting.note}</span>}</dd>
        </div>
        <div>
          <dt>Allocation</dt>
          <dd>
            Set at close; any unallocated commitment is refunded at claim.
          </dd>
        </div>
      </dl>
      {routed && (
        <PresalePaymentFacts quote={payment.quote} input={input} coin={selected ?? null} />
      )}
      {routeStatus && routed && (
        <p role="status">
          {payment.message ?? "Swap route unavailable"}
          {!payment.ready && (
            <Button variant="secondary" size="sm"

              type="button"
              onClick={payment.refresh}
            >
              Refresh payment quote
            </Button>
          )}
        </p>
      )}
    </>
  );
}

function CommitPurchaseFacts({ facts, input, payment, selected, balanceKnown, authenticated }: CommitPurchaseFactsProps) {
  const hidden = useShellPrefs().amountsHidden;
  return (
    <>
      <div>
        <dt>Available balance</dt>
        <dd>
          <PresaleAmount
            atoms={authenticated && balanceKnown ? selected?.atoms.toString() : null}
            decimals={selected?.decimals ?? 0}
            symbol={selected?.symbol ?? ""}
            label="available balance"
          />
        </dd>
      </div>
      <div>
        <dt>Network fee</dt>
        <dd>{currentFee(facts, payment)}</dd>
      </div>
      <div>
        <dt>Estimated allocation</dt>
        <dd>{hidden ? "••••" : allocationText(input, payment)}</dd>
      </div>
    </>
  );
}

async function prepareWorkspacePayment(
  kit: CommitKit,
  fresh: CommitFacts,
  again: CommitInput,
  selected: WalletCoinView,
  quote: ReturnType<typeof useCompactPayment>["quote"],
) {
  const freshCoins = walletCoinViews(fresh.wallet);
  const metadata = routedPayment(again.sale, selected)
    ? (freshCoins.find((held) => held.coinType === selected.coinType) ?? coinWithAtoms(selected, 0n))
    : saleQuoteCoin(again.sale, freshCoins);
  if (!kit.inputBalance) return prepareCommitPayment(again, metadata, kit.quotePayment, Date.now, quote);
  const address = fresh.wallet?.address;
  const exact = address ? await kit.inputBalance.read(address, selected.coinType).catch(() => null) : null;
  if (exact === null) return { refusal: "Payment balance is unavailable. Try again." };
  if ((parseAtoms(again.typed, selected.decimals) ?? 0n) > exact) return { refusal: "Insufficient balance." };
  const coin = coinWithAtoms(metadata, exact);
  return prepareCommitPayment(exactPaymentInput(again, coin)!, coin, kit.quotePayment, Date.now, quote);
}

async function attemptCommit({
  asset,
  id,
  kit,
  facts,
  input,
  selected,
  payment,
  confirmEconomics,
  isCurrent,
  onFacts,
  setMessage,
  setPhase,
  onSent,
  onDone,
}: Readonly<{
  asset: PresaleAsset;
  id: string;
  kit: NonNullable<Props["actions"]["commit"]>;
  facts: CommitFacts;
  input: CommitInput;
  selected: WalletCoinView;
  payment: ReturnType<typeof useCompactPayment>;
  confirmEconomics: boolean;
  isCurrent: () => boolean;
  onFacts: (facts: CommitFacts) => void;
  setMessage: (message: string) => void;
  setPhase: (phase: string) => void;
  onSent: () => void;
  onDone: () => void;
}>) {
  try {
    const fresh = commitFactsAt(await kit.quotes.fresh(id), Date.now());
    if (!isCurrent()) return;
    if (!matches(fresh, asset) || !fresh?.sale || !fresh.detail.terms) {
      setMessage(
        "Presale terms could not load. Your draft is kept. Retry the quote.",
      );
      return;
    }
    if (confirmEconomics && JSON.stringify([fresh.sale, fresh.detail.terms]) !== JSON.stringify([facts.sale, facts.detail.terms])) {
      onFacts(fresh);
      setMessage("Presale terms changed. Review the updated amounts and limits. Nothing was sent.");
      return;
    }
    onFacts(fresh);
    if (fresh.detail.presale.start_ms > Date.now()) {
      setMessage("This presale is not open for commitments yet.");
      return;
    }
    if (fresh.sale.presalePrice === null || fresh.sale.presalePrice <= 0) {
      setMessage("Presale pricing terms are unavailable. Your draft is kept.");
      return;
    }
    if (
      fresh.wallet?.address !== facts.wallet?.address ||
      fresh.wallet?.fee !== facts.wallet?.fee
    ) {
      setMessage(
        "Your wallet or network fee payer changed. Review the updated facts, then commit again.",
      );
      return;
    }
    const again = {
      ...input,
      sale: fresh.sale,
      viewer: fresh.viewer,
      blockers: fresh.blockers,
      nowMs: Date.now(),
    };
    const order = await prepareWorkspacePayment(kit, fresh, again, selected, payment.quote);
    if (!isCurrent()) return;
    if ("refusal" in order) {
      setMessage(order.refusal);
      return;
    }
    const exact = !payment.routed
      ? { quoteAtoms: parseAtoms(input.typed, selected.decimals)!.toString() }
      : {};
    const result = await kit.send(
      fresh,
      { ...order.order, ...exact },
      {
        onPhase: (next) =>
          setPhase(
            {
              preparing: "Preparing commitment",
              signing: "Confirm in your wallet",
              executing: "Submitting commitment",
            }[next],
          ),
      },
    );
    if (!isCurrent()) return;
    if (result.status === "sent") onSent();
    setMessage(
      result.status === "sent"
        ? "Commitment sent. Check confirmation in your transaction history."
        : (result.message ??
            "The commitment did not go through. Your draft is kept."),
    );
  } catch {
    setMessage(
      "The commitment could not complete. Check your transaction history before trying again. Your draft is kept.",
    );
  } finally {
    onDone();
  }
}

function currentFee(
  facts: CommitFacts | null,
  payment: ReturnType<typeof useCompactPayment>,
) {
  const routeFee =
    payment.routed && (payment.ready || payment.state === "submitting")
      ? payment.quote?.network_fee
      : null;
  const fee = routeFee
    ? routeFee.payer === "blast"
      ? "sponsored"
      : "wallet"
    : facts?.wallet?.fee;
  return fee === "sponsored"
    ? "Paid by Blast"
    : fee === "wallet"
      ? "Paid from your SUI · final fee shown in wallet"
      : "Unavailable";
}
function allocationTokens(payment: ReturnType<typeof useCompactPayment>) {
  const terms = payment.funded
    ? commitTerms(payment.funded.sale, Number(payment.funded.typed))
    : null;
  return terms?.tokens == null
    ? null
    : terms.tokens.toLocaleString("en-US", { maximumFractionDigits: 9 });
}
function allocationText(
  input: CommitInput | null,
  payment: ReturnType<typeof useCompactPayment>,
) {
  const tokens = allocationTokens(payment);
  return tokens === null
    ? "Unavailable"
    : `≈ ${tokens} ${input?.sale.symbol} if closed now`;
}

/** The wallet's whole balance of the payment coin, less the SUI it keeps back when it pays its own fee; null while unknown. */
function maxAmount(coin: WalletCoinView | undefined, walletPaysGas: boolean) {
  if (!coin) return null;
  const atoms = coin.atoms;
  const spendable = coin.coinType === SUI_COIN_TYPE && walletPaysGas
    ? (atoms > SUI_FEE_RESERVE_ATOMS ? atoms - SUI_FEE_RESERVE_ATOMS : 0n)
    : atoms;
  return spendable > 0n ? atomsText(spendable, coin.decimals) : null;
}

function CommitFields({
  state,
}: Readonly<{ state: ReturnType<typeof usePresaleCommit> }>) {
  const { props, setup, selected, type, accepted, coins, setPicked, draft, busy, amountError, facts, balanceKnown } =
    state;
  const unitId = useId();
  const symbol = selected?.symbol ?? props.detail?.presale.quote_symbol ?? "payment coin";
  const max = props.actions.authenticated && balanceKnown ? maxAmount(selected, facts?.wallet?.fee === "wallet") : null;
  // An untouched empty field is neutral; amount validation still gates submission.
  const invalid = props.actions.authenticated && setup.commitment.amount.trim() !== "" && !!amountError;
  return (
    <>
      <FieldGroup className={styles.amountField} data-invalid={invalid || undefined} data-length={amountLength(setup.commitment.amount)}>
        {symbol === "USDC" ? <span className={styles.currency} aria-hidden="true">$</span> : null}
        <TextField size="sm"
          data-presale-amount=""
          aria-label="Commit amount"
          aria-describedby={unitId}
          aria-invalid={invalid}
          autoComplete="off"
          inputMode="decimal"
          placeholder="0"
          value={setup.commitment.amount}
          disabled={busy}
          onChange={(event) => draft({ amount: decimalText(event) })}
          onPaste={(event) => pasteDecimal(event, (amount) => draft({ amount }))}
          onDrop={(event) => dropDecimal(event, (amount) => draft({ amount }))}
        />
        <span id={unitId} className="sr">Amount in {symbol}</span>
      </FieldGroup>
      <div className={styles.paymentControls}>
        <Button variant="secondary" size="xs"
          className={styles.max}
          type="button"
          disabled={busy || max === null}
          aria-label={`Commit all available ${symbol}`}
          onClick={() => max !== null && draft({ amount: max })}
        >
          Max
        </Button>
        <div className={styles.pay}>
          {accepted ? (
            <PaymentCoinSelector
              accepted={accepted}
              coins={coins}
              busy={busy}
              selected={selected ?? unknownCoin(accepted, type)}
              purchase={false}
              inField
              onPick={(coin) => {
                setPicked(coin);
                draft({ payment_coin_type: coin.coinType });
              }}
            />
          ) : (
            <SkeletonText>Payment coin</SkeletonText>
          )}
        </div>
      </div>
    </>
  );
}
/** A chosen coin this wallet no longer lists, shown by its type's name. */
function unknownCoin(accepted: WalletCoinView, type: string | null): WalletCoinView {
  const coinType = type ?? accepted.coinType;
  return { ...accepted, coinType, key: coinType, symbol: coinTypeName(coinType), name: "Payment coin unavailable", metadataAvailable: false, price: null, value: null, atoms: 0n, amount: 0, iconUrl: null };
}

/** The typed amount's length class: the field steps its type down so long amounts stay whole (≤9, 10–13, ≥14 characters). */
function amountLength(typed: string) {
  if (typed.length >= 14) return "long";
  return typed.length >= 10 ? "mid" : undefined;
}
function CommitNotices({
  state,
}: Readonly<{ state: ReturnType<typeof usePresaleCommit> }>) {
  const {
    props,
    busy,
    input,
    snapshot,
    facts,
    readUnavailable,
    amountError,
    closed,
    message,
    retry,
  } = state;
  const { actions, visible } = props;
  return (
    <>
      {!state.allocationUsed && input?.whyError && <p role="alert">{input.whyError}</p>}
      {!state.allocationUsed && actions.authenticated && state.setup.commitment.amount.trim() !== "" && amountError && (
        <p role="alert">{amountError}</p>
      )}
      {snapshot.loading && !facts && (
        <div role="status" aria-label="Loading commitment quote">
          <SkeletonText>Commitment balances and eligibility</SkeletonText>
        </div>
      )}
      {!state.allocationUsed && <CommitBalanceNotice balance={state.balance} />}
      {!state.allocationUsed && readUnavailable && (
        <p role="status">
          Commitment quote or payment information is unavailable. Your draft is
          kept.{" "}
          <Button variant="secondary" size="sm"

            disabled={busy || !visible}
            type="button"
            onClick={retry}
          >
            Retry quote
          </Button>
        </p>
      )}
      {closed && <CommitClosedNotice phase={props.detail!.presale.phase} />}
      {message && (
        <p role="status" aria-live="polite">
          {message}
        </p>
      )}
    </>
  );
}

function CommitClosedNotice({ phase }: Readonly<{ phase: NonNullable<Props["detail"]>["presale"]["phase"] }>) {
  const status = phase === "open" ? "Closed · awaiting settlement on chain." : `Presale status: ${phase}.`;
  return <p role="status">{status} Commit is unavailable.</p>;
}

function CommitBalanceNotice({ balance }: Readonly<{ balance: WalletCoinBalance }>) {
  if (balance.status !== "unavailable" || !balance.retry) return null;
  return (
    <p role="status">Payment balance unavailable.{" "}
      <Button variant="secondary" size="sm" type="button" onClick={balance.retry}>Retry balance</Button>
    </p>
  );
}

function CommitWhy({state}: Readonly<{state: ReturnType<typeof usePresaleCommit>}>) {
  const {setup, busy, draft} = state;
  return (
    <label className={styles.why}>
      <span>Why are you in? <em>optional</em></span>
      <TextArea
        aria-label="Commit why"
        maxLength={1120}
        value={setup.commitment.why}
        disabled={busy}
        onChange={(event) => draft({ why: event.currentTarget.value })}
      />
    </label>
  );
}
