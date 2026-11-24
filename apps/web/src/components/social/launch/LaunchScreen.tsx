"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useLayoutEffect } from "react";

import { Button } from "#web/components/blast-ui/Button.tsx";
import { DiagnosticCode } from "#web/components/blast-ui/DiagnosticText.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { diagnosticMessage } from "#web/lib/errors.ts";
import { HOME_PATH } from "#web/components/blast-ui/nav.ts";
import { PageHeader } from "#web/components/blast-ui/PageHeader.tsx";
import { SegmentedLinks } from "#web/components/blast-ui/Segmented.tsx";
import { usePrivySessionMounted } from "#web/components/presale/providers/PrivySessionProvider.tsx";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { quotePriceType } from "@blast/core/web/contracts/create.ts";
import type { LaunchPageContext } from "@blast/core/web/contracts/launch.ts";

import { PrivyCoinSignerBridge, type PrivyCoinSigner } from "../coins/signers.tsx";
import { DoneIcon } from "../create/create-icons";
import { PreviousIcon } from "#web/components/blast-ui/Icons.tsx";
import { networkFeesOf, selfAddressOf } from "../create/create-screen-model";
import { stepDone } from "../create/create-steps";
import { cx } from "../create/cx";
import { AllocationStep } from "../create/fields";
import { useQuoteUsd } from "../prices/use-quote-usd";
import { SignInLink, useSocialViewer } from "../SignInGate";
import { useSocialAccount } from "../use-social-account";
import { CoinStep, CurveStep, DetailsStep } from "./LaunchForm";
import { LaunchLoadingFields } from "./LaunchLoading";
import { LaunchAside, LaunchSheet, ReviewStep } from "./LaunchReview";
import { LAUNCH_STEP_LABEL, LAUNCH_STEPS, goToLaunchStep, initialLaunchState, issuesOf, launchPublishAction, launchStore, minimumQuoteTarget, stepOfIssue, useLaunchState, useLaunchStepLocation, type LaunchState, type LaunchStep } from "./launch-store";
import { lcx } from "./lcx";
import { NOT_LOADED, useLaunchApi, useLaunchImages, useLaunchLoad, useLaunchPublish, useLaunchSave } from "./use-launch-draft";

const OFF_LINES: Readonly<Record<string, string>> = {
  launchpad_not_deployed: "Launching isn’t available on this deployment yet.",
  launch_config: "Launch settings couldn’t be read. Try again in a minute.",
  quote_not_admitted: "No coin is open for launches right now.",
};

function StepBar({ state }: Readonly<{ state: LaunchState }>) {
  const issues = useMemo(() => issuesOf(state), [state]);
  const open = (step: LaunchStep) => issues.some((issue) => stepOfIssue(issue) === step);
  return (
    <div className={cx("cr-steps-bar")} data-create-steps="">
      <SegmentedLinks
        className={cx("cr-steps")}
        items={LAUNCH_STEPS.map((step) => ({ href: `#${step}`, label: stepDone(LAUNCH_STEPS, step, state.step, open) ? <><DoneIcon />{LAUNCH_STEP_LABEL[step]}<span className="sr-only">, done</span></> : LAUNCH_STEP_LABEL[step], current: step === state.step }))}
        label="Steps"
        onNavigate={(index) => goToLaunchStep(LAUNCH_STEPS[index]!)}
      />
    </div>
  );
}

/** The open step, or the state card that stands in for it. */
function StepBody({ state, onLogo, onCover, onCoverRemove }: Readonly<{ state: LaunchState; onLogo: (file: File) => void; onCover: (file: File) => void; onCoverRemove: () => void }>) {
  const issues = useMemo(() => issuesOf(state), [state]);
  if (state.phase === "visitor") return <EmptyState action={<SignInLink />} framed title="Sign in to launch a coin" />;
  if (state.phase === "error") {
    return (
      <EmptyState action={<Button onClick={() => location.reload()} size="sm">Try again</Button>} framed role="alert" title="Your draft couldn’t load">
        <DiagnosticCode generic={NOT_LOADED} message={state.errorMessage ?? diagnosticMessage(NOT_LOADED)} />
      </EmptyState>
    );
  }
  if (state.phase === "loading") return <LaunchLoadingFields />;
  if (!state.rules) return null;
  const form = { state, issues, rules: state.rules };
  return <>
    {state.step === "coin" ? <CoinStep form={form} onLogo={onLogo} /> : null}
    <AllocationStep active={state.step === "curve"} key={`${state.accountId}:${state.draftId}`}>
      <CurveStep form={form} />
    </AllocationStep>
    {state.step === "details" ? <DetailsStep form={form} onCover={onCover} onCoverRemove={onCoverRemove} /> : null}
    {state.step === "review" ? <ReviewStep state={state} /> : null}
  </>;
}

/** The Curve step and the separate Review rail share the same minimum. */
function useRaiseMinimum({ draft, phase, publishing, rules }: Pick<LaunchState, "draft" | "phase" | "publishing" | "rules">): void {
  const quoteType = draft.quote_type;
  const needsPrices = phase === "ready" && !publishing && rules?.quotes.includes(quoteType) && quotePriceType(quoteType) !== SUI_COIN_TYPE;
  const minimumQuoteType = needsPrices ? quoteType : null;
  const suiUsd = useQuoteUsd(needsPrices ? SUI_COIN_TYPE : null);
  const quoteUsd = useQuoteUsd(minimumQuoteType, { marketRate: true });
  useLayoutEffect(() => {
    const amount = minimumQuoteTarget(suiUsd, quoteUsd);
    launchStore.set({ raiseMinimum: minimumQuoteType && amount !== null ? { quoteType: minimumQuoteType, amount } : null });
  }, [minimumQuoteType, suiUsd, quoteUsd]);
}

/**
 * `/launch` (a bonding-curve coin): the account's newest unpublished launch
 * draft, or a fresh one, saved after each pause in typing; four steps like
 * Create's, the right column in the shell's medium aside (folded under the
 * step on narrow screens), and launching in a sheet.
 */
export function LaunchScreen({ context }: Readonly<{ context: LaunchPageContext }>) {
  const viewer = useSocialViewer();
  const { status, account } = useSocialAccount();
  useLayoutEffect(() => {
    launchStore.reset(initialLaunchState(context));
  }, [context]);
  const state = useLaunchState();
  useRaiseMinimum(state);
  const privyMounted = usePrivySessionMounted();
  const privy = useRef<PrivyCoinSigner | null>(null);
  const onSigner = useCallback((signer: PrivyCoinSigner | null) => {
    privy.current = signer;
  }, []);
  const api = useLaunchApi(viewer);
  useLaunchStepLocation();
  useLaunchLoad({ context, signedIn: viewer.signedIn, sessionPending: viewer.sessionPending === true, ready: status === "ready", accountId: viewer.signedIn ? account?.account_id ?? null : null, api });
  const save = useLaunchSave(api, state);
  const images = useLaunchImages(api, save);
  const launch = useLaunchPublish(api, save, privy);
  useEffect(() => {
    launchPublishAction.set(launch);
    return () => {
      if (launchPublishAction.get() === launch) launchPublishAction.set(null);
    };
  }, [launch]);

  // The account's wallet and who pays launching's network fees.
  useEffect(() => {
    launchStore.set({ selfAddress: selfAddressOf(account ?? null), networkFees: networkFeesOf(account ?? null) });
  }, [account, context]);

  const off = state.phase === "off" ? OFF_LINES[context.publish.reasons[0] ?? "launch_config"] ?? OFF_LINES.launch_config! : null;
  return (
    <div className={`${cx("createPage")} ${lcx("lc-page")}`} data-create-page="" data-launch-page="" data-shell-aside="medium" data-step={state.step}>
      {privyMounted ? <PrivyCoinSignerBridge onChange={onSigner} /> : null}
      <div className={cx("backbar")} data-back-bar="">
        <Link href={HOME_PATH}><PreviousIcon strokeWidth="2" />Home</Link>
      </div>
      {off ? null : <StepBar state={state} />}
      <PageHeader title={state.step === "review" ? "Review and launch" : "Launch a coin"} />
      <div aria-label={LAUNCH_STEP_LABEL[state.step]} className={cx("cr-body")} data-launch-step="" role="group" tabIndex={-1}>
        {off ? <EmptyState framed title="Launching is off">{off}</EmptyState> : (
          <>
            <fieldset disabled={state.publishing} className={lcx("lc-fields")}>
            {state.publishing ? <p role="status">Launching has started. These settings are saved; resume from Review.</p> : null}
            <StepBody onCover={(file) => void images.upload("cover", file)} onCoverRemove={() => void images.removeCover()} onLogo={(file) => void images.upload("logo", file)} state={state} />
            </fieldset>
            <LaunchAside placement="page" state={state} />
          </>
        )}
      </div>
      <LaunchSheet onLaunch={launch} state={state} />
    </div>
  );
}
