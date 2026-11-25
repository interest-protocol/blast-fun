"use client";

import { useSyncExternalStore } from "react";

import {
  CREATE_MAX_USD,
  CREATE_QUOTE_TYPE,
  type CreateAllowlistSummary,
  type CreateDraft,
  type CreateDraftCover,
  type CreateDraftResponse,
  type CreateFeePolicy,
  type CreateIssue,
  type CreatePublishAvailability,
  type CreateQuotePrice,
} from "@blast/core/web/contracts/create.ts";
import { bluefinDraftIssue, bluefinTierSupported, type BluefinCreateOptions } from "@blast/core/modules/social/create/bluefin-options.ts";
import { cetusDraftIssue, cetusTiersForQuote, type CreateCetusTiers } from "@blast/core/modules/social/create/cetus-options.ts";
import { minimumRaiseIssue } from "@blast/core/modules/social/create/minimum-raise.ts";
import { blankDraft, CREATE_DEFAULT_FEE_POLICY, venueTiers } from "@blast/core/modules/social/create/model.ts";
import { createIssues } from "@blast/core/modules/social/create/presale-args.ts";

import { coinTextIssues } from "@blast/core/modules/social/create/coin-text-policy.ts";
import { quoteUnavailableReason, venueAvailable } from "./quote-coins";
import type { CreateStep } from "./create-steps";
import { writeGuestDraft, type GuestDraftRestore, type GuestDraftSnapshot, type GuestStorage } from "./guest-draft-storage.ts";
export { restoreGuestDraft } from "./guest-draft-storage.ts";

/**
 * The Create page's state, shared by the form (the page column) and its live
 * preview (the right column's card, a separate route slot), so both read one
 * draft: an external store, one per browser tab. The page loads and saves
 * it; the preview only reads it.
 */
export type CreatePhase = "loading" | "ready" | "error" | "visitor";
export type GuestDisposition = "review" | "adopted" | "keep_current" | "separate";
export type GuestChoice = Readonly<{ ownerId: string | null; disposition: GuestDisposition }>;
export function guestDispositionForOwner(choice: GuestChoice, ownerId: string | null): GuestDisposition {
  if (choice.ownerId === ownerId) return choice.disposition;
  const continuingGuest = choice.ownerId === null && ownerId !== null;
  return continuingGuest && (choice.disposition === "adopted" || choice.disposition === "separate") ? choice.disposition : "review";
}
type GuestRecovery = Readonly<{
  choice: GuestChoice;
  adoptedSnapshot: GuestDraftSnapshot | null;
  savedSnapshot: GuestDraftSnapshot | null;
}>;
const INITIAL_GUEST_RECOVERY: GuestRecovery = {
  choice: { ownerId: null, disposition: "review" }, adoptedSnapshot: null, savedSnapshot: null,
};

/** An allowlist read in the browser before the server has its summary (the design's `d.list`). */
export type LocalAllowlist = Readonly<{ n: number; min: number; max: number; quoteType: string }>;

export type CreateState = Readonly<{
  phase: CreatePhase;
  errorMessage?: string;
  ownerId: string | null;
  draftId: string | null;
  /** The saved version this draft edits (0 before its first save). */
  version: number;
  draft: CreateDraft;
  /** Typed since the last save went out. */
  dirty: boolean;
  logoUrl: string | null;
  /** The picked image while it uploads. */
  logoPreview: string | null;
  /** R3-25: the sale's cover as saved, and the picked one while it uploads. */
  cover: CreateDraftCover | null;
  coverPreview: string | null;
  allowlist: CreateAllowlistSummary | null;
  localAllowlist: LocalAllowlist | null;
  allowlistUploading: boolean;
  fees: CreateFeePolicy;
  publish: CreatePublishAvailability;
  /** The creator's own wallet, shown on the "You" fee row. */
  selfAddress: string | null;
  /** Fields left once (their errors show), and whether Review was pressed with issues (every error shows). */
  touched: ReadonlySet<string>;
  tried: boolean;
  /** A section to flash and scroll to, and the field to focus. */
  flash: Readonly<{ section: string; path: string; nonce: number }> | null;
  reviewOpen: boolean;
  publishLocked: boolean;
  publishProgress: string | null;
  publishError: string | null;
  publishedPresaleId: string | null;
  /** The moment the page shows closing times from (set when the page loads). */
  nowMs: number;
  /** R3-42: the quote types the picker lists (the server's answer: USDC, and SUI while it has a price). */
  quotes: readonly string[];
  cetusTiers: CreateCetusTiers | null;
  bluefinOptions: BluefinCreateOptions;
  /** R3-42: SUI's price row the picker converts at; null without one. */
  suiPrice: CreateQuotePrice | null;
  raiseQuotePrice: Readonly<{ quoteType: string; usd: string }> | null;
  /** R3-42: the picker sheet is open. */
  quoteOpen: boolean;
  /** The step on screen (Token, Raise, Details, Review); the page keeps it in the URL hash. */
  step: CreateStep;
  /** Who pays the publishing network fees: Blast for the account's Blast wallet, else the wallet itself; null before the account loads. */
  networkFees: "blast" | "wallet" | null;
}>;

export const INITIAL_CREATE_STATE: CreateState = {
  phase: "loading",
  ownerId: null,
  draftId: null,
  version: 0,
  draft: blankDraft(),
  dirty: false,
  logoUrl: null,
  logoPreview: null,
  cover: null,
  coverPreview: null,
  allowlist: null,
  localAllowlist: null,
  allowlistUploading: false,
  fees: CREATE_DEFAULT_FEE_POLICY,
  publish: { available: false, reasons: ["presale_not_deployed"] },
  selfAddress: null,
  touched: new Set(),
  tried: false,
  flash: null,
  reviewOpen: false,
  publishLocked: false,
  publishProgress: null,
  publishError: null,
  publishedPresaleId: null,
  nowMs: 0,
  quotes: [CREATE_QUOTE_TYPE],
  cetusTiers: null,
  bluefinOptions: { status: "unavailable" },
  suiPrice: null,
  raiseQuotePrice: null,
  quoteOpen: false,
  step: "token",
  networkFees: null,
};

let state: CreateState = INITIAL_CREATE_STATE;
// Recovery ownership follows the tab's mounted draft, including client navigation away and back.
let guestRecovery: GuestRecovery = INITIAL_GUEST_RECOVERY;
const listeners = new Set<() => void>();
/** Only unsigned drafts are written; retained input needs explicit recovery before any storage mutation. */
export function persistGuestDraft(storage: GuestStorage, current: CreateState, previous: GuestDraftRestore, adopted: boolean): GuestDraftRestore {
  if (previous.status !== "empty" && previous.status !== "canonical") return previous;
  if (previous.status === "canonical" && previous.recoveredFrom !== null && !adopted) return previous;
  if (current.ownerId === null && current.dirty) return writeGuestDraft(storage, previous, current.draft);
  return previous;
}

function emit(): void {
  for (const listener of listeners) listener();
}

export const createStore = Object.freeze({
  guestRecovery: (): GuestRecovery => guestRecovery,
  bindGuestOwner(ownerId: string | null): GuestRecovery {
    const disposition = guestDispositionForOwner(guestRecovery.choice, ownerId);
    const changedOwner = guestRecovery.choice.ownerId !== null && guestRecovery.choice.ownerId !== ownerId;
    guestRecovery = {
      choice: { ownerId, disposition },
      adoptedSnapshot: disposition === "adopted" ? guestRecovery.adoptedSnapshot : null,
      savedSnapshot: changedOwner ? null : guestRecovery.savedSnapshot,
    };
    return guestRecovery;
  },
  chooseGuest(disposition: GuestDisposition, adoptedSnapshot: GuestDraftSnapshot | null = null): GuestChoice {
    const choice = { ownerId: guestRecovery.choice.ownerId, disposition };
    guestRecovery = { ...guestRecovery, choice, adoptedSnapshot };
    return choice;
  },
  rememberGuestSave(snapshot: GuestDraftSnapshot): void {
    guestRecovery = { ...guestRecovery, adoptedSnapshot: null, savedSnapshot: snapshot };
  },
  get: (): CreateState => state,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  set(update: Partial<CreateState> | ((current: CreateState) => Partial<CreateState>)): void {
    const patch = typeof update === "function" ? update(state) : update;
    state = { ...state, ...patch };
    emit();
  },
  /** Applies one edit to the draft; it is saved by the page's autosave. */
  edit(change: (draft: CreateDraft) => CreateDraft): void {
    let draft = change(state.draft);
    if (draft.quote_type !== state.draft.quote_type) {
      if (quoteUnavailableReason(state, draft.quote_type)) return;
      draft = { ...draft, venue: venueAvailable(state, "cetus", draft.quote_type) ? "cetus" : "bluefin" };
    }
    if (draft.venue !== state.draft.venue || draft.quote_type !== state.draft.quote_type) {
      const bluefinTiers = venueTiers("bluefin").filter(([spacing, fee]) => bluefinTierSupported(state.bluefinOptions, spacing, fee));
      const tiers = draft.venue === "cetus" ? cetusTiersForQuote(draft.quote_type, state.cetusTiers) : bluefinTiers;
      if (!venueAvailable({ ...state, draft }, draft.venue)) return;
      if (tiers.length > 0 && !tiers.some(([, fee]) => fee === draft.pool_fee)) {
        const fee = tiers.reduce((best, [, next]) => Math.abs(next - draft.pool_fee) < Math.abs(best - draft.pool_fee) ? next : best, tiers[0]![1]);
        draft = { ...draft, pool_fee: fee };
      }
    }
    state = { ...state, draft, dirty: true };
    emit();
  },
  touch(path: string): void {
    if (state.touched.has(path)) return;
    state = { ...state, touched: new Set([...state.touched, path]) };
    emit();
  },
  /** Starts over for a page visit. */
  reset(patch: Partial<CreateState> = {}): void {
    const ownerId = patch.ownerId ?? null;
    const savedSnapshot = ownerId !== null && ownerId === state.ownerId && ownerId === guestRecovery.choice.ownerId
      ? guestRecovery.savedSnapshot : null;
    guestRecovery = { choice: { ownerId, disposition: "review" }, adoptedSnapshot: null, savedSnapshot };
    const quotes = patch.quotes ?? INITIAL_CREATE_STATE.quotes;
    const quote = quotes.includes(CREATE_QUOTE_TYPE) ? CREATE_QUOTE_TYPE : quotes[0] ?? CREATE_QUOTE_TYPE;
    state = { ...INITIAL_CREATE_STATE, draft: blankDraft(quote), touched: new Set(), ...patch };
    if (!patch.draft && !venueAvailable(state, state.draft.venue) && venueAvailable(state, "bluefin")) {
      const tiers = venueTiers("bluefin").filter(([spacing, fee]) => bluefinTierSupported(state.bluefinOptions, spacing, fee));
      const fee = tiers.reduce((best, [, next]) => Math.abs(next - state.draft.pool_fee) < Math.abs(best - state.draft.pool_fee) ? next : best, tiers[0]![1]);
      state = { ...state, draft: { ...state.draft, venue: "bluefin", pool_fee: fee } };
    }
    emit();
  },
  /** A completed launch stays on the profile; its form starts a separate draft, from its first step. */
  startNewDraft(): void {
    const { ownerId, selfAddress, networkFees, fees, publish, quotes, suiPrice, cetusTiers, bluefinOptions } = state;
    createStore.reset({
      ownerId, selfAddress, networkFees, fees, publish, quotes, suiPrice, cetusTiers, bluefinOptions,
      phase: ownerId === null ? "visitor" : "ready",
      draftId: ownerId === null ? null : crypto.randomUUID(),
      nowMs: Date.now(),
    });
  },
  /** Takes a server answer as the saved state; edits typed since it went out stay. */
  adopt(response: CreateDraftResponse, keepEdits: boolean): void {
    if (state.draftId !== null && response.draft_id !== state.draftId) return;
    if (response.published_presale_id) return createStore.startNewDraft();
    state = {
      ...state,
      phase: "ready",
      draftId: response.draft_id,
      version: response.version,
      draft: keepEdits ? state.draft : response.draft,
      dirty: keepEdits ? state.dirty : false,
      logoUrl: response.logo_url,
      cover: response.cover,
      allowlist: response.allowlist,
      fees: response.fee_policy,
      quotes: response.quotes,
      cetusTiers: response.cetus_tiers ?? null,
      bluefinOptions: response.bluefin_options ?? { status: "unavailable" },
      suiPrice: response.sui_price,
    };
    emit();
  },
});

const getServer = () => INITIAL_CREATE_STATE;

/**
 * Publishing, as the page (`CreateScreen`) wires it: the right column is a
 * separate route slot, so its Publish button reaches the page's action
 * through this registry. Null while no page can publish.
 */
type PublishAction = (() => void) | null;
let publishAction: PublishAction = null;
const publishListeners = new Set<() => void>();
export const createPublishAction = Object.freeze({
  get: (): PublishAction => publishAction,
  set(action: PublishAction): void {
    if (publishAction === action) return;
    publishAction = action;
    for (const listener of publishListeners) listener();
  },
  subscribe(listener: () => void): () => void {
    publishListeners.add(listener);
    return () => publishListeners.delete(listener);
  },
});

export function usePublishAction(): PublishAction {
  return useSyncExternalStore(createPublishAction.subscribe, createPublishAction.get, () => null);
}

export function useCreateState(): CreateState {
  return useSyncExternalStore(createStore.subscribe, createStore.get, getServer);
}

/** The allowlist the checks see: the server's summary, or the one just read in the browser. */
export function allowlistForChecks(current: CreateState): CreateAllowlistSummary | null {
  if (current.allowlist && current.allowlist.allowlist_id === current.draft.allowlist_id) return current.allowlist;
  if (current.localAllowlist && current.draft.allowlist_id) {
    return {
      allowlist_id: current.draft.allowlist_id, root: "", leaf_count: current.localAllowlist.n, min_cap: current.localAllowlist.min, max_cap: current.localAllowlist.max,
      quote_type: current.localAllowlist.quoteType,
    };
  }
  return null;
}

/** Once signing has begun, price changes don't block resuming a publish. */
export function presaleRaiseIssue(current: CreateState): CreateIssue | null {
  const { draft, quotes, publish, publishLocked } = current;
  if (!publish.available || publishLocked || !quotes.includes(draft.quote_type) || draft.target <= 0 || draft.target > CREATE_MAX_USD) return null;
  return minimumRaiseIssue(draft, selectedRaiseQuoteUsd(current));
}

export function selectedRaiseQuoteUsd({ draft, raiseQuotePrice }: CreateState): string | null {
  return raiseQuotePrice?.quoteType === draft.quote_type ? raiseQuotePrice.usd : null;
}

/** What is left to fix before publishing from Blast web. */
export function issuesOf(current: CreateState): CreateIssue[] {
  // The check time, so a scheduled start already past (or too far ahead) shows here as it does on the server.
  const issues = createIssues(current.draft, { fees: current.fees, allowlist: allowlistForChecks(current), creator: current.selfAddress, nowMs: Date.now() });
  if (!current.publishLocked) {
    for (const issue of coinTextIssues(current.draft)) {
      issues.push({ ...issue, section: issue.path === "tagline" ? "links" : "token" });
    }
  }
  if (current.publish.available && !current.quotes.includes(current.draft.quote_type)) {
    issues.push({ section: "raise", path: "quote_type", message: "Choose an available raise coin" });
  }
  const raiseIssue = presaleRaiseIssue(current);
  if (raiseIssue) issues.push(raiseIssue);
  const cetusIssue = cetusDraftIssue(current.draft, current.cetusTiers);
  if (cetusIssue) issues.push(cetusIssue);
  const bluefinIssue = bluefinDraftIssue(current.draft, current.bluefinOptions);
  if (bluefinIssue) issues.push(bluefinIssue);
  return issues.map((issue) => issue.path === "venue" ? { ...issue, section: "raise" } : issue);
}
