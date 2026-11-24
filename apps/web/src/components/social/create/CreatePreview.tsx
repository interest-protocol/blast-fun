"use client";
import { quoteDisplaySymbol } from "./quote-coins";

import { useMemo, type ReactNode } from "react";

import type { CreateIssue } from "@blast/core/web/contracts/create.ts";
import { draftQuote, draftTerms } from "@blast/core/modules/social/create/model.ts";
import { presaleTargetDecimals } from "@blast/core/modules/social/create/minimum-raise.ts";
import { fieldNumber, NO_VALUE, usd } from "@blast/core/web/format.ts";
import { Button } from "#web/components/blast-ui/Button.tsx";

import { issuesOf, useCreateState, type CreateState } from "./create-store";
import { draftPrices, premiumText } from "./create-money";
import { cx } from "./cx";
import { Ticker } from "#web/components/blast-ui/Ticker.tsx";
import { CoinMark, MobilePreview } from "./fields";
import { checklistOf } from "./create-preview-model";
import { goToStep, review } from "./create-navigation";
import { PublishAction, PublishCard, usePublishControl } from "./CreateReview";
import { QuoteMark } from "./QuotePicker";
import { ReadinessHeading } from "./ReadinessHeading";


/** The cover at 3:1, or the empty slot that says it is not added. */
function CoverSlot({ state }: Readonly<{ state: CreateState }>) {
  const cover = state.coverPreview ?? state.cover?.url;
  return (
    <div className={cx("cr-cover-slot", cover && "has-cover")}>
      {cover ? (
        // eslint-disable-next-line @next/next/no-img-element -- the sale's cover, or the picked file while it uploads
        <img alt="" height={512} src={cover} width={1_536} />
      ) : (
        <span>Cover image · not added</span>
      )}
    </div>
  );
}

function Identity({ state, over = false }: Readonly<{ state: CreateState; over?: boolean }>) {
  const { draft } = state;
  const name = draft.name.trim();
  return (
    <div className={cx("cr-id", over && "over")}>
      <CoinMark draft={draft} logo={state.logoPreview ?? state.logoUrl} size={over ? "s50" : "s46"} />
      <span className={cx("t")}>
        <b className={name ? undefined : cx("cr-none")}>{name || NO_VALUE}</b>
        <span className={draft.symbol ? undefined : cx("cr-none")}>
          {draft.symbol ? <><Ticker symbol={draft.symbol} /> · Presale</> : NO_VALUE}
        </span>
      </span>
    </div>
  );
}

/**
 * The sale's prices: the Summary keeps both (the launch price carries its
 * premium), the Preview only the presale price (TS-4: progress, target and
 * price). A figure the draft can't make yet is left out.
 */
function Terms({ state, compact = false }: Readonly<{ state: CreateState; compact?: boolean }>) {
  const { draft, fees } = state;
  const terms = draftTerms(draft, fees);
  const prices = draftPrices(draft, terms.price, terms.launch);
  return (
    <dl className={cx("cr-rows", compact && "compact")}>
      {terms.price ? (
        <div>
          <dt>Presale price</dt>
          <dd className="num">{prices.presale}</dd>
        </div>
      ) : null}
      {!compact && terms.price && terms.launch ? (
        <div>
          <dt>Launch price</dt>
          <dd className="num">{prices.launch} <span className={cx("muted")}>{premiumText(terms.premium)}</span></dd>
        </div>
      ) : null}
    </dl>
  );
}

/** Token (CreateToken board): the coin as presale cards will show it. */
function Appearance({ state }: Readonly<{ state: CreateState }>) {
  return (
    <>
      <span className={cx("cr-aside-label")}>How it appears</span>
      <div className={cx("card cr-appear")}>
        <CoverSlot state={state} />
        <Identity state={state} />
      </div>
    </>
  );
}

/** Raise (CreateRaise board): the prices. The pool, who can join, the target and the Blast fee stay in their fields and tiles. */
function Summary({ state }: Readonly<{ state: CreateState }>) {
  return (
    <>
      <span className={cx("cr-aside-label")}>Summary</span>
      <div className={cx("card cr-summary")}>
        <Terms state={state} />
      </div>
    </>
  );
}

/** Raise's Continue: under the Summary in the right column, pinned above the tab bar on phones. */
function ContinueAction({ state }: Readonly<{ state: CreateState }>) {
  return (
    <Button className={cx("cr-aside-cta")} loading={state.phase === "loading"} loadingLabel="Loading your draft" onClick={() => goToStep("details")} size="lg" variant="primary">
      Continue
    </Button>
  );
}

/** Details (Create board): the presale card as buyers will see it, before anything is raised. */
function Preview({ state }: Readonly<{ state: CreateState }>) {
  const { draft } = state;
  const symbol = quoteDisplaySymbol(draftQuote(draft).symbol);
  const usdc = symbol === "USDC";
  return (
    <>
      <span className={cx("cr-aside-label")}>Preview</span>
      <div className={cx("card cr-preview")}>
        <CoverSlot state={state} />
        <Identity over state={state} />
        <span aria-hidden="true" className={cx("cr-progress")} />
        <span className={cx("cr-raised")}>
          <QuoteMark size={18} symbol={symbol} />
          <b className="num">{usdc ? "$0" : `0 ${symbol}`}</b>
          <span>of {usdc ? usd(draft.target) : fieldNumber(draft.target, presaleTargetDecimals(draft.quote_type))} target</span>
        </span>
        <Terms compact state={state} />
      </div>
    </>
  );
}

/**
 * What is left before publishing (Create board): only the open sections, each
 * open item a fix that opens its step and field. Done sections are not
 * listed and there is no meter: the stepper already marks them done (TS-2).
 * While the draft loads only the heading shows: an empty draft's to-do list would flash.
 */
export function Readiness({ issues, state }: Readonly<{ issues: readonly CreateIssue[]; state: CreateState }>) {
  const todo = checklistOf(issues).filter(({ open }) => open.length);
  const loading = state.phase === "loading";
  return (
    <div className={cx("cr-ready")} inert={loading}>
      <ReadinessHeading done={todo.length === 0} label="Ready to publish" loading={loading} loadingLabel="Loading publishing checks" />
      {!loading && todo.length ? <ul aria-label="Before publishing" className={cx("cr-checks")}>
        {todo.map(({ section, label, open }) => (
          <li className={cx("todo")} key={section}>
            <span aria-hidden="true" className={cx("ic")} />
            <span className={cx("t")}>
              <b>{label}</b>
              {open.map((issue) => <button aria-label={`${label}: ${issue.message}`} key={issue.path} onClick={() => review([issue])} type="button">{issue.message}</button>)}
            </span>
          </li>
        ))}
      </ul> : null}
    </div>
  );
}

/**
 * The right column for one state of the draft, per step: how the coin
 * appears (Token), the Summary and Continue (Raise), the card preview and
 * what is left (Details), and publishing (Review). Below 1220px the
 * shell hides its column, so the page shows the same column after the step
 * (`placement="page"`), in the boards' order.
 */
export function CreateAside({ state, placement }: Readonly<{ state: CreateState; placement: Placement }>) {
  const issues = useMemo(() => issuesOf(state), [state]);
  // A draft that could not load has no column: its error card stands in for the step, with nothing to continue.
  if (state.phase === "error") return null;
  if (state.step === "review") return <ReviewAside issues={issues} placement={placement} state={state} />;
  const preview = state.step === "token" ? <Appearance state={state} />
    : state.step === "raise" ? <Summary state={state} />
    : <Preview state={state} />;
  const content = <>
    {placement === "page" ? <MobilePreview key={state.step}>{preview}</MobilePreview> : preview}
    {state.step === "details" ? <Readiness issues={issues} state={state} /> : null}
  </>;
  return <AsideFrame action={state.step === "raise" ? <ContinueAction state={state} /> : null} placement={placement} state={state}>{content}</AsideFrame>;
}

type Placement = "rail" | "page";

/** Review's column: the publishing card, with Publish inside it in the rail and pinned below it on phones, where the card shows only while publishing is off (no empty box). */
function ReviewAside({ state, issues, placement }: Readonly<{ state: CreateState; issues: readonly CreateIssue[]; placement: Placement }>) {
  const control = usePublishControl(state, issues);
  const action = <PublishAction control={control} />;
  return (
    <AsideFrame action={placement === "page" ? action : null} placement={placement} state={state}>
      {placement === "rail" || control.off ? <PublishCard control={control}>{placement === "rail" ? action : null}</PublishCard> : null}
    </AsideFrame>
  );
}

/**
 * The column, and the step's primary action. In the rail the action closes
 * the column; on the page (below 1220px) it follows the folded column as the
 * shared sticky action, so it stays in reach above the tab bar on phones.
 */
function AsideFrame({ state, placement, action, children }: Readonly<{ state: CreateState; placement: Placement; action: ReactNode; children: ReactNode }>) {
  const column = (
    <div aria-busy={state.phase === "loading" || undefined} className={cx("cr-aside")} data-aside-card="" data-step={state.step}>
      {children}
      {placement === "rail" ? action : null}
    </div>
  );
  if (placement === "rail") return column;
  return (
    <>
      {children ? <aside aria-label="Presale preview and publishing" className={cx("cr-aside-inline")}>{column}</aside> : null}
      {action ? <div className={cx("cr-actions cr-sticky-action cr-aside-action")}>{action}</div> : null}
    </>
  );
}

/** The Create page's right column (a separate route slot): reads the page's draft. */
export function CreatePreview() {
  const state = useCreateState();
  return <CreateAside placement="rail" state={state} />;
}
