"use client";

import { useCallback, useEffect, useState } from "react";

import { IntentLink } from "#web/components/blast-ui/NavigationLink.tsx";
import { SheetCta } from "#web/components/blast-ui/Sheet.tsx";
import { CheckIcon } from "./create-icons";
import type { CreateState } from "./create-store";
import { CreateLaunchScene } from "./CreateLaunchScene";
import { LaunchFlight } from "./LaunchFlight";
import { draftQuote } from "@blast/core/modules/social/create/model.ts";
import { cx } from "./cx";
import { PRESALE_SIGN_STEPS, presaleSignLabel, publishOffLine } from "./create-review-model";
import { SignLabelText } from "./fields";
import { DiagnosticText } from "#web/components/blast-ui/DiagnosticText.tsx";

const STAGES: Readonly<Record<string, number>> = {
  "1 of 4 · Publish coin": 0,
  "2 of 4 · Register currency": 1,
  "3 of 4 · Create presale": 2,
  "4 of 4 · Finalizing coin": 3,
};
const TITLES = ["A coin is born.", "Making it official.", "Building your launch.", "Finalizing coin."];

/** The scene advances only when the publish flow reports its next real operation. */
export function CreatePublishProgress({ state, onRetry }: Readonly<{ state: CreateState; onRetry?: () => void }>) {
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  const title = useCallback((node: HTMLHeadingElement | null) => {
    // Inside the scrim so the viewport flight stays above its blur and the sheet.
    setPortal(node?.closest<HTMLElement>("[data-sheet-scrim], [data-blast-ui]") ?? null);
  }, []);
  const published = state.publishedPresaleId !== null;
  const paused = state.publishError !== null;
  const stage = published ? 3 : STAGES[state.publishProgress ?? ""] ?? -1;
  const resuming = state.publishProgress === null && !published;
  const { heading, detail } = launchCopy(state, stage, published, paused, resuming);

  useEffect(() => { portal?.querySelector<HTMLElement>("#cr-review-title")?.focus({ preventScroll: true }); }, [portal]);

  return <>
    <LaunchFlight active={published} portal={portal} />
    <div className={cx("cr-launch")} data-stage={stage} data-paused={paused || resuming} data-published={published}>
      <span className={cx("cr-launch-eyebrow")}>${state.draft.symbol} · Sui mainnet</span>
      <CreateLaunchScene logo={state.logoPreview ?? state.logoUrl} name={state.draft.name} published={published} quoteSymbol={draftQuote(state.draft).symbol} stage={stage} symbol={state.draft.symbol} venue={state.draft.venue} />
      <div aria-atomic="true" className={cx("cr-launch-copy")} role="status">
        <h2 className={cx("cr-launch-title")} id="cr-review-title" ref={title} tabIndex={-1}>{heading}</h2>
        {detail ? <p>{detail}</p> : null}
      </div>
      {paused ? <p className={cx("cr-launch-error")} role="alert"><DiagnosticText message={state.publishError!} /></p> : null}
      <div className={cx("cr-launch-list")}>
        <h3 id="cr-publish-steps">Publishing steps</h3>
        <ol aria-labelledby="cr-publish-steps" className={cx("cr-launch-steps")}>
          {PRESALE_SIGN_STEPS.map((step, index) => {
            const complete = published || stage > index;
            const active = !published && stage === index;
            return <li aria-current={active ? "step" : undefined} data-complete={complete} data-active={active} key={step}>
              <span aria-hidden="true" className={cx("cr-launch-step-icon")}>{complete ? <CheckIcon /> : index + 1}</span>
              <span><SignLabelText label={presaleSignLabel(step, state.draft.symbol)} /></span>
              <small>{complete ? (index === 3 ? "Saved" : "Confirmed") : active ? (paused ? "Paused" : "In progress") : "Up next"}</small>
            </li>;
          })}
        </ol>
      </div>
    </div>
    <PublishFooter state={state} stage={stage} onRetry={onRetry} />
  </>;
}

function launchCopy(state: CreateState, stage: number, published: boolean, paused: boolean, resuming: boolean) {
  if (published) return { heading: "Your presale is published.", detail: `${state.draft.name.trim()} has landed. Your presale page is ready to share.` };
  // Paused: no subtitle. The error says what failed, the note says progress is saved, and the button says what happens next.
  if (paused) return { heading: stage === 3 ? "Your presale is on-chain." : "Let’s finish this.", detail: null };
  // A running stage has no subtitle: the step list says what is in progress (TS-2).
  const detail = resuming ? "We’ll check your transactions and continue from there." : stage < 0 ? "Saving your draft and getting your wallet ready." : null;
  return { heading: resuming ? "Pick up where you left off." : TITLES[stage] ?? "Ready for liftoff.", detail };
}

function PublishFooter({ state, stage, onRetry }: Readonly<{ state: CreateState; stage: number; onRetry?: () => void }>) {
  if (state.publishedPresaleId) return <SheetCta className={cx("cr-cta cr-launch-cta")}>
    <IntentLink className="btn btn-primary btn-lg btn-block" href={`/presale/${state.publishedPresaleId}`}>View presale <span aria-hidden="true">↗</span></IntentLink>
  </SheetCta>;
  const waiting = state.publishProgress !== null && state.publishError === null;
  const off = state.publish.available ? null : publishOffLine(state.publish.reasons, state.publishError === null);
  return <SheetCta className={cx("cr-cta cr-launch-cta")}>
    {/* Paused: one muted line under the steps says what was kept, once; the error above it does not repeat it. */}
    {waiting ? <p className={cx("snote")}>{stage >= 3 ? "No wallet approval needed. Saving your presale’s images and links." : "Follow your wallet’s prompts. Each step waits for confirmation."}</p>
      : state.publishError !== null ? <p className={cx("snote")}>Your progress is saved.</p> : null}
    {off ? <p className={cx("cr-soon")}>{off}</p> : null}
    <button className="btn btn-primary btn-lg btn-block" disabled={waiting || !onRetry || off !== null} onClick={onRetry} type="button">
      {waiting ? <><span aria-hidden="true" className={cx("cr-launch-spinner")} />{stage >= 3 ? "Finalizing coin" : "Publishing on Sui"}</> : stage === 3 ? "Retry finalization" : "Resume publishing"}
    </button>
  </SheetCta>;
}
