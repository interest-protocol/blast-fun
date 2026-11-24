"use client";

import Link from "next/link";
import { diagnosticMessage } from "#web/lib/errors.ts";
import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";

import { HOME_PATH } from "#web/components/blast-ui/nav.ts";
import { SegmentedLinks } from "#web/components/blast-ui/Segmented.tsx";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { DiagnosticCode } from "#web/components/blast-ui/DiagnosticText.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { PageHeader } from "#web/components/blast-ui/PageHeader.tsx";

import { useBoundaryClock } from "../use-boundary-clock";
import { createPublishAction, createStore, issuesOf, type CreateState } from "./create-store";
import { DoneIcon } from "./create-icons";
import { PreviousIcon } from "#web/components/blast-ui/Icons.tsx";
import { CreateForm } from "./CreateForm";
import { CreateAside } from "./CreatePreview";
import { CreateReview } from "./CreateReview";
import { CreateSummary } from "./CreateSummary";
import { goToStep, useStepLocation } from "./create-navigation";
import { CREATE_STEPS, STEP_LABEL, stepDone, stepHash, issueStep, type CreateStep } from "./create-steps";
import { cx } from "./cx";
import type { AllowlistActions } from "./AllowlistCard";
import { QuotePicker } from "./QuotePicker";

/**
 * The step bar (every Create board): Token · Raise · Details ·
 * Review as the shared segmented links, the current step on the neutral
 * thumb and each finished step before it checked. Each is a link (`#raise`) a plain
 * click opens in place. Beside the title on desktop; under it, pinned below
 * the top bar, where the right column is folded into the page.
 */
function StepBar({ step, issues }: Readonly<{ step: CreateStep; issues: ReturnType<typeof issuesOf> }>) {
  const open = (item: CreateStep) => issues.some((issue) => issueStep(issue) === item);
  return (
    <div className={cx("cr-steps-bar")} data-create-steps="">
      <SegmentedLinks
        className={cx("cr-steps")}
        items={CREATE_STEPS.map((item) => ({
          href: stepHash(item),
          label: stepDone(CREATE_STEPS, item, step, open) ? <><DoneIcon />{STEP_LABEL[item]}</> : STEP_LABEL[item],
          current: item === step,
        }))}
        label="Steps"
        onNavigate={(index) => goToStep(CREATE_STEPS[index]!)}
      />
    </div>
  );
}

/** The pinned step bar sits under the top bar, whose height can change (a wrapped account message on phones). */
function usePinnedOffsets(page: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const root = page.current;
    const bar = root?.querySelector<HTMLElement>("[data-create-steps]");
    const header = document.querySelector<HTMLElement>("[data-shell-topbar]");
    if (!root || !bar) return;
    const measure = () => {
      root.style.setProperty("--cr-nav-height", `${bar.getBoundingClientRect().height}px`);
      if (header) {
        root.style.setProperty("--cr-header-height", `${header.getBoundingClientRect().height}px`);
        root.style.setProperty("--cr-header-top", getComputedStyle(header).top);
      }
    };
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    if (header) observer.observe(header);
    measure();
    return () => observer.disconnect();
  }, [page]);
}

/** The right column's Publish reaches the page's publishing through the store's registry. */
function usePublishRegistry(onPublish: (() => void) | undefined) {
  const latest = useRef(onPublish);
  useEffect(() => {
    latest.current = onPublish;
  });
  const available = onPublish !== undefined;
  useEffect(() => {
    if (!available) return;
    const run = () => latest.current?.();
    createPublishAction.set(run);
    return () => {
      if (createPublishAction.get() === run) createPublishAction.set(null);
    };
  }, [available]);
}

/**
 * A chosen start that passes while the form sits idle (#588): the page's
 * clock (`nowMs`) moves to that moment, so every check of the draft reruns
 * and reads it as past, as the server will, and the Opens field's min and
 * max count from it.
 */
function useStartClock(state: CreateState) {
  const clock = useBoundaryClock(state.draft.start_ms, state.nowMs);
  useEffect(() => {
    if (clock > state.nowMs) createStore.set({ nowMs: clock });
  }, [clock, state.nowMs]);
}

/** The draft read's generic failure: the load error's title already says it, so only its code shows. */
export const DRAFT_NOT_LOADED = "Your draft could not load. Try again.";

/**
 * The Create page (the CreateToken, CreateRaise, Create and CreateReview
 * boards): back to Home, the title and the step bar, then the current step,
 * with its right column in the shell's medium aside (folded under the step
 * below 1220px). Loading holds the disabled form; a failed read replaces
 * the step and its column with a state card, and a signed-out viewer adds
 * one under the form (OA-13). Publishing runs in a sheet.
 */
export function CreateView({
  state,
  onLogo,
  onCover,
  onCoverRemove,
  onList,
  allowlistActions,
  onRetry,
  onPublish,
  signIn,
}: Readonly<{
  state: CreateState;
  onLogo: (file: File) => void;
  /** R3-25: the sale's cover picked, and removed. */
  onCover?: (file: File) => void;
  onCoverRemove?: () => void;
  onList: (file: File) => void;
  allowlistActions?: AllowlistActions;
  onRetry: () => void;
  onPublish?: () => void;
  signIn: ReactNode;
}>) {
  const issues = useMemo(() => issuesOf(state), [state]);
  const page = useRef<HTMLDivElement>(null);
  useStartClock(state);
  useStepLocation(state.step);
  usePinnedOffsets(page);
  usePublishRegistry(onPublish);
  return (
    <div className={cx("createPage")} data-create-page="" data-shell-aside="medium" data-step={state.step} ref={page}>
      <div className={cx("backbar")} data-back-bar="">
        <Link href={HOME_PATH}>
          <PreviousIcon strokeWidth="2" />
          Home
        </Link>
      </div>
      <StepBar step={state.step} issues={issues} />
      <PageHeader title={state.step === "review" ? "Review and publish" : "Create a presale"} />
      <div aria-label={STEP_LABEL[state.step]} className={cx("cr-body")} data-create-step={state.step} role="group" tabIndex={-1}>
        {/* A draft that could not load replaces the step (as Launch does): no blank form to fill and nothing to continue. */}
        {state.phase === "error" ? (
          <EmptyState action={<Button onClick={onRetry} size="sm">Try again</Button>} framed role="alert" title="Your draft couldn’t load">
            <DiagnosticCode generic={DRAFT_NOT_LOADED} message={state.errorMessage ?? diagnosticMessage(DRAFT_NOT_LOADED)} />
          </EmptyState>
        ) : (
          <CreateForm allowlistActions={allowlistActions} issues={issues} onCover={onCover} onCoverRemove={onCoverRemove} onList={onList} onLogo={onLogo} state={state} />
        )}
        {state.step === "review" && state.phase !== "error" ? <CreateSummary issues={issues} state={state} /> : null}
        {state.phase === "visitor" ? <EmptyState action={signIn} framed title="Sign in to save your draft" /> : null}
        <CreateAside placement="page" state={state} />
      </div>
      <CreateReview onPublish={onPublish} state={state} />
      <QuotePicker state={state} />
    </div>
  );
}
