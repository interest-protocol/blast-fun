"use client";
import { Button } from "#web/components/blast-ui/Button.tsx";

import { DisclosureButton, DisclosureSummary } from "#web/components/blast-ui/Button.tsx";
import { SelectField } from "#web/components/blast-ui/TextField.tsx";
import { Segmented } from "#web/components/blast-ui/Segmented.tsx";
import { AnimatePresence, domAnimation, LazyMotion, m, useIsPresent } from "motion/react";
import { Collapse } from "#web/components/blast-ui/Collapse.tsx";
import { EASE_OUT_ARRAY, T1 } from "#web/components/blast-ui/motion-tokens.ts";
import { instantFeedback, useFeedbackReveal } from "#web/components/blast-ui/feedback-motion.ts";
import { useRouter } from "next/navigation";
import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import { PageHeader } from "#web/components/blast-ui/PageHeader.tsx";
import { SkeletonLine, SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { HIDDEN_AMOUNT } from "@blast/core/lib/format.ts";
import { CoinRowsLoading } from "#web/components/social/coins/CoinRowsLoading.tsx";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { GatedAction } from "#web/components/social/SignInGate.tsx";
import {
  Sheet,
  SheetClose,
  SheetHeading,
} from "#web/components/blast-ui/Sheet.tsx";
import {
  CloseIcon,
  WalletIcon,
} from "#web/components/blast-ui/Icons.tsx";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { Switch } from "#web/components/social/settings/Switch.tsx";
import { TokenPicker } from "#web/components/social/coins/TokenPicker.tsx";
import { CoinIdentity } from "#web/components/social/coins/CoinIdentity.tsx";
import {
  PUBLIC_PREFERRED_COINS,
  type WalletCoinView,
} from "#web/components/social/coins/coin-model.ts";
import {
  formatVestingAmount,
  vestingPath,
} from "@blast/core/modules/vesting/model.ts";
import {
  amountAtoms,
  createIntent,
  CreationFieldError,
  maxVestingAtoms,
  vestingPortionAtoms,
  regularCheckpointReleases,
  splitReleaseAtoms,
  type CreationInput,
} from "./creation-model";
import {
  listVestingCoins,
  resolveVestingCoin,
  vestingWalletCoins,
} from "./creation-coins";
import { useVestingWallet } from "./use-vesting-wallet";
import { useVestingAccountState, vestingAccountKey } from "./use-account-state";
import { VestingReviewRequiredError, VestingSubmissionPendingError } from "./vesting-errors";
import { Address } from "./parts";
import { ScheduleField } from "./ScheduleField";
import { WalletAddressField } from "./WalletAddressField";
import { LiveSummary } from "./CreationSummary";
import { CreationReview, type CreationReviewState } from "./CreationReview";
import { reportVestingAction } from "./feedback";
import styles from "./Vesting.module.css";
import createStyles from "./Creation.module.css";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { atomsValue } from "@blast/core/web/format.ts";
import { useWalletCoinBalance } from "#web/components/social/coins/use-wallet-coin-balance.ts";

const ZERO_ATOMS = 0n;
const compactAmount = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 4,
});

const INITIAL: CreationInput = {
  coinType: "",
  decimals: 0,
  total: "",
  beneficiary: "",
  kind: "linear",
  start: "",
  end: "",
  periodDays: "30",
  periods: "12",
  cliffDays: "",
  releases: [{ key: "first", date: "", amount: "" }],
  cancelable: false,
  refund: "",
  capRecipient: "",
};

function creationIssue(
  draft: CreationInput,
  coin: WalletCoinView | null,
  available: bigint | null,
  sponsored = false,
): CreationFieldError | null {
  if (!coin)
    return new CreationFieldError("coin", "Select a coin to continue.");
  try {
    if (
      available !== null &&
      amountAtoms(draft.total, coin.decimals) >
        maxVestingAtoms(coin.coinType, available, sponsored)
    ) {
      return new CreationFieldError(
        "total",
        sponsored
          ? "This exceeds your available balance."
          : "This exceeds your available balance. Use Max to keep SUI for gas.",
      );
    }
    createIntent(draft);
    return null;
  } catch (caught) {
    return caught instanceof CreationFieldError
      ? caught
      : new CreationFieldError("releases", "Check the schedule values.");
  }
}

function useCreationForm() {
  const wallet = useVestingWallet();
  const hidden = useShellPrefs().amountsHidden;
  const owner = vestingAccountKey(wallet.viewer, wallet.wallet);
  const currentOwner = useRef(owner);
  useLayoutEffect(() => { currentOwner.current = owner; }, [owner]);
  const toast = useToast();
  const router = useRouter();
  const [draft, setDraft] = useVestingAccountState(owner, INITIAL, true);
  const [coin, setCoin] = useVestingAccountState<WalletCoinView | null>(owner, null, true);
  const [review, setReview] = useVestingAccountState<CreationReviewState | null>(owner, null);
  const [preparing, setPreparing] = useVestingAccountState(owner, false);
  const [pendingReview, setPendingReview] = useVestingAccountState<CreationReviewState | null>(owner, null);
  const [checking, setChecking] = useVestingAccountState(owner, false);
  const [error, setError] = useVestingAccountState<string | null>(owner, null);
  const [submitted, setSubmitted] = useState(false);
  const previousWallet = useRef(wallet.wallet);
  const currentWallet = useRef(wallet.wallet);
  const draftRevision = useRef(0);
  const [walletNotice, setWalletNotice] = useState<string | null>(null);
  useEffect(() => {
    currentWallet.current = wallet.wallet;
    if (previousWallet.current && previousWallet.current !== wallet.wallet) {
      setReview(null);
      setWalletNotice(
        "Connected wallet changed. Your entered addresses have been kept; review them before continuing.",
      );
    }
    previousWallet.current = wallet.wallet;
  }, [wallet.wallet, setReview]);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  function touch(field: string) {
    setTouched((previous) => new Set([...previous, field]));
  }
  const timezone = "UTC";
  const selectedBalance = useWalletCoinBalance(wallet.wallet, coin?.coinType ?? "", !!coin);
  const gasBalance = useWalletCoinBalance(wallet.wallet, SUI_COIN_TYPE, wallet.fee === "wallet");
  const balance = coin && selectedBalance.status === "ready"
    ? { ...coin, atoms: selectedBalance.atoms, amount: atomsValue(selectedBalance.atoms, coin.decimals) ?? 0 }
    : null;
  function update(patch: Partial<CreationInput>) {
    if (pendingReview) return;
    draftRevision.current++;
    setReview(null);
    setError(null);
    setDraft((previous) => ({ ...previous, ...patch }));
  }
  function chooseCoin(selected: WalletCoinView) {
    setCoin(selected);
    // Amounts stay visible when changing precision; validation never truncates them.
    update({ coinType: selected.coinType, decimals: selected.decimals });
  }
  const issue = creationIssue(
    draft,
    coin,
    balance?.atoms ?? null,
    wallet.fee === "sponsored",
  );
  async function prepare(event: FormEvent) {
    event.preventDefault();
    if (pendingReview) {
      setReview(pendingReview);
      return;
    }
    setSubmitted(true);
    if (preparing || !wallet.viewer.signedIn) return;
    if (!coin) {
      document.getElementById("vesting-coin")?.focus();
      return;
    }
    if (!balance) return;
    const currentIssue = creationIssue(
      draft,
      coin,
      balance.atoms,
      wallet.fee === "sponsored",
    );
    if (currentIssue) {
      document.getElementById(`vesting-${currentIssue.field}`)?.focus();
      return;
    }
    setError(null);
    setPreparing(true);
    const revision = draftRevision.current;
    await reportVestingAction(
      async () => {
        const intent = createIntent(draft);
        const attempt = await wallet.prepare(intent);
        if (revision !== draftRevision.current) return;
        if (currentWallet.current !== wallet.wallet || currentOwner.current !== owner) {
          throw new Error(
            "Your connected wallet changed. Review again with the current wallet.",
          );
        }
        setReview({ intent, attempt, coin, timezone, sender: wallet.wallet });
      },
      setError,
      () => setPreparing(false),
    );
  }
  async function confirm() {
    if (!review) return;
    if (pendingReview) {
      setChecking(true);
      setError(null);
      await reportVestingAction(
        async () => finish(await wallet.refresh(pendingReview.attempt)),
        setError,
        () => setChecking(false),
      );
      return;
    }
    if (review.sender !== wallet.wallet) {
      setReview(null);
      setError(
        "Your connected wallet changed. Review again with the current wallet.",
      );
      return;
    }
    const latestIssue = creationIssue(draft, coin, null);
    if (latestIssue) {
      setReview(null);
      setSubmitted(true);
      requestAnimationFrame(() =>
        document.getElementById(`vesting-${latestIssue.field}`)?.focus(),
      );
      return;
    }
    setError(null);
    await reportVestingAction(async () => {
      const result = await wallet.execute(review.attempt).catch((caught: unknown) => {
        if (caught instanceof VestingSubmissionPendingError) setPendingReview(review);
        if (caught instanceof VestingReviewRequiredError) setReview(null);
        throw caught;
      });
      finish(result);
    }, setError);
  }
  function finish(result: CreationReviewState["attempt"]) {
    if (result.state === "submitted" || (result.state === "confirmed" && !result.schedule_id)) {
      if (review) setPendingReview({ ...review, attempt: result });
      return;
    }
    setPendingReview(null);
    setReview(null);
    if (result.state === "failed") throw new Error("Creation failed. No vesting was created. Network gas may still have been charged.");
    if (currentOwner.current !== owner) return;
    const path = vestingPath(result.schedule_id!);
    toast("Vesting created", {
      sub: "Your public schedule link is ready.",
      href: path,
      link: "View vesting",
    });
    router.push(path);
  }
  return {
    wallet,
    draft,
    update,
    coin,
    chooseCoin,
    hidden,
    balance,
    selectedBalance,
    gasBalance,
    issue: issue && (submitted || touched.has(issue.field)) ? issue : null,
    submitted,
    touch,
    review,
    setReview,
    preparing,
    pending: pendingReview !== null,
    checking,
    prepare,
    confirm,
    error,
    timezone,
    walletNotice,
  };
}
type CreationForm = ReturnType<typeof useCreationForm>;

export function CreateVesting() {
  const form = useCreationForm();
  return (
    <div className={`${styles.page} ${createStyles.page}`}>
      <PageHeader title="Create vesting" />
      <form
        className={createStyles.layout}
        onSubmit={(event) => void form.prepare(event)}
        noValidate
      >
        <fieldset
          className={createStyles.fields}
          disabled={form.preparing || form.wallet.busy || form.pending}
        >
          {form.walletNotice ? <p role="status">{form.walletNotice}</p> : null}
          <CoinAmountFields form={form} />
          <RecipientFields form={form} />
          <ScheduleFields form={form} />
          <CancellationFields form={form} />
        </fieldset>
        <aside className={`card ${createStyles.summary}`}>
          <div className={createStyles.summaryContent}>
            <LiveSummary
              draft={form.draft}
              coin={form.coin}
              timezone={form.timezone}
            />
          </div>
          <div className={createStyles.reviewAction}>
            <CreationGas form={form} />
            {form.error && !form.review ? (
              <p className={styles.error} role="alert">
                {form.error}
              </p>
            ) : null}
            <CreationAction form={form} />
          </div>
        </aside>
      </form>
      <CreationReview
        review={form.review}
        setReview={form.setReview}
        wallet={{ busy: form.wallet.busy || form.checking, phase: form.checking ? "Checking transaction status" : form.wallet.phase }}
        pending={form.pending}
        confirm={form.confirm}
        error={form.error}
      />
      {form.wallet.node}
    </div>
  );
}

function CreationAction({ form }: Readonly<{ form: CreationForm }>) {
  if (form.wallet.viewer.sessionPending) return <Button disabled variant="primary"><SkeletonLine label="Restoring your session" /></Button>;
  if (!form.wallet.viewer.signedIn) return <GatedAction className="btn btn-primary">Sign in to create vesting</GatedAction>;
  return <button
    className="btn btn-primary"
    id="vesting-review"
    disabled={form.preparing || form.wallet.busy || (!!form.coin && !form.balance && !form.pending)}
    type="submit"
  >
    <LoadingIndicator label="Preparing and simulating vesting" loading={form.preparing}>
      {form.pending ? "Check transaction status" : form.error ? "Retry preparation" : "Review vesting"}
    </LoadingIndicator>
  </button>;
}

function CreationGas({ form }: Readonly<{ form: CreationForm }>) {
  if (form.wallet.walletLoading) return <p><SkeletonLine label="Checking network fee" /></p>;
  if (form.wallet.fee === "sponsored") return <p>Network gas is paid by Blast.</p>;
  if (form.gasBalance.status !== "ready") return null;
  const available = form.gasBalance.atoms;
  return <p>Network gas · {form.hidden ? HIDDEN_AMOUNT : formatVestingAmount(available, 9)} SUI available. Gas is paid from your connected wallet.</p>;
}

function FieldError({
  form,
  field,
}: Readonly<{ form: CreationForm; field: string }>) {
  return form.issue?.field === field ? (
    <span className={createStyles.fieldError} id={`vesting-${field}-error`}>
      {form.issue.message}
    </span>
  ) : null;
}
function fieldProps(form: CreationForm, field: string) {
  return {
    onBlur: () => form.touch(field),
    id: `vesting-${field}`,
    "aria-invalid": form.issue?.field === field || undefined,
    "aria-describedby":
      form.issue?.field === field ? `vesting-${field}-error` : undefined,
  };
}

function CoinAmountFields({ form }: Readonly<{ form: CreationForm }>) {
  const { coin } = form;
  const [open, setOpen] = useState(false);
  return (
    <section
      className={createStyles.section}
      aria-labelledby="vesting-coin-title"
    >
      <div className={createStyles.sectionHeading}>
        <span className={createStyles.number}>1</span>
        <h2 id="vesting-coin-title">Coin & amount</h2>
      </div>
      <label htmlFor="vesting-coin">Coin</label>
      <DisclosureButton
        aria-label={coin ? `Change coin, ${coin.symbol}` : "Select coin"}
        aria-haspopup="dialog"
        aria-invalid={form.issue?.field === "coin" || undefined}
        aria-describedby={
          form.issue?.field === "coin" ? "vesting-coin-error" : undefined
        }
        className={createStyles.coinSelect}
        id="vesting-coin"
        onClick={() => setOpen(true)}
        type="button"
      >
        {coin ? <CoinIdentity coin={coin} /> : <span>Select coin</span>}

      </DisclosureButton>
      <FieldError form={form} field="coin" />
      <AmountField form={form} />
      {coin?.coinType === SUI_COIN_TYPE && form.wallet.fee !== "sponsored" ? (
        <p>
          Amount shortcuts reserve 0.02 SUI for gas.
        </p>
      ) : null}
      {coin?.metadataAvailable === false ? (
        <p>
          Metadata unavailable · enter whole atomic units.
        </p>
      ) : null}
      <CoinDetails form={form} />
      <VestingCoinPicker
        open={open}
        onClose={() => setOpen(false)}
        form={form}
      />
    </section>
  );
}
function AmountField({ form }: Readonly<{ form: CreationForm }>) {
  const { draft, coin, balance, update } = form;
  return (
    <>
      <label htmlFor="vesting-total">Amount to lock</label>
      <div className={createStyles.amountField}>
        <input
          {...fieldProps(form, "total")}
          autoComplete="off"
          inputMode="decimal"
          onChange={(event) => update({ total: event.target.value })}
          placeholder="0.00"
          value={draft.total}
        />
        <span>
          {coin?.metadataAvailable === false ? "atoms" : coin?.symbol}
        </span>
      </div>
      <div className={createStyles.amountFooter}>
        <AvailableBalance form={form} />{" "}
        <div className={createStyles.portions} aria-label="Amount shortcuts">
          {([25, 50, 75] as const).map((percent) => {
            const atoms =
              coin && balance
                ? vestingPortionAtoms(
                    coin.coinType,
                    balance.atoms,
                    percent,
                    form.wallet.fee === "sponsored",
                  )
                : ZERO_ATOMS;
            return (
              <button
                className="btn btn-line btn-sm"
                disabled={atoms === ZERO_ATOMS}
                key={percent}
                onClick={() =>
                  update({
                    total: formatVestingAmount(atoms, coin?.decimals ?? 0),
                  })
                }
                type="button"
              >
                {percent}%
              </button>
            );
          })}
          <button
            className="btn btn-line btn-sm"
            disabled={
              !coin ||
              !balance ||
              maxVestingAtoms(
                coin.coinType,
                balance.atoms,
                form.wallet.fee === "sponsored",
              ) === ZERO_ATOMS
            }
            onClick={() => {
              if (coin && balance)
                update({
                  total: formatVestingAmount(
                    maxVestingAtoms(
                      coin.coinType,
                      balance.atoms,
                      form.wallet.fee === "sponsored",
                    ),
                    coin.decimals,
                  ),
                });
            }}
            type="button"
          >
            Max
          </button>
        </div>
      </div>
      <FieldError form={form} field="total" />
    </>
  );
}
function AvailableBalance({ form }: Readonly<{ form: CreationForm }>) {
  const { selectedBalance } = form;
  let content;
  if (form.wallet.walletLoading)
    content = <span aria-label="Restoring your wallet" role="status"><SkeletonText>Available balance</SkeletonText></span>;
  else if (form.wallet.walletError)
    content = <span role="alert">Your wallet could not load. <Button variant="ghost" size="sm" onClick={() => void form.wallet.retryWallet()}>Retry</Button></span>;
  else if (!form.wallet.viewer.signedIn)
    content = <span>Sign in to see your available balance.</span>;
  else if (!form.wallet.wallet)
    content = <span>Wallet unavailable.</span>;
  else if (!form.coin) content = null;
  else if (selectedBalance.status === "loading")
    content = (
      <span aria-label="Loading your balances" role="status">
        <SkeletonText>Available balance</SkeletonText>
      </span>
    );
  else if (selectedBalance.status === "unavailable")
    content = (
      <span role="alert">
        Balances unavailable.{" "}
        <button
          className="btn btn-ghost btn-sm"
          onClick={selectedBalance.retry ?? undefined}
          disabled={selectedBalance.retry === null}
          type="button"
        >
          Retry
        </button>
      </span>
    );
  else content = <AvailableCoinBalance form={form} />;
  return <div className={createStyles.available}>{content}</div>;
}
function AvailableCoinBalance({ form }: Readonly<{ form: CreationForm }>) {
  const { coin, balance } = form;
  if (!coin) return null;
  if (form.hidden) return <span>Available <b className="num">{HIDDEN_AMOUNT}</b></span>;
  const exact = formatVestingAmount(balance ? balance.atoms : ZERO_ATOMS, coin.metadataAvailable === false ? null : coin.decimals);
  return <span aria-label={`Available: ${exact} ${coin.symbol}`}>
    Available <b className="num">{balance ? compactBalance(balance) : "0"} {coin.metadataAvailable === false ? "atoms" : coin.symbol}</b>
  </span>;
}

function CoinDetails({ form }: Readonly<{ form: CreationForm }>) {
  const { coin, balance } = form;
  const exact =
    coin && balance
      ? formatVestingAmount(
          balance.atoms,
          coin.metadataAvailable === false ? null : coin.decimals,
        )
      : null;
  return (
    <>
      {coin ? (
        <details className={createStyles.disclosure}>
          <DisclosureSummary>Coin details</DisclosureSummary>
          <dl className={`${styles.details} ${createStyles.coinDetails}`}>
            <div>
              <dt>Full type</dt>
              <dd>
                <Address value={coin.coinType} />
              </dd>
            </div>
            <div>
              <dt>Decimals</dt>
              <dd>
                {coin.metadataAvailable === false
                  ? "Unknown · atomic units"
                  : coin.decimals}
              </dd>
            </div>
            {exact && !form.hidden ? (
              <div>
                <dt>Exact balance</dt>
                <dd>{exact}</dd>
              </div>
            ) : null}
          </dl>
        </details>
      ) : null}
    </>
  );
}

function compactBalance(coin: WalletCoinView) {
  return compactAmount.format(coin.amount);
}

function VestingCoinPicker({
  open,
  onClose,
  form,
}: Readonly<{ open: boolean; onClose: () => void; form: CreationForm }>) {
  const owner = form.wallet.wallet;
  const balances = useQuery({
    queryKey: ["blast", "me", "vesting-coins", owner],
    enabled: open && !!owner,
    queryFn: ({ signal }) => vestingWalletCoins(owner!, signal),
  });
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selection = useRef(0);
  function close() {
    selection.current += 1;
    setSelecting(false);
    setError(null);
    onClose();
  }
  async function pick(coin: WalletCoinView) {
    const request = ++selection.current;
    setSelecting(true);
    setError(null);
    try {
      const resolved = await resolveVestingCoin(
        coin.coinType,
        undefined,
        coin.atoms,
      );
      if (selection.current !== request) return;
      form.chooseCoin(resolved);
      close();
    } catch {
      if (selection.current === request) {
        setError(
          "Coin details could not load. Select the coin again to retry.",
        );
        setSelecting(false);
      }
    }
  }
  return (
    <Sheet
      labelledBy="vesting-select-coin"
      open={open}
      onRequestClose={close}
      initialFocus={() =>
        window.matchMedia("(hover: hover)").matches
          ? document.querySelector<HTMLInputElement>(
              '[aria-labelledby="vesting-select-coin"] input[role="combobox"]',
            )
          : null
      }
    >
      <SheetClose onClick={close} />
      <SheetHeading
        id="vesting-select-coin"
        title="Select coin"
      />
      <p>Select any coin from your wallet or search by its full type.</p>
      {open && owner && balances.isPending ? (
        <CoinRowsLoading label="Loading your coins" count={2} />
      ) : null}
      {balances.isError ? (
        <p role="alert">
          Your coins could not load.{" "}
          <button
            className="btn btn-line btn-sm"
            onClick={() => void balances.refetch()}
            type="button"
          >
            Retry
          </button>
        </p>
      ) : null}
      {balances.isSuccess && balances.data.length === 0 ? (
        <p>
          No wallet coins.
        </p>
      ) : null}
      {open ? (
        <TokenPicker
          current={form.coin}
          wallet={balances.data ?? []}
          pins={[]}
          hidden={form.hidden}
          listCoins={listVestingCoins}
          onPick={(coin) => void pick(coin)}
          purpose="vesting"
          balancesKnown={!!owner && balances.isSuccess}
          quickChoices={PUBLIC_PREFERRED_COINS}
        />
      ) : null}
      {selecting ? <SkeletonLine label="Resolving coin details" /> : null}
      {error ? (
        <p className={createStyles.fieldError} role="alert">
          {error}
        </p>
      ) : null}
    </Sheet>
  );
}

function RecipientFields({ form }: Readonly<{ form: CreationForm }>) {
  return (
    <section
      className={createStyles.section}
      aria-labelledby="vesting-recipient-title"
    >
      <div className={createStyles.sectionHeading}>
        <span className={createStyles.number}>2</span>
        <h2 id="vesting-recipient-title">Recipient</h2>
      </div>
      <WalletAddressField
        form={form}
        field="beneficiary"
        label="Recipient wallet"
        help="This address cannot change after creation."
      />
    </section>
  );
}

const SCHEDULE_KINDS = [["linear", "Linear"], ["checkpoints", "Release dates"]] as const;

function ScheduleFields({ form }: Readonly<{ form: CreationForm }>) {
  const { draft, update, timezone } = form;
  const region = useRef<HTMLDivElement>(null);
  const kinds = useRef<HTMLDivElement>(null);
  useFeedbackReveal(draft.kind, region, { duration: 180, offset: 4 });
  return (
    <section
      className={createStyles.section}
      aria-labelledby="vesting-schedule-title"
    >
      <div className={createStyles.sectionHeading}>
        <span className={createStyles.number}>3</span>
        <h2 id="vesting-schedule-title">Release schedule</h2>
        <span>All times UTC</span>
      </div>
      <div ref={kinds}>
        <Segmented
          className={createStyles.segmented}
          label="Release schedule"
          onChange={(kind) => {
            // Focus leaving the fields that are about to be replaced lands on the chosen kind.
            if (region.current?.contains(document.activeElement)) kinds.current?.querySelectorAll("button")[SCHEDULE_KINDS.findIndex(([key]) => key === kind)]?.focus({ preventScroll: true });
            update({ kind });
          }}
          options={SCHEDULE_KINDS}
          stretch
          value={draft.kind}
        />
      </div>
      <div ref={region}>
        {draft.kind === "linear" ? (
          <div className={createStyles.regularFields}>
            <ScheduleField
              id="vesting-start"
              label="Start date"
              value={draft.start}
              onChange={(start) => update({ start })}
              onBlur={() => form.touch("start")}
              error={
                form.issue?.field === "start" ? form.issue.message : undefined
              }
              timezone={timezone}
            />
            <ScheduleField
              id="vesting-end"
              label="End date"
              value={draft.end}
              onChange={(end) => update({ end })}
              onBlur={() => form.touch("end")}
              error={form.issue?.field === "end" ? form.issue.message : undefined}
              timezone={timezone}
            />

            <label>
              Cliff · days after start
              <input
                {...fieldProps(form, "cliff")}
                inputMode="numeric"
                min="0"
                onChange={(event) => update({ cliffDays: event.target.value })}
                placeholder="0"
                type="number"
                value={draft.cliffDays}
              />
              <FieldError form={form} field="cliff" />
            </label>
            <p>
              Accrued tokens become claimable at the cliff.
            </p>

      </div>
      ) : (
        <CustomReleases form={form} />
      )}
      </div>
      <FieldError form={form} field="releases" />
    </section>
  );
}

function CheckpointGenerator({ form }: Readonly<{ form: CreationForm }>) {
  const { draft, update } = form;
  const [error, setError] = useState<string | null>(null);
  function generate() {
    try {
      update({
        releases: regularCheckpointReleases(
          draft,
          amountAtoms(draft.total, draft.decimals),
          form.timezone,
        ),
      });
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Check the amount and dates.",
      );
    }
  }
  return (
    <details className={createStyles.disclosure}>
      <DisclosureSummary>Generate regular releases</DisclosureSummary>
      <div className={createStyles.regularFields}>
        <ScheduleField
          id="vesting-checkpoint-start"
          label="Start date"
          value={draft.start}
          onChange={(start) => update({ start })}
          onBlur={() => form.touch("start")}
          timezone={form.timezone}
        />
        <div className={createStyles.pair}>
          <label>
            Release interval
            <span>
              <SelectField
                value={draft.periodDays}
                onChange={(event) => update({ periodDays: event.target.value })}
              >
                <option value="1">Every day</option>
                <option value="7">Every 7 days</option>
                <option value="30">Every 30 days</option>
              </SelectField>
            </span>
          </label>
          <label>
            Number of releases
            <input
              inputMode="numeric"
              min="1"
              max="256"
              type="number"
              value={draft.periods}
              onChange={(event) => update({ periods: event.target.value })}
            />
          </label>
        </div>
        <p>
          Replaces release dates and splits the amount equally.
        </p>
        <button
          type="button"
          className="btn btn-line btn-sm"
          onClick={generate}
        >
          Generate releases
        </button>
        {error ? (
          <p className={createStyles.fieldError} role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </details>
  );
}

function CustomReleases({ form }: Readonly<{ form: CreationForm }>) {
  const { draft, update } = form;
  const [splitError, setSplitError] = useState<string | null>(null);
  function patch(key: string, value: { date?: string; amount?: string }) {
    update({
      releases: draft.releases.map((row) =>
        row.key === key ? { ...row, ...value } : row,
      ),
    });
  }
  let scheduled = ZERO_ATOMS;
  let allocationValid = true;
  for (const row of draft.releases) {
    if (!row.amount) continue;
    try {
      scheduled += amountAtoms(row.amount, draft.decimals);
    } catch {
      allocationValid = false;
    }
  }
  let total: bigint | null = null;
  try {
    total = amountAtoms(draft.total, draft.decimals);
  } catch {
    /* Await a valid locked amount. */
  }
  const canSplit = total !== null && total >= BigInt(draft.releases.length);
  function split() {
    try {
      const amounts = splitReleaseAtoms(
        amountAtoms(draft.total, draft.decimals),
        draft.releases.length,
      );
      update({
        releases: draft.releases.map((row, index) => ({
          ...row,
          amount: formatVestingAmount(amounts[index]!, draft.decimals),
        })),
      });
      setSplitError(null);
    } catch {
      setSplitError(
        "Enter enough locked coins for at least one atomic unit per release.",
      );
    }
  }
  return (
    <div
      className={createStyles.custom}
      {...fieldProps(form, "releases")}
      tabIndex={-1}
      aria-label="Checkpoint release allocation"
    >
      <CheckpointGenerator form={form} />

      <LazyMotion features={domAnimation}>
        <AnimatePresence initial={false}>
        {draft.releases.map((row, index) => (
          <ReleaseRow key={row.key} row={row} index={index} form={form}
            patch={(value) => patch(row.key, value)}
            remove={() => {
              const rowElement = document.getElementById(`vesting-amount-${row.key}`)?.closest("[data-release-row]");
              if (rowElement?.contains(document.activeElement)) {
                const next = draft.releases[index + 1] ?? draft.releases[index - 1];
                if (next) document.getElementById(`vesting-amount-${next.key}`)?.focus({ preventScroll: true });
              }
              update({ releases: draft.releases.filter(release => release.key !== row.key) });
            }} />
        ))}
        </AnimatePresence>
      </LazyMotion>
      <div className={createStyles.rowActions}>
        <button
          className="btn btn-line btn-sm"
          disabled={draft.releases.length >= 256}
          onClick={() =>
            update({
              releases: [
                ...draft.releases,
                { key: crypto.randomUUID(), date: "", amount: "" },
              ],
            })
          }
          type="button"
        >
          ＋ Add release
        </button>
        <button
          className="btn btn-ghost btn-sm"
          disabled={!canSplit}
          onClick={split}
          type="button"
        >
          Split equally
        </button>
      </div>
      <div className={createStyles.allocation}>
        <span>
          Scheduled{" "}
          <b className="num">
            {allocationValid
              ? formatVestingAmount(scheduled, draft.decimals)
              : "Check amounts"}
          </b>
        </span>
        <span>
          Remaining{" "}
          <b className="num">
            {allocationValid && total !== null
              ? `${total < scheduled ? "−" : ""}${formatVestingAmount(total < scheduled ? scheduled - total : total - scheduled, draft.decimals)}`
              : "—"}
          </b>
        </span>
      </div>
      <p>
        Split equally replaces amounts and keeps dates.
      </p>
      {splitError ? (
        <p className={createStyles.fieldError} role="alert">
          {splitError}
        </p>
      ) : null}
    </div>
  );
}

/** Presence retains only the visual row; removed releases leave the draft immediately. */
function ReleaseRow({ row, index, form, patch, remove }: Readonly<{
  row: CreationInput["releases"][number];
  index: number;
  form: CreationForm;
  patch: (value: { date?: string; amount?: string }) => void;
  remove: () => void;
}>) {
  const { draft } = form;
  const present = useIsPresent();
  // react-doctor-disable-next-line react-doctor/no-hydration-branch-on-browser-global -- AnimatePresence initial={false} uses identical animate styles for SSR and hydration; preferences affect later motion.
  const immediate = instantFeedback();
  return <m.div
    className={createStyles.releaseRow}
    data-release-row=""
    inert={!present || undefined}
    aria-hidden={!present || undefined}
    initial={{ opacity: immediate ? 1 : 0, transform: immediate ? "translateY(0)" : "translateY(4px)" }}
    animate={{ opacity: 1, transform: "translateY(0)" }}
    exit={{ opacity: 0, transform: "translateY(0)", transition: { duration: immediate ? 0 : T1 / 1000 } }}
    transition={{ duration: immediate ? 0 : .18, ease: EASE_OUT_ARRAY }}
  >
    <span className={createStyles.releaseNumber}>
      Release {index + 1}
    </span>
    <ScheduleField
      id={`vesting-date-${row.key}`}
      label={`Release ${index + 1} date`}
      value={row.date}
      onChange={(date) => patch({ date })}
      onBlur={() => form.touch(`date-${row.key}`)}
      timezone={form.timezone}
      error={
        form.issue?.field === `date-${row.key}`
          ? form.issue.message
          : undefined
      }
    />
    <label>
      Amount
      <input
        {...fieldProps(form, `amount-${row.key}`)}
        inputMode="decimal"
        onChange={(event) =>
          patch({ amount: event.target.value })
        }
        placeholder="0.00"
        value={row.amount}
      />
      <FieldError form={form} field={`amount-${row.key}`} />
    </label>
    <button
      aria-label={`Remove release ${index + 1}`}
      className={`icon-btn ${createStyles.remove}`}
      disabled={draft.releases.length === 1}
      onClick={remove}
      type="button"
    >
      <CloseIcon />
    </button>
  </m.div>;
}

function CancellationFields({ form }: Readonly<{ form: CreationForm }>) {
  const { draft, update } = form;
  return (
    <section
      className={createStyles.section}
      aria-labelledby="vesting-cancellation-title"
    >
      <div className={createStyles.cancellationRow}>
        <div>
          <h2 id="vesting-cancellation-title">Allow cancellation</h2>
          <p>
            {draft.cancelable
              ? "Accrued funds go to the recipient. Unvested funds return to the refund wallet."
              : "Nobody can end this schedule early."}
          </p>
        </div>
        <Switch
          busy={false}
          label="Allow cancellation"
          on={draft.cancelable}
          onChange={(cancelable) => update({ cancelable })}
        />
      </div>
      <Collapse open={draft.cancelable} className={createStyles.cancellationReveal}
        focusOnClose={() => document.querySelector<HTMLElement>('[role="switch"][aria-label="Allow cancellation"]')}>
        <div className={createStyles.conditionalFields}>
          <button
            className={`btn btn-line btn-sm ${createStyles.bothWallets}`}
            disabled={!form.wallet.wallet}
            type="button"
            onClick={() =>
              update({
                refund: form.wallet.wallet!,
                capRecipient: form.wallet.wallet!,
              })
            }
          >
            <WalletIcon /> Use my wallet for both
          </button>
          <WalletAddressField
            form={form}
            field="refund"
            label="Refund wallet"
            help="Receives unvested funds if cancelled."
          />
          <WalletAddressField
            form={form}
            field="capRecipient"
            label="Who can cancel"
            help="Receives the transferable authority to cancel this schedule."
          />
          <details className={createStyles.disclosure}>
            <DisclosureSummary>How cancellation authority works</DisclosureSummary>
            <p>
              Cancellation authority transfers with the CancelCap. Claimed funds stay with the recipient.
            </p>
          </details>
        </div>
      </Collapse>
    </section>
  );
}
