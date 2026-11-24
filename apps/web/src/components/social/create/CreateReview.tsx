"use client";

import { useId, type ReactNode } from "react";

import { Sheet, SheetClose } from "#web/components/blast-ui/Sheet.tsx";
import { Button } from "#web/components/blast-ui/Button.tsx";
import type { CreateIssue } from "@blast/core/web/contracts/create.ts";

import { createStore, usePublishAction, type CreateState } from "./create-store";
import { cx } from "./cx";
import { authenticatedAction } from "../sign-in-gate";
import { useSocialViewer } from "../SignInGate";
import { useShellActions } from "#web/components/blast-ui/shell-actions.tsx";
import { createBlockedReason, publishCostSentence, publishOffLine } from "./create-review-model";
import { review } from "./create-navigation";
import { CreatePublishProgress } from "./CreatePublishProgress";

/** The review action shared by the rail and the sticky bar. */
export function usePublishControl(state: CreateState, issues: readonly CreateIssue[]) {
  const viewer = useSocialViewer();
  const run = useShellActions();
  const publish = usePublishAction();
  const ids = useId();
  const off = state.publish.available ? null : publishOffLine(state.publish.reasons);
  const blocked = publishBlocked(state, issues, off, !!publish);
  const action = authenticatedAction(viewer, "Publish presale", "Sign in", blocked);
  const onClick = () => {
    if (!viewer.signedIn) run("openSignIn");
    else if (issues.length) review(issues);
    else if (!blocked && state.step === "review") publish?.();
  };
  const cost = viewer.signedIn && !blocked ? publishCostSentence(state.networkFees) : null;
  return { viewer, ids, off, blocked, action, onClick, cost, reason: blocked && !off ? createBlockedReason(state, issues) : null };
}

type PublishControl = ReturnType<typeof usePublishControl>;

/**
 * Publishing (the CreateReview board's right column): Publish under its money
 * sentence, which also says the terms lock (the wallet's signatures are
 * Review's last folded row). Publishing needs the presale contract on
 * mainnet; until then Publish is off and the card says why (OA-13), and
 * nothing is sent. With something left to fix, Publish stays disabled and the
 * line above it names what is missing. Below 1220px the page pins
 * `PublishAction` in the sticky bar and shows this card only for the off line.
 */
export function PublishCard({ control, children }: Readonly<{ control: PublishControl; children?: ReactNode }>) {
  const { ids, off } = control;
  return (
    <section aria-label="Publishing" className={cx("card cr-publish")}>
      {off ? (
        <p className={cx("cr-soon")} id={`${ids}-off`} role="status">{off}</p>
      ) : null}
      {children}
    </section>
  );
}

/** The money sentence, Publish (or Sign in when signed out), and the reason line (what is missing, named). */
export function PublishAction({ control }: Readonly<{ control: PublishControl }>) {
  const { viewer, ids, off, blocked, action, onClick, cost, reason } = control;
  return (
    <>
      {cost ? <p className={cx("cr-cost")} id={`${ids}-cost`}>{cost}</p> : null}
      <Button
        aria-describedby={off ? `${ids}-off` : blocked ? `${ids}-checks` : cost ? `${ids}-cost` : undefined}
        className={cx("cr-publish-btn")}
        disabled={action.disabled}
        loading={viewer.sessionPending === true}
        loadingLabel="Restoring session…"
        onClick={onClick}
        size="lg"
        variant="primary"
      >
        {viewer.sessionPending ? "Publish presale" : action.label}
      </Button>
      {reason !== null ? <p className={cx("cr-note")} id={`${ids}-checks`} role="status">{reason}</p> : null}
    </>
  );
}

/**
 * The publishing sheet: once Publish is pressed (or saved progress resumes),
 * the creation scene follows each confirmed step until the presale is live.
 * The wallet signs the server's plan one step at a time.
 */
export function CreateReview({ state, onPublish }: Readonly<{ state: CreateState; onPublish?: () => void }>) {
  const close = () => {
    if (state.publishedPresaleId !== null) createStore.startNewDraft();
    else createStore.set({ reviewOpen: false });
  };
  const publishing = state.publishProgress !== null || state.publishError !== null || state.publishLocked || state.publishedPresaleId !== null;
  return (
    <Sheet className={cx("cr-sheet")} hasCta labelledBy="cr-review-title" onRequestClose={close} open={state.reviewOpen && publishing}>
      <SheetClose onClick={close} />
      {publishing ? <CreatePublishProgress onRetry={onPublish} state={state} /> : null}
    </Sheet>
  );
}

function publishBlocked(state: CreateState, issues: readonly CreateIssue[], off: string | null, publish: boolean) {
  const busy = state.logoPreview !== null || state.coverPreview !== null || state.allowlistUploading || state.publishLocked;
  const blocked = state.phase !== "ready" || issues.length > 0 || off !== null || !publish || busy;
  return blocked;
}
