"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useLinkStatus } from "next/link";

import { useDevicePrefs } from "#web/components/blast-ui/device-prefs.ts";
import { useReducedMotion } from "#web/components/blast-ui/use-shell-prefs.ts";
import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import { CreateLaunchScene } from "../create/CreateLaunchScene";
import { LaunchFlight } from "../create/LaunchFlight";
import { Button, ButtonLink } from "#web/components/blast-ui/Button.tsx";
import { Sheet, SheetClose, SheetCta } from "#web/components/blast-ui/Sheet.tsx";
import { atomsValue, fieldNumber, NO_VALUE, ppmPct, shortAddress } from "@blast/core/web/format.ts";
import { LAUNCH_PUBLISH_STEPS } from "@blast/core/web/contracts/launch.ts";
import { firstBuyMemeOut, launchFigures, launchSplit, pct, poolQuoteBps, type LaunchIssue, type LaunchRules } from "@blast/core/modules/social/launch/model.ts";
import { normalizeSaleLink } from "@blast/core/modules/social/sales/validate.ts";

import { CheckIcon } from "../create/create-icons";
import { cx } from "../create/cx";
import { Ticker, TickerText } from "#web/components/blast-ui/Ticker.tsx";
import { CoinMark, CrErr, CrField, FoldList, FoldSection, MobilePreview, ReviewFold, SignaturesFold, SignLabelText, useFold } from "../create/fields";
import { walletLabel } from "../create/create-field-model";
import { detailsSummary, listed, reviewAttention } from "../create/create-review-model";
import { DiagnosticText } from "#web/components/blast-ui/DiagnosticText.tsx";
import { LaunchField, type LaunchForm } from "./LaunchForm";
import { launchSignLabel } from "./launch-publish-labels";
import { issuesOf, launchPublishAction, launchStore, shownIssue, useLaunchState, type LaunchState } from "./launch-store";
import { amountWith, coinQuantity } from "../coins/coin-model";
import { compact, poolPriceDifference, quoteLabel } from "./launch-format";
import { lcx } from "./lcx";
import { launchBlockedReason } from "./launch-review-model";

const symbolOf = (state: LaunchState) => state.draft.symbol || "tokens";

function Row({ k, children }: Readonly<{ k: string; children: ReactNode }>) {
  return <div><dt>{k}</dt><dd className="num" data-empty={children === "" ? "" : undefined}>{children}</dd></div>;
}

/** A review value: plain text, or a headline with a quieter detail line under it. */
type ReviewValue = ReactNode | Readonly<{ text: ReactNode; detail: ReactNode }>;

const hasDetail = (value: ReviewValue): value is Readonly<{ text: ReactNode; detail: ReactNode }> => typeof value === "object" && value !== null && "detail" in value;

/** One inline run per value, so a ticker sits one space after its amount (the cell is a flex box; its gap would split them). */
function ReviewValueText({ value }: Readonly<{ value: ReviewValue }>) {
  if (!hasDetail(value)) return <span>{value}</span>;
  return <><span>{value.text}</span><span className={cx("cr-detail")}>{value.detail}</span></>;
}


/** The coin as cards show it: cover, identity and tagline. Figures stay on Review. */
export function LaunchPreview({ state }: Readonly<{ state: LaunchState }>) {
  const cover = state.coverPreview ?? state.cover?.url ?? null;
  return (
    <section aria-label="How it appears" className={lcx("lc-preview")}>
      <h2>How it appears</h2>
      <div className={cx("card cr-preview")}>
      {cover ? (
        <div className={cx("cr-cover-slot has-cover")}>
          {/* eslint-disable-next-line @next/next/no-img-element -- the uploaded cover, any https host */}
          <img alt="" height={512} src={cover} width={1_536} />
        </div>
      ) : null}
      <div className={cx("cr-id")}>
        <CoinMark draft={state.draft} logo={state.logoPreview ?? state.logoUrl} size="s46" />
        <span className={cx("t")}>
          {state.draft.name.trim() ? <b>{state.draft.name.trim()}</b> : <b className={cx("cr-none")}>{NO_VALUE}</b>}
          {state.draft.symbol ? <span><Ticker symbol={state.draft.symbol} /></span> : <span className={cx("cr-none")}>{NO_VALUE}</span>}
        </span>
        <span className="status" data-tone="neutral">Bonding</span>
      </div>
      {state.draft.tagline.trim() ? <p className={lcx("lc-tagline")}>{state.draft.tagline.trim()}</p> : null}
      </div>
    </section>
  );
}

function launchPublishBlocked(state: LaunchState, ready: boolean): boolean {
  return !ready || state.phase !== "ready" || state.publishing || state.logoPreview !== null || state.coverPreview !== null;
}

/**
 * Review's rail card: the money sentence and Launch. On phones the same
 * action is pinned below the folds. The first buy and the signatures are
 * Review's folded rows; the money sentence says what you pay, get and lock.
 */
function PublishCard({ children }: Readonly<{ children: ReactNode }>) {
  return <section aria-label="Launching" className={cx("card cr-publish")}>{children}</section>;
}

/** The cost and terms sit beside the action that opens the signing sheet. */
function LaunchAction({ state, issues }: Readonly<{ state: LaunchState; issues: readonly LaunchIssue[] }>) {
  const ids = useId();
  const blocked = launchPublishBlocked(state, issues.length === 0);
  const reason = blocked ? launchBlockedReason(state, issues) : null;
  const cost = blocked ? null : launchCostSentence(state);
  return (
    <>
      {cost ? <p className={cx("cr-cost num")} id={`${ids}-cost`}><TickerText symbols={[state.draft.symbol]} text={cost} /></p> : null}
      <Button
        aria-describedby={reason ? `${ids}-reason` : cost ? `${ids}-cost` : undefined}
        className={cx("cr-publish-btn")}
        data-launch=""
        disabled={blocked}
        onClick={() => launchPublishAction.get()?.()}
        size="lg"
        variant="primary"
      >
        Launch
      </Button>
      {reason ? <p className={cx("cr-note")} id={`${ids}-reason`}>{reason}</p> : null}
    </>
  );
}

/** The right column for the open step. */
export function LaunchAside({ state, placement }: Readonly<{ state: LaunchState; placement: "rail" | "page" }>) {
  // A draft that could not load has no column (KA-1, as presale): its error card stands in for the step.
  if (state.phase === "error") return null;
  const review = state.step === "review";
  // Launch closes the publishing card in the rail; on the page it follows the folds as the shared sticky action, like every step's.
  const action = review ? <LaunchAction issues={issuesOf(state)} state={state} /> : null;
  const column = (content: ReactNode) => <div aria-busy={state.phase === "loading" || undefined} className={cx("cr-aside")} data-aside-card="" data-step={state.step}>{content}</div>;
  if (placement === "rail") return column(review ? <PublishCard>{action}</PublishCard> : <LaunchPreview state={state} />);
  // On the page Review has no card: the first buy is one of its folded rows, so only the action follows them.
  return (
    <>
      {review ? null : <aside aria-label="Launch preview" className={cx("cr-aside-inline")}>{column(<MobilePreview key={state.step}><LaunchPreview state={state} /></MobilePreview>)}</aside>}
      {action ? <div className={cx("cr-actions cr-sticky-action cr-aside-action")}>{action}</div> : null}
    </>
  );
}

/** The page's right column (a separate route slot): reads the page's draft. */
export function LaunchRail() {
  const state = useLaunchState();
  return state.phase === "off" ? null : <LaunchAside placement="rail" state={state} />;
}

/**
 * The token split in at most three shares, each as set (Blast's 2.5% reads
 * 2.5%, never rounded to another number): the curve, the pool, and the rest
 * together (recipients, Blast, and any unused share; a zero unused share is
 * left out of the words). Recipient wallets get their own rows.
 */
function tokenSplitLine(split: ReturnType<typeof launchSplit>, recipients: boolean): string {
  const rest = split.allocated_bps + split.unallocated_bps + split.protocol_bps;
  const names = [recipients ? "recipients" : null, "Blast", split.unallocated_bps > 0 ? "unused" : null].filter((name): name is string => name !== null);
  return [`${pct(split.curve_bps)} curve`, `${pct(split.pool_bps)} pool`, rest > 0 ? `${pct(rest)} ${listed(names)}` : null].filter(Boolean).join(" · ");
}

/** A recipient as review reads it: `0x1234…abcd · 5%`. */
const recipientLine = (row: Readonly<{ address: string; bps: number }>) => `${row.address ? shortAddress(row.address) : NO_VALUE} · ${pct(row.bps)}`;

/** A Review group: its folded row's short value, the issue sections that open it, and its rows. */
type LaunchReviewGroup = Readonly<{ title: string; summary: string; sections: readonly LaunchIssue["section"][]; rows: readonly (readonly [string, ReviewValue])[] }>;

/** Review: every setting, grouped (the name and ticker are the hero, not a row); the stepper is the one way back to edit. */
function reviewGroups(state: LaunchState): readonly LaunchReviewGroup[] {
  const { draft, rules } = state;
  if (!rules) return [];
  const split = launchSplit(draft, rules);
  const figures = launchFigures(draft, rules);
  const unit = quoteLabel(draft.quote_type);
  // The ticker inside a sentence ("192.7M PIP + 1.2K SUI"), in the shared class so a long one wraps inside the card.
  const sym = draft.symbol ? <Ticker bare symbol={draft.symbol} /> : "tokens";
  const site = normalizeSaleLink(draft.site);
  const links = [site.ok ? site.value : null, draft.x_handle ? `@${draft.x_handle}` : null, draft.telegram ? `t.me/${draft.telegram}` : null, draft.docs_url, draft.audit_url].filter((link): link is string => Boolean(link));
  // Recipients are listed once, in their own rows below.
  const others = [`Holders ${pct(draft.holders_fee_bps)}`, draft.auto_lp_fee_bps ? `Auto-LP ${pct(draft.auto_lp_fee_bps)}` : null, draft.burn_fee_bps ? `Buyback & burn ${pct(draft.burn_fee_bps)}` : null].filter(Boolean).join(" · ");
  const venue = draft.venue === "cetus" ? "Cetus" : "Bluefin";
  return [
    { title: "Coin", summary: `${draft.burnable ? "Burn only" : "Fixed supply"}, ${draft.decimals} decimals`, sections: ["coin"], rows: [["Supply", `1,000,000,000 · ${draft.burnable ? "burn only" : "fixed"}`], ["Decimals", String(draft.decimals)], ["Sell burn", draft.sell_burn_bps ? pct(draft.sell_burn_bps) : "Off"]] },
    { title: "Curve", summary: `Raise ${fieldNumber(draft.graduation_target)} ${unit}`, sections: ["curve"], rows: [
      ["Raise in", unit],
      ["Starting liquidity", `${fieldNumber(draft.virtual_quote)}\u00a0${unit}${figures ? ` · starts at ${compact(figures.opening)}\u00a0${unit}\u00a0FDV` : ""}`],
      ["Raise target", `${fieldNumber(draft.graduation_target)}\u00a0${unit}${figures ? ` · graduates at ~${compact(figures.terminal)}\u00a0${unit}\u00a0FDV` : ""}`],
      ["Curve trading fee", { text: `You get ${pct(10_000 - rules.protocol_fee_share_bps)} of curve fees`, detail: <>{`${pct(rules.quote_fee_bps)} of ${unit} + ${pct(rules.meme_fee_bps)} of `}{sym}</> }],
    ] },
    { title: "Splits", summary: `Curve ${pct(split.curve_bps)}, pool ${pct(split.pool_bps)}`, sections: ["split"], rows: [
      ["Token", tokenSplitLine(split, draft.recipients.length > 0)],
      [`Raised ${unit}`, `${pct(poolQuoteBps(rules))} pool · ${pct(rules.protocol_quote_bps)} Blast`],
      ...draft.recipients.map((row, index) => [`${index + 1}. ${walletLabel(row.label || "Token recipient")}`, recipientLine(row)] as const),
    ] },
    { title: "Pool", summary: `${venue}, you get ${pct(draft.creator_fee_bps)} of fees`, sections: ["pool", "fees"], rows: [
      ["Venue", `${venue} · ${ppmPct(draft.pool_fee)} pool fee`],
      ...(figures ? [["Liquidity", { text: <>{`${compact(figures.poolTokens)} `}{sym}{` + ${compact(figures.poolQuote)} ${unit}`}</>, detail: "Locked forever" }] as const] : []),
      ...(figures ? [["Opening price vs. curve", poolPriceDifference(figures.poolAtCurveSupply, figures.terminal)] as const] : []),
      // No row holds more than three numbers: your share first, then Blast's, then the rest.
      ["Pool fees", { text: `You get ${pct(draft.creator_fee_bps)} of pool fees`, detail: "After Blast’s share" }],
      ["Blast’s share", <>{`${pct(rules.pool_fee_quote_bps)} of ${unit} · ${pct(rules.pool_fee_meme_bps)} of `}{sym}</>],
      ["Other shares", others],
      ...draft.fee_recipients.map((row, index) => [`${index + 1}. ${walletLabel(row.label || "Fee recipient")}`, recipientLine(row)] as const),
    ] },
    { title: "Details", summary: detailsSummary(Boolean(draft.tagline.trim()), links.length), sections: ["details"], rows: [["Short description", draft.tagline.trim()], ["Links", links.join(" · ")]] },
  ];
}

/**
 * The first buy as one Review row ("First buy · 100 SUI", or "None"):
 * pressing it opens the amount. Like every Review row it never opens by
 * itself; a wrong amount (over the balance, under the minimum) is named in
 * the row, in the attention ink. The money sentence above Launch is the one
 * place that says what it pays and gets.
 */
function FirstBuyFold({ state, issues, rules }: Readonly<{ state: LaunchState; issues: readonly LaunchIssue[]; rules: LaunchRules }>) {
  const fold = useFold("", 0);
  const id = useId();
  const unit = quoteLabel(state.draft.quote_type);
  const attention = reviewAttention(issues, ["buy"]);
  const value = attention ? <span className={cx("cr-fold-attn")}>{attention}</span>
    : state.draft.first_buy > 0 ? amountWith(fieldNumber(state.draft.first_buy), unit) : "None";
  const form: LaunchForm = { state, issues, rules };
  return (
    <FoldSection fold={fold} id="lc-rv-buy" sectionId="lc-rv-buy" title="First buy" value={value}>
      <fieldset className={lcx("lc-fields")} disabled={state.publishing}>
        <CrField error={<CrErr message={shownIssue(state, issues, "first_buy")} path="first_buy" />} htmlFor={`${id}-buy`} label="Amount">
          <LaunchField form={form} id={`${id}-buy`} label="First buy amount" path="first_buy" suf={unit} type="money" />
        </CrField>
      </fieldset>
    </FoldSection>
  );
}

/**
 * Review: the coin, then each group, the first buy and the wallet's three
 * signatures folded into one row with its short value; a group with a
 * missing or wrong value names it in its row. The money sentence stays
 * above Launch, never folded.
 */
export function ReviewStep({ state }: Readonly<{ state: LaunchState }>) {
  const groups = reviewGroups(state);
  const issues = issuesOf(state);
  const cover = state.coverPreview ?? state.cover?.url;
  return (
    <div aria-label="Launch settings to review" className={cx("cr-review")} role="region" tabIndex={-1}>
      <div className={`${cx("cr-hero", cover && "has-cover")} ${lcx("lc-review-hero")}`} data-surface="">
        {/* eslint-disable-next-line @next/next/no-img-element -- the creator's uploaded cover */}
        {cover ? <img alt="Coin cover preview" height={512} src={cover} width={1536} /> : null}
        <div className={cx("cr-hero-id")}>
          <CoinMark draft={state.draft} logo={state.logoPreview ?? state.logoUrl} size="s56" />
          <span className={cx("t")}>
            {state.draft.name.trim() ? <b>{state.draft.name.trim()}</b> : <b className={cx("cr-none")}>{NO_VALUE}</b>}
            <span>{state.draft.symbol ? <Ticker symbol={state.draft.symbol} /> : <span className={cx("cr-none")}>{NO_VALUE}</span>} · Bonding</span>
          </span>
        </div>
      </div>
      <FoldList>
        {groups.map((group) => (
          <ReviewFold
            attention={reviewAttention(issues, group.sections, group.rows.filter(([, value]) => typeof value === "string" && value.startsWith(NO_VALUE)).map(([key]) => key.replace(/^\d+\.\s*/, "")))}
            id={`lc-rv-${group.title.replace(/\W+/g, "-").toLowerCase()}`}
            key={group.title}
            title={group.title}
            value={group.summary}
          >
            {group.rows.map(([k, v]) => <Row k={k} key={k}>{v === "" ? "" : <ReviewValueText value={v} />}</Row>)}
          </ReviewFold>
        ))}
        {state.rules ? <FirstBuyFold issues={issues} rules={state.rules} state={state} /> : null}
        <SignaturesFold id="lc-rv-signatures" labels={LAUNCH_PUBLISH_STEPS.map((step) => launchSignLabel(step, state.draft.symbol))}>
          {state.networkFees ? <div className={cx("cr-fee-row")}><span>Network fees</span><b>{state.networkFees === "blast" ? "Paid by Blast" : "Paid from your wallet"}</b></div> : null}
        </SignaturesFold>
      </FoldList>
    </div>
  );
}

/** Whole tokens, short and rounded down, so "at least" stays true: `1.2M`, `840`. */
const atLeast = (value: number) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: value >= 1_000 ? 1 : 2, roundingMode: "floor" }).format(value);

/** The one-way door, said once, at the end of the money sentence above Launch (no separate card). */
const LAUNCH_LOCK = "Launching locks the curve and pool.";

/**
 * Launching's money, in one sentence: the first buy and the creation fee that
 * leave the wallet, and the least the first buy receives; the fee alone
 * without a first buy. Then what locks, so the one-way door sits beside
 * Launch. Null until the launch rules load or while the draft has an issue
 * (no figure is guessed).
 */
function launchCostSentence(state: LaunchState): string | null {
  const { draft, rules } = state;
  if (!rules || issuesOf(state).length > 0) return null;
  const feeMist = BigInt(rules.creation_fee);
  const fee = amountWith(coinQuantity(atomsValue(feeMist, 9) ?? 0), "SUI");
  if (draft.first_buy <= 0) return feeMist === 0n ? LAUNCH_LOCK : `You pay a ${fee} creation fee. ${LAUNCH_LOCK}`;
  const out = atLeast(Number(firstBuyMemeOut(draft, rules)) / 10 ** draft.decimals);
  const buy = amountWith(fieldNumber(draft.first_buy), quoteLabel(draft.quote_type));
  return `You pay ${buy}${feeMist === 0n ? "" : ` plus a ${fee} fee`} and get at least ${amountWith(out, symbolOf(state))}. ${LAUNCH_LOCK}`;
}

/**
 * The sheet's one line under the steps: the wallet opening, then its prompts
 * while it runs, what was kept while paused (once; the error does not repeat
 * it), the rewards once done. The money sentence sits above Launch, once.
 */
function sheetNote(done: boolean, running: boolean, opening: boolean): string | null {
  if (done) return "Your share of fees collects in Portfolio → Rewards.";
  if (opening) return "Opening your wallet…";
  return running ? "Follow your wallet’s prompts. Each step waits for confirmation." : "Your progress is saved.";
}

/** The sheet's title names the coin by its ticker, in the shared class. */
function sheetTitle(done: boolean, symbol: string): ReactNode {
  if (!symbol) return done ? "Your coin is trading" : "Launching your coin";
  const ticker = <Ticker symbol={symbol} />;
  return done ? <>{ticker} is trading</> : <>Launching {ticker}</>;
}

/** Play only for a live confirmation, and release the sheet on any interruption. */
function useLaunchCelebration({ celebrate, done, reducedMotion, running, open }: Readonly<{ celebrate: boolean; done: boolean; reducedMotion: boolean; running: boolean; open: boolean }>) {
  const sawRunning = useRef(false);
  const [celebration, setCelebration] = useState<"scene" | "flight" | null>(null);
  useLayoutEffect(() => {
    if (running && open) sawRunning.current = true;
    if (done && sawRunning.current) {
      sawRunning.current = false;
      if (open && celebrate && !reducedMotion && !window.matchMedia("(max-width: 760px)").matches) {
        // The pre-paint update prevents the success sheet flashing before the scene.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setCelebration("scene");
      }
    }
    if (!open) sawRunning.current = false;
    if (!open || !celebrate || reducedMotion) {
      // Stop a running celebration before painting its now-ineligible scene.
      setCelebration(null);
    }
  }, [celebrate, done, reducedMotion, running, open]);
  useEffect(() => {
    if (!celebration) return;
    const phone = window.matchMedia("(max-width: 760px)");
    const stop = () => { if (phone.matches) setCelebration(null); };
    phone.addEventListener("change", stop);
    // The flight ends when the rocket lands (`land`); this timeout only releases the sheet if the image never loads or the animation is interrupted.
    const timer = window.setTimeout(() => setCelebration(celebration === "scene" ? "flight" : null), celebration === "scene" ? 1200 : 9000);
    return () => { window.clearTimeout(timer); phone.removeEventListener("change", stop); };
  }, [celebration]);
  const land = useCallback(() => setCelebration(null), []);
  return [celebration, land] as const;
}

/** Launching: the three transactions as they confirm and the wallet's prompts, then the coin; after a failure, Resume launching. */
export function LaunchSheet({ state, onLaunch }: Readonly<{ state: LaunchState; onLaunch: () => void }>) {
  const done = state.publishedLaunchId !== null;
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  const titleRef = useCallback((node: HTMLHeadingElement | null) => {
    setPortal(node?.closest<HTMLElement>("[data-sheet-scrim], [data-blast-ui]") ?? null);
  }, []);
  const { celebrate } = useDevicePrefs();
  const reducedMotion = useReducedMotion();
  // Open and not yet on a step: the wallet is opening, so step 1 is already under way (MA-8), never an idle sheet.
  const opening = state.sheetOpen && state.publishStep === null && state.publishError === null && !done;
  const current = state.publishStep ? LAUNCH_PUBLISH_STEPS.indexOf(state.publishStep) : opening ? 0 : -1;
  const running = state.publishStep !== null && state.publishError === null && !done;
  const close = () => {
    if (!running) launchStore.set({ sheetOpen: false });
  };
  const note = sheetNote(done, running, opening);
  const [celebration, land] = useLaunchCelebration({ celebrate, done, reducedMotion, running, open: state.sheetOpen });
  return (
    <Sheet className={cx("cr-sheet")} hasCta labelledBy="lc-sheet-title" onRequestClose={close} open={state.sheetOpen}>
      <LaunchFlight active={celebration === "flight"} onLanded={land} portal={portal} />
      {running ? null : <SheetClose onClick={close} />}
      <LaunchSheetBody celebration={celebration} current={current} done={done} state={state} titleRef={titleRef} />
      {!celebration ? <LaunchSheetFooter done={done} error={state.publishError} launchId={state.publishedLaunchId} note={note} onLaunch={onLaunch} /> : null}
    </Sheet>
  );
}

function LaunchSheetBody({ celebration, current, done, state, titleRef }: Readonly<{
  celebration: "scene" | "flight" | null;
  current: number;
  done: boolean;
  state: LaunchState;
  titleRef: (node: HTMLHeadingElement | null) => void;
}>) {
  // The presale's scene, one pose per step: publish coin (0), register currency (1), create the curve with its quote (2), then the seal.
  const stage = done ? 3 : Math.max(current, 0);
  return <div className={`${cx("cr-launch")} ${lcx("lc-sheet-body", celebration && "lc-celebration-body")}`} data-paused={state.publishError !== null} data-published={done} data-stage={stage}>
    <CreateLaunchScene logo={state.logoUrl} name={state.draft.name} published={done} quoteSymbol={quoteLabel(state.draft.quote_type)} stage={stage} symbol={state.draft.symbol} venue={state.draft.venue} />
    <div className={lcx("lc-sheet-head")}>
      <h2 aria-live="polite" className={cx("cr-launch-title")} id="lc-sheet-title" ref={titleRef} tabIndex={-1}>{celebration ? "Launch confirmed" : sheetTitle(done, state.draft.symbol)}</h2>
    </div>
    {!celebration && state.publishError ? <p className={cx("cr-launch-error")} role="alert"><DiagnosticText message={state.publishError} /></p> : null}
    {!celebration ? <LaunchSheetSteps current={current} done={done} error={state.publishError} symbol={state.draft.symbol} /> : null}
  </div>;
}

function LaunchSheetFooter({ done, error, launchId, note, onLaunch }: Readonly<{ done: boolean; error: string | null; launchId: string | null; note: string | null; onLaunch: () => void }>) {
  return <SheetCta className={`${cx("cr-cta cr-launch-cta")} ${lcx("lc-sheet-cta")}`}>
    {note ? <p className={cx("snote")}>{note}</p> : null}
    {done ? <ButtonLink className={lcx("lc-block")} href={`/coin/${launchId}`} size="lg" variant="primary"><ViewCoinLabel /></ButtonLink>
      : error ? <Button className={lcx("lc-block")} onClick={onLaunch} size="lg" variant="primary">Resume launching</Button> : null}
  </SheetCta>;
}

function LaunchSheetSteps({ current, done, error, symbol }: Readonly<{ current: number; done: boolean; error: string | null; symbol: string }>) {
  return <ol aria-label="Launching steps" className={cx("cr-launch-steps")}>
    {LAUNCH_PUBLISH_STEPS.map((step, index) => {
      const complete = done || current > index;
      const active = !done && current === index;
      return <li aria-current={active ? "step" : undefined} data-active={active} data-complete={complete} key={step}>
        <span aria-hidden="true" className={cx("cr-launch-step-icon")}>{complete ? <CheckIcon /> : index + 1}</span>
        <span><SignLabelText label={launchSignLabel(step, symbol)} /></span>
        <small>{complete ? "Confirmed" : active ? (error ? "Paused" : "In progress") : index === current + 1 ? "Next" : null}</small>
      </li>;
    })}
  </ol>;
}

function ViewCoinLabel() {
  const { pending } = useLinkStatus();
  return pending ? <LoadingIndicator label="Opening coin">View coin</LoadingIndicator> : "View coin";
}
