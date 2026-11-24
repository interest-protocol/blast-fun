import { focusNextFrame } from "#web/lib/deferred-focus.ts";
import { blurAllocationAddress } from "#web/lib/sui-address-input.ts";

import { useEffect, useSyncExternalStore } from "react";

import type { SocialSaleCover } from "@blast/core/web/contracts/sales.ts";
import type { LaunchPageContext, LaunchPublishStepKind } from "@blast/core/web/contracts/launch.ts";
import { blankLaunchDraft, launchIssues, launchQuote, launchVenueTiers, LAUNCH_VENUES, poolQuoteBps, type LaunchDraft, type LaunchIssue, type LaunchRules, type LaunchSection } from "@blast/core/modules/social/launch/model.ts";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { quotePriceType } from "@blast/core/web/contracts/create.ts";
import { compareExact, divideExact, exactDecimal, exactText, multiplyExact } from "@blast/core/web/exact-amount.ts";
import { fieldNumber } from "@blast/core/web/format.ts";

import { coinTextIssues } from "../coin-text-policy.ts";

/**
 * `/launch`'s state: the account's draft as typed (saved after a pause), the
 * rules it is checked against, which step is open, and publishing. One store
 * per page load, read by the page and by its right column (a separate route
 * slot), so both always show the same draft.
 */

export const LAUNCH_STEPS = ["coin", "curve", "details", "review"] as const;
export type LaunchStep = (typeof LAUNCH_STEPS)[number];
export const LAUNCH_STEP_LABEL: Readonly<Record<LaunchStep, string>> = { coin: "Coin", curve: "Curve", details: "Details", review: "Review" };
const SECTION_STEP: Readonly<Record<LaunchSection, LaunchStep>> = { coin: "coin", curve: "curve", split: "curve", pool: "curve", fees: "curve", details: "details", buy: "review" };
export const stepOfIssue = (issue: Pick<LaunchIssue, "section">): LaunchStep => SECTION_STEP[issue.section];

export type LaunchState = Readonly<{
  /** `off`: launching is unavailable for this deployment; `visitor`: signed out. */
  phase: "loading" | "ready" | "visitor" | "error" | "off";
  errorMessage: string | null;
  context: LaunchPageContext;
  rules: LaunchRules | null;
  draftId: string | null;
  version: number;
  draft: LaunchDraft;
  raiseMinimum: Readonly<{ quoteType: string; amount: number }> | null;
  /** Edited since the last save went out. */
  dirty: boolean;
  logoUrl: string | null;
  logoPreview: string | null;
  cover: SocialSaleCover | null;
  coverPreview: string | null;
  coinType: string | null;
  publishing: boolean;
  accountId: string | null;
  /** The account's publishing wallet and who pays its network fees. */
  selfAddress: string | null;
  networkFees: "blast" | "wallet" | null;
  step: LaunchStep;
  /** Fields left once (their errors show) and whether Review was pressed (every error shows). */
  touched: ReadonlySet<string>;
  reviewed: boolean;
  sheetOpen: boolean;
  publishStep: LaunchPublishStepKind | null;
  publishError: string | null;
  publishedLaunchId: string | null;
}>;

const DEFAULT_QUOTE = SUI_COIN_TYPE;
const MIN_RAISE_SUI = 2_000;
const MIN_POOL_BPS = 7_000;

export function initialLaunchState(context: LaunchPageContext): LaunchState {
  const quote = context.rules?.quotes[0] ?? DEFAULT_QUOTE;
  const draft = blankLaunchDraft(quote);
  const pool = context.rules ? compatibleLaunchPool(draft, context.rules, quote) : {};
  return {
    phase: context.publish.available ? "loading" : "off",
    errorMessage: null,
    context,
    rules: context.rules,
    draftId: null,
    version: 0,
    draft: { ...draft, ...pool },
    raiseMinimum: null,
    dirty: false,
    logoUrl: null,
    logoPreview: null,
    cover: null,
    coverPreview: null,
    coinType: null,
    publishing: false,
    accountId: null,
    selfAddress: null,
    networkFees: null,
    step: "coin",
    touched: new Set(),
    reviewed: false,
    sheetOpen: false,
    publishStep: null,
    publishError: null,
    publishedLaunchId: null,
  };
}

/** Preserve a valid selection; otherwise choose a supported venue and fee together. */
export function compatibleLaunchPool(draft: LaunchDraft, rules: LaunchRules, quoteType: string) {
  const venue = launchVenueTiers(rules, draft.venue, quoteType).length
    ? draft.venue
    : LAUNCH_VENUES.find((candidate) => launchVenueTiers(rules, candidate, quoteType).length) ?? draft.venue;
  const fees = launchVenueTiers(rules, venue, quoteType);
  return { venue, pool_fee: fees.some(([, fee]) => fee === draft.pool_fee) ? draft.pool_fee : fees.at(-1)?.[1] ?? draft.pool_fee };
}

/**
 * A stored TSUI draft opens on SUI once TSUI is no longer admitted: same
 * decimals and price, so its amounts stay right. Any other delisted coin keeps
 * the "Pick another" issue rather than being rewritten with the wrong unit.
 */
export function admittedLaunchDraft(draft: LaunchDraft, rules: LaunchRules): LaunchDraft {
  const quote = quotePriceType(draft.quote_type);
  if (quote === draft.quote_type || rules.quotes.includes(draft.quote_type) || !rules.quotes.includes(quote)) return draft;
  return { ...draft, quote_type: quote, ...compatibleLaunchPool(draft, rules, quote) };
}

const SERVER_STATE: LaunchState = { ...initialLaunchState({ rules: null, publish: { available: false, reasons: ["launch_config"] } }), phase: "loading" };
let state: LaunchState = SERVER_STATE;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export const launchStore = Object.freeze({
  get: (): LaunchState => state,
  set(change: Partial<LaunchState>): void {
    state = { ...state, ...change };
    emit();
  },
  reset(next: LaunchState): void {
    state = next;
    emit();
  },
  edit(change: (draft: LaunchDraft) => LaunchDraft): void {
    if (state.publishing) return;
    state = { ...state, draft: change(state.draft), dirty: true };
    emit();
  },
  touch(path: string): void {
    if (state.touched.has(path)) return;
    state = { ...state, touched: new Set([...state.touched, path]) };
    emit();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
});

/**
 * Launching, as the page wires it: the right column is a separate route
 * slot, so its button reaches the page's publishing action through this slot.
 * Null while no page can launch.
 */
let launchAction: (() => void) | null = null;
export const launchPublishAction = Object.freeze({
  get: () => launchAction,
  set(action: (() => void) | null): void {
    launchAction = action;
  },
});

export function useLaunchState(): LaunchState {
  return useSyncExternalStore(launchStore.subscribe, launchStore.get, () => SERVER_STATE);
}

/** Convert the SUI floor, rounding up to the two places the money field accepts. */
export function minimumQuoteTarget(suiUsd: string | null, quoteUsd: string | null): number | null {
  const sui = exactDecimal(suiUsd);
  const quote = exactDecimal(quoteUsd);
  if (!sui?.n || !quote?.n) return null;

  const minimumUsd = multiplyExact({ n: BigInt(MIN_RAISE_SUI), scale: 0 }, sui);
  const roundedDown = divideExact(minimumUsd, quote, 2)!;
  const needsRounding = compareExact(multiplyExact(roundedDown, quote), minimumUsd) < 0;
  const amount = Number(exactText({ ...roundedDown, n: roundedDown.n + (needsRounding ? 1n : 0n) }));
  return Number.isFinite(amount) ? amount : null;
}

/** What is left to fix before publishing from the form. */
export function issuesOf({ draft, rules, logoUrl, logoPreview, publishing, raiseMinimum }: Pick<LaunchState, "draft" | "rules" | "logoUrl" | "logoPreview" | "publishing" | "raiseMinimum">): LaunchIssue[] {
  if (!rules) return [];
  const issues = launchIssues(draft, { rules, logoUrl: logoUrl ?? logoPreview });
  if (publishing) return issues;
  issues.push(...coinTextIssues(draft).map((issue): LaunchIssue => ({
    ...issue,
    section: issue.path === "tagline" ? "details" : "coin",
  })));

  const quote = launchQuote(draft);
  if (!quote || !rules.quotes.includes(draft.quote_type)) return issues;

  const inSui = quotePriceType(quote.quote_type) === SUI_COIN_TYPE;
  const minimum = inSui ? MIN_RAISE_SUI : (raiseMinimum?.quoteType === draft.quote_type ? raiseMinimum.amount : null);
  if (draft.graduation_target > 0) {
    if (minimum === null) {
      issues.push({ section: "curve", path: "graduation_target", message: "A price is needed to check the raise minimum. Wait for prices or choose another coin" });
    } else if (draft.graduation_target < minimum) {
      issues.push({ section: "curve", path: "graduation_target", message: `Set a raise target of at least ${fieldNumber(minimum)}\u00a0${quote.symbol}` });
    }
  }
  if (poolQuoteBps(rules) < MIN_POOL_BPS) {
    issues.push({ section: "curve", path: "quote_type", message: `At least 70% of the ${quote.symbol} raise must go to the pool` });
  }
  return issues;
}

/** The error a field shows: after it was left once, or after Review was pressed. */
export function shownIssue(current: Pick<LaunchState, "touched" | "reviewed">, issues: readonly LaunchIssue[], path: string): string {
  const issue = issues.find((one) => one.path === path);
  return issue && (current.reviewed || current.touched.has(path)) ? issue.message : "";
}

// ---- steps in the URL (`#curve`) ----

export function goToLaunchStep(step: LaunchStep): void {
  if (state.step !== step) {
    blurAllocationAddress();
    launchStore.set({ step });
  }
  if (location.hash !== `#${step}`) history.pushState(history.state, "", `#${step}`);
  focusNextFrame(() => document.querySelector<HTMLElement>("[data-launch-step]"), { preventScroll: true });
  window.scrollTo({ top: 0 });
}

/** Review: with issues, every error shows and the first one's step opens; without, Review opens. */
export function reviewLaunch(issues: readonly LaunchIssue[]): void {
  launchStore.set({ reviewed: true });
  const first = issues.find((issue) => issue.section !== "buy");
  goToLaunchStep(first ? stepOfIssue(first) : "review");
}

/** Follows the URL's step on load, back and forward. */
export function useLaunchStepLocation(): void {
  useEffect(() => {
    const follow = () => {
      const step = location.hash.replace(/^#/, "") as LaunchStep;
      if ((LAUNCH_STEPS as readonly string[]).includes(step) && state.step !== step) launchStore.set({ step });
    };
    follow();
    window.addEventListener("hashchange", follow);
    window.addEventListener("popstate", follow);
    return () => {
      window.removeEventListener("hashchange", follow);
      window.removeEventListener("popstate", follow);
    };
  }, []);
}
