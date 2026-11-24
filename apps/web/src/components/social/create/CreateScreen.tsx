"use client";
import { downloadBlob } from "#web/lib/download-blob.ts";
import { quoteDisplaySymbol } from "./quote-coins";

import type { BluefinCreateOptions } from "@blast/core/modules/social/create/bluefin-options.ts";
import type { CreateCetusTiers } from "@blast/core/modules/social/create/cetus-options.ts";

import { diagnosticMessage, publicErrorCopy } from "#web/lib/errors.ts";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { Button } from "#web/components/blast-ui/Button.tsx";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { CREATE_LOGO_MAX_BYTES, CREATE_QUOTE_TYPE, type CreateFeePolicy, type CreatePublishAvailability, type CreateQuotePrice } from "@blast/core/web/contracts/create.ts";
import { SALE_COVER_MAX_BYTES } from "@blast/core/web/contracts/sales.ts";

import { SignInLink, useSocialViewer, type SocialViewer } from "../SignInGate";
import { useQuoteUsd } from "../prices/use-quote-usd";
import { useSocialAccount, type UseSocialAccount } from "../use-social-account";
import { AllowlistReview } from "./AllowlistReview";
import { fetchDraft, fetchLatestDraftId, removeCover, saveDraft, uploadCover, uploadLogo, type CreateApiOptions } from "./create-client";
import { createStore, guestDispositionForOwner, persistGuestDraft, restoreGuestDraft, useCreateState, type CreateState, type GuestChoice, type GuestDisposition } from "./create-store";
import { CreateView, DRAFT_NOT_LOADED } from "./CreateView";
import { networkFeesOf, selfAddressOf } from "./create-screen-model";
import { PrivyCoinSignerBridge, type PrivyCoinSigner } from "../coins/signers.tsx";
import { usePrivySessionMounted } from "#web/components/presale/providers/PrivySessionProvider.tsx";
import { useAllowlistUpload } from "./use-allowlist-upload";
import { useCreatePublish } from "./use-create-publish.ts";
import { GuestDraftRecovery } from "./GuestDraftRecovery.tsx";
import { acknowledgeGuestDraft, GUEST_DRAFT_MAX_BYTES, GuestDraftStorageError, guestDraftSource, importGuestDraft, type GuestDraftRestore, type GuestDraftSnapshot } from "./guest-draft-storage.ts";

/** How long typing pauses before a save goes out, and the retry steps after a failed one. */
const SAVE_DELAY_MS = 800;
const RETRY_MS = [2_000, 5_000, 10_000, 30_000] as const;
type AdoptedGuest = Readonly<{ ownerId: string; draftId: string; source: string }>;

const LOGO_REFUSALS: Readonly<Record<string, string>> = {
  invalid_logo: "Use a PNG, JPEG or WebP image, at least 64 pixels on each side",
  logo_upload_unavailable: "Logo uploads aren’t available right now. Try again later",
};

/** R3-25: why a cover did not upload, in the page's words. */
const COVER_REFUSALS: Readonly<Record<string, string>> = {
  invalid_cover: "Use a still PNG, JPEG or WebP image, at least 128 pixels on each side",
  body_too_large: "Use an image under 4 MB",
  cover_upload_unavailable: "Cover uploads aren’t available right now. Try again later",
  draft_published: "This draft is published: change the cover on the sale’s page",
};

/** The form and Review rail share the price for the selected raise coin. */
function useRaiseQuotePrice({ draft, phase, publish, publishLocked, quotes, raiseQuotePrice }: CreateState): void {
  const quote = draft.quote_type;
  const active = (phase === "ready" || phase === "visitor") && publish.available && !publishLocked;
  const quoteType = active && quote !== CREATE_QUOTE_TYPE && quotes.includes(quote) ? quote : null;
  const usd = useQuoteUsd(quoteType);
  useLayoutEffect(() => {
    if (quoteType && usd) {
      if (raiseQuotePrice?.quoteType !== quoteType || raiseQuotePrice.usd !== usd) {
        createStore.set({ raiseQuotePrice: { quoteType, usd } });
      }
    } else if (raiseQuotePrice !== null) {
      createStore.set({ raiseQuotePrice: null });
    }
  }, [quoteType, usd, raiseQuotePrice]);
}

/**
 * The Create page with its data (the live design's Create, UI-20): the
 * account's most recent draft, or a blank one; every edit saved after a
 * short pause, one save at a time, over the version it edited (a save from
 * another tab in between refreshes the saved version while retaining local edits); the logo and
 * the allowlist reviewed before it uploads. The preview in the right
 * column reads the same store.
 */
export function CreateScreen({ fees, publish, quotes, suiPrice, cetusTiers = null, bluefinOptions = { status: "unavailable" } }: Readonly<{ fees: CreateFeePolicy; publish: CreatePublishAvailability; quotes: readonly string[]; suiPrice: CreateQuotePrice | null; cetusTiers?: CreateCetusTiers | null; bluefinOptions?: BluefinCreateOptions }>) {
  const viewer = useSocialViewer();
  const { status, account: liveAccount, refresh: refreshAccount } = useSocialAccount();
  const account = viewer.signedIn ? liveAccount : null;
  const accountId = account?.account_id ?? null;
  const state = useCreateState();
  useRaiseQuotePrice(state);
  const accountReady = hasVerifiedAccount(status, accountId, viewer.sessionPending);
  const unknownAccount = isAccountIdentityUnknown(viewer, status, accountId);
  const recoveryOwnerId = unknownAccount ? createStore.guestRecovery().choice.ownerId : accountId;
  const viewState = accountViewState(state, status, unknownAccount);
  const toast = useToast();
  const privyMounted = usePrivySessionMounted();
  const privySigner = useRef<PrivyCoinSigner | null>(null);
  const onSignerChange = useCallback((signer: PrivyCoinSigner | null) => {
    privySigner.current = signer;
  }, []);
  const tokens = useRef(viewer.getAccessToken);
  const [generation, setGeneration] = useState(0);
  const saving = useRef<AbortController | null>(null);
  const session = useRef<AbortController | null>(null);
  const restored = useRef(false);
  const [guestRestore, setGuestRestore] = useState<GuestDraftRestore | null>(null);
  const guestRef = useRef<GuestDraftRestore | null>(null);
  const [guestChoice, setGuestChoice] = useState<GuestChoice>(() => createStore.guestRecovery().choice);
  const guestDisposition = guestDispositionForOwner(guestChoice, recoveryOwnerId);
  if (guestChoice.ownerId !== recoveryOwnerId) setGuestChoice({ ownerId: recoveryOwnerId, disposition: guestDisposition });
  const guestDispositionRef = useRef<GuestDisposition>(guestDisposition);
  const adoptedIdentity = useRef<AdoptedGuest | null>(null);
  const [accountSavePending, setAccountSavePending] = useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const updateGuest = useCallback((value: GuestDraftRestore) => {
    guestRef.current = value;
    setGuestRestore(value);
  }, []);
  const updateGuestDisposition = useCallback((value: GuestDisposition, snapshot: GuestDraftSnapshot | null = null) => {
    guestDispositionRef.current = value;
    setGuestChoice(createStore.chooseGuest(value, snapshot));
  }, []);
  const blocked = guestRecoveryBlocks(guestRestore, guestDisposition, state);
  const recoveryBlocks = useCallback(() => {
    return guestRecoveryBlocks(guestRef.current, guestDispositionRef.current, createStore.get());
  }, []);
  const endSession = useCallback((controller: AbortController) => {
    controller.abort();
    if (saving.current === controller) {
      saving.current = null;
      setAccountSavePending(false);
      createStore.set({ dirty: true });
    }
  }, [setAccountSavePending]);
  const acknowledgeSavedGuest = useCallback((saved: CreateState, controller: AbortController) => {
    const adopted = adoptedIdentity.current;
    const guest = guestRef.current;
    if (adopted === null || guest === null || adopted.ownerId !== saved.ownerId || adopted.draftId !== saved.draftId ||
        controller !== session.current || controller.signal.aborted || createStore.get().ownerId !== saved.ownerId || createStore.get().draftId !== saved.draftId) return;
    if (guestDraftSource(guest) !== adopted.source) {
      adoptedIdentity.current = null;
      return;
    }
    adoptedIdentity.current = null;
    if (guest.status !== "canonical") return;
    createStore.rememberGuestSave(guest.snapshot);
    try {
      const remaining = acknowledgeGuestDraft(window.sessionStorage, guest, adopted.source);
      if (remaining.status === "empty") {
        updateGuestDisposition("review");
        updateGuest(remaining);
        return;
      }
    } catch {
      // The account save succeeded; storage cleanup must not block subsequent edits.
    }
    updateGuestDisposition("separate");
    updateGuest(browserGuestDraft());
    setRecoveryError("Your account saved this draft, but browser backup cleanup could not finish. Any remaining browser copies have been kept.");
  }, [updateGuest, updateGuestDisposition, setRecoveryError]);
  useEffect(() => {
    tokens.current = viewer.getAccessToken;
  }, [viewer.getAccessToken]);
  const api = useCallback((signal?: AbortSignal): CreateApiOptions => ({ getAccessToken: () => tokens.current?.() ?? Promise.resolve(null), signal }), []);

  // Restore guest inputs once, including a full-page OAuth return. Account drafts remain server-owned.
  useLayoutEffect(() => {
    if (!restored.current) {
      restored.current = true;
      if (createStore.get().publishedPresaleId !== null) createStore.startNewDraft();
      const guest = browserGuestDraft();
      updateGuest(guest);
      const disposition = restoreLocalDraft({ fees, publish, quotes, suiPrice, cetusTiers, bluefinOptions }, guest, recoveryOwnerId);
      updateGuestDisposition(disposition, adoptedGuestSnapshot(disposition, guest));
    }
    createStore.set({ quotes, suiPrice, cetusTiers, bluefinOptions });
    const current = createStore.get();
    if (status === "loading") {
      setUnknownAccountPhase(current, "loading", fees, publish);
      return;
    }
    if (unknownAccount) {
      setUnknownAccountPhase(current, "error", fees, publish);
      return;
    }
    if (current.ownerId && current.ownerId !== accountId) {
      adoptedIdentity.current = null;
      createStore.reset({ fees, publish, quotes, suiPrice, cetusTiers, bluefinOptions, nowMs: Date.now() });
    }
    guestDispositionRef.current = createStore.bindGuestOwner(accountId).choice.disposition;
    if (!viewer.signedIn || status === "signed_out") {
      createStore.set({ phase: "visitor", fees, publish, nowMs: Date.now() });
      return;
    }
    const controller = new AbortController();
    session.current = controller;
    const guest = createStore.get();
    createStore.set({ ownerId: accountId, fees, publish, nowMs: Date.now(), selfAddress: selfAddressOf(account), networkFees: networkFeesOf(account) });
    const unsavedDraft = guest.version === 0 && guest.draftId !== null && guest.phase !== "error";
    if ((guest.ownerId === null && guest.dirty && guest.draftId === null) || unsavedDraft) {
      const draftId = guest.draftId ?? crypto.randomUUID();
      if (guestDispositionRef.current === "adopted") adoptedIdentity.current = guestIdentity(guestRef.current, accountId, draftId);
      createStore.set({ phase: "ready", draftId, version: 0 });
    } else {
      createStore.set({ phase: "loading" });
      void (async () => {
        let draftId = guest.draftId;
        if (draftId === null) {
          const latest = await fetchLatestDraftId(api(controller.signal));
          if (controller.signal.aborted) return;
          if (latest.status !== "ok") return createStore.set({ phase: "error", errorMessage: diagnosticMessage(publicErrorCopy(latest.code, "Your drafts could not load. Try again."), latest) });
          draftId = latest.body;
        }
        if (draftId === null) return createStore.set({ phase: "ready", draftId: crypto.randomUUID(), version: 0 });
        const loaded = await fetchDraft(api(controller.signal), draftId);
        if (controller.signal.aborted) return;
        if (loaded.status !== "ok") return createStore.set({ phase: "error", errorMessage: diagnosticMessage(publicErrorCopy(loaded.code, DRAFT_NOT_LOADED), loaded), draftId });
        if (loaded.body.published_presale_id) return createStore.startNewDraft();
        createStore.adopt(loaded.body, guest.phase !== "error" && createStore.get().dirty);
      })();
    }
    return () => endSession(controller);
    // Refreshed account metadata must not reload the draft while the creator is typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer.signedIn, viewer.sessionPending, status, accountId, generation]);

  useEffect(() => () => {
    if (createStore.get().publishedPresaleId !== null) createStore.startNewDraft();
  }, []);

  useEffect(() => {
    const persist = () => {
      const guest = guestRef.current;
      if (guest === null || guestDispositionRef.current === "separate" || (guestDispositionRef.current === "keep_current" && createStore.get().ownerId !== null) || recoveryBlocks()) return;
      try {
        const next = persistGuestDraft(window.sessionStorage, createStore.get(), guest, guestDispositionRef.current === "adopted");
        if (next !== guest) {
          if (next.status === "canonical") updateGuestDisposition("adopted", next.snapshot);
          updateGuest(next);
        }
      } catch (error) {
        updateGuestDisposition("review");
        updateGuest(guestWriteRefusal(error));
      }
    };
    persist();
    return createStore.subscribe(persist);
  }, [recoveryBlocks, updateGuest, updateGuestDisposition]);

  const { save, ensureSaved, resetRetries } = useDraftPersistence({
    accountReady, blocked, accountSavePending, state,
    api, toast, recoveryBlocks, acknowledgeSavedGuest, saving, session,
    guestDispositionRef, setAccountSavePending,
  });
  const { onLogo, onCover, onCoverRemove } = useCreateImages({ api, session, ensureSaved, toast });

  const { onList, acceptList, closeList, listReview, actions: allowlistActions } = useAllowlistUpload({ state: viewState, api, session });

  const onPublish = useCreatePublish({ state, api, save, saving, session, privy: privySigner });

  const checkGuestStorage = () => {
    adoptedIdentity.current = null;
    updateGuestDisposition("review");
    setRecoveryError(null);
    updateGuest(browserGuestDraft());
  };
  const importRecovered = useCallback(async (file: File) => {
    const current = guestRef.current;
    if (current === null || current.status === "storage_error") return;
    await importRecoveryFile(file, current.snapshot, {
      setBusy: setRecoveryBusy,
      setError: setRecoveryError,
      onRecovered: (recovered) => {
        updateGuestDisposition("review");
        adoptedIdentity.current = null;
        updateGuest(recovered);
      },
    });
  }, [updateGuest, updateGuestDisposition, setRecoveryBusy, setRecoveryError]);
  const onUseRecovered = useCallback(() => {
    const recovered = guestRef.current;
    const current = createStore.get();
    if (recovered?.status !== "canonical" || activeDraftOperation(current) || (current.dirty || (saving.current !== null && !saving.current.signal.aborted))) return;
    const actual = browserGuestDraft();
    if (actual.status !== "canonical" || actual.snapshot.canonicalRaw !== recovered.snapshot.canonicalRaw || actual.snapshot.retainedRaw !== recovered.snapshot.retainedRaw) {
      updateGuest(actual);
      setRecoveryError("The retained copies changed. Check browser storage before using a draft.");
      return;
    }
    session.current?.abort();
    updateGuestDisposition("adopted", recovered.snapshot);
    const draftId = current.ownerId === null ? null : crypto.randomUUID();
    adoptedIdentity.current = guestIdentity(recovered, current.ownerId, draftId);
    closeList();
    resetRetries();
    createStore.set({ phase: current.ownerId === null ? "visitor" : "ready", draft: recovered.draft, draftId, version: 0, dirty: true,
      logoUrl: null, cover: null, allowlist: null, localAllowlist: null, publishedPresaleId: null,
      logoPreview: null, coverPreview: null, allowlistUploading: false, reviewOpen: false,
      publishLocked: false, publishProgress: null, publishError: null, touched: new Set(),
      tried: false, quoteOpen: false, flash: null, errorMessage: undefined });
    setRecoveryError(null);
    setGeneration((value) => value + 1);
  }, [closeList, updateGuest, updateGuestDisposition, setRecoveryError, resetRetries]);
  const exportCopy = (raw: string, name: string) => {
    try {
      downloadBlob(new Blob([raw], { type: "application/json" }), name);
    } catch { setRecoveryError("The draft export could not start. The retained copy is unchanged."); }
  };
  const wasBlocked = useRef(blocked);
  useEffect(() => {
    if (wasBlocked.current && !blocked) {
      const heading = document.querySelector<HTMLHeadingElement>("[data-create-page] [data-page-head] h1");
      heading?.setAttribute("tabindex", "-1");
      heading?.focus();
    }
    wasBlocked.current = blocked;
  }, [blocked]);

  return (
    <>
      {privyMounted ? <PrivyCoinSignerBridge onChange={onSignerChange} /> : null}
      <SeparateDraftNotice disposition={guestDisposition} error={recoveryError} accountId={accountId} activeOperation={activeDraftOperation(state)} onReview={checkGuestStorage} />
      {blocked && guestRestore ? <GuestDraftRecovery restored={guestRestore} busy={recoveryBusy} error={recoveryError}
        unsavedDraft={state.dirty || accountSavePending} separateDraft={state.ownerId !== null && state.draftId !== null}
        onExport={exportCopy} onImport={importRecovered} onUse={onUseRecovered} onRetry={checkGuestStorage}
        activeOperation={activeDraftOperation(state)} onContinueSeparate={() => {
          adoptedIdentity.current = null;
          updateGuestDisposition("separate");
          setRecoveryError(null);
        }}
        onKeepCurrent={state.ownerId !== null && state.version > 0 ? () => {
          updateGuestDisposition("keep_current");
        } : undefined} /> : <CreateView
        allowlistActions={allowlistActions}
        onCover={(file) => void onCover(file)}
        onCoverRemove={() => void onCoverRemove()}
        onList={onList}
        onLogo={(file) => void onLogo(file)}
        onRetry={() => {
          if (!account) refreshAccount();
          else setGeneration((value) => value + 1);
        }}
        onPublish={onPublish}
        signIn={<SignInLink className="btn btn-primary btn-sm" />}
        state={viewState}
      />}
      {listReview ? (
        <AllowlistReview saved={listReview.saved} busy={state.allowlistUploading} errors={listReview.errors} fileName={listReview.fileName} onAccept={acceptList} onClose={closeList} parsed={listReview.parsed} symbol={quoteDisplaySymbol(listReview.quote.symbol)} uploadError={listReview.uploadError} />
      ) : null}
    </>
  );
}

function SeparateDraftNotice({ disposition, error, accountId, activeOperation, onReview }: Readonly<{
  disposition: GuestDisposition;
  error: string | null;
  accountId: string | null;
  activeOperation: boolean;
  onReview: () => void;
}>) {
  if (disposition !== "separate") return null;
  const copy = accountId === null
    ? "This separate draft is not saved in this browser. Sign in to save it to your account. Your browser backups are unchanged."
    : "This draft saves to your account. Retained browser backups are kept separate and unchanged.";
  return <p role="status">
    {error ?? copy}
    {" "}<Button variant="secondary" size="sm" className="btn btn-quiet btn-sm" disabled={activeOperation} onClick={onReview} type="button">Review browser draft</Button>
  </p>;
}

type CreateApi = (signal?: AbortSignal) => CreateApiOptions;
type CreateToast = ReturnType<typeof useToast>;
type SessionRef = RefObject<AbortController | null>;

function useDraftPersistence({ accountReady, blocked, accountSavePending, state,
  api, toast, recoveryBlocks, acknowledgeSavedGuest, saving, session, guestDispositionRef,
  setAccountSavePending }: Readonly<{
  accountReady: boolean;
  blocked: boolean;
  accountSavePending: boolean;
  state: CreateState;
  api: CreateApi;
  toast: CreateToast;
  recoveryBlocks: () => boolean;
  acknowledgeSavedGuest: (saved: CreateState, controller: AbortController) => void;
  saving: SessionRef;
  session: SessionRef;
  guestDispositionRef: RefObject<GuestDisposition>;
  setAccountSavePending: (value: boolean) => void;
}>) {
  const failures = useRef(0);
  const [retryAt, setRetryAt] = useState(0);
  const resetRetries = useCallback(() => {
    failures.current = 0;
    setRetryAt(0);
  }, []);

  // Autosave: a pause in typing sends one save; edits made while it is out go in the next one.
  const save = useCallback(async () => {
    if (!accountReady) return;
    const current = createStore.get();
    if (recoveryBlocks() || (saving.current && !saving.current.signal.aborted) || !current.dirty || current.phase !== "ready" || !current.draftId) return;
    const controller = session.current;
    if (!controller || controller.signal.aborted) return;
    const sent = current.draft;
    createStore.set({ dirty: false });
    const result = await saveWhilePending(controller, saving, setAccountSavePending,
      () => saveDraft(api(controller.signal), current.draftId!, current.version, sent));
    if (controller.signal.aborted || createStore.get().draftId !== current.draftId) return;
    if (result.status === "ok") {
      if (result.body.draft_id !== current.draftId) return;
      acknowledgeSavedGuest(current, controller);
      failures.current = 0;
      const now = createStore.get();
      createStore.adopt(result.body, now.draft !== sent);
      return;
    }
    if (result.status === "refused" && result.code === "draft_conflict" && result.error.draft) {
      createStore.adopt(result.error.draft as Parameters<typeof createStore.adopt>[0], true);
      createStore.set({ dirty: true });
      toast("The saved draft changed", { sub: diagnosticMessage("Your local edits have been kept and will be saved over the latest version.", result) });
      return;
    }
    if (result.status === "refused" && result.code === "draft_limit") {
      createStore.set({ dirty: true });
      setRetryAt(Date.now() + RETRY_MS.at(-1)!);
      toast("You have the most drafts allowed", { tone: "error", sub: diagnosticMessage("Publish or delete one to start another.", result) });
      return;
    }
    createStore.set({ dirty: true });
    const wait = RETRY_MS[Math.min(failures.current, RETRY_MS.length - 1)]!;
    if (failures.current === 0) toast("Your draft isn’t saved yet", { tone: "error", sub: diagnosticMessage("We’ll keep trying.", result) });
    failures.current += 1;
    setRetryAt(Date.now() + wait);
  }, [api, toast, recoveryBlocks, acknowledgeSavedGuest, accountReady, setAccountSavePending, saving, session, failures, setRetryAt]);

  useEffect(() => {
    if (!accountReady || blocked || accountSavePending || !state.dirty || state.phase !== "ready") return;
    const delay = Math.max(SAVE_DELAY_MS, retryAt - Date.now());
    const timer = window.setTimeout(() => void save(), delay);
    return () => window.clearTimeout(timer);
  }, [state.dirty, state.draft, state.phase, retryAt, save, accountReady, blocked, accountSavePending]);

  const saveOnHide = useEffectEvent(save);

  // Leaving with an unsaved edit: save it now, and ask the browser to hold the page if one is still pending.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void saveOnHide();
    };
    const onLeave = (event: BeforeUnloadEvent) => {
      const current = createStore.get();
      const unpersistedGuest = current.ownerId === null && current.dirty && (guestDispositionRef.current === "separate" || recoveryBlocks());
      if (unpersistedGuest || (current.ownerId !== null && (current.dirty || saving.current))) event.preventDefault();
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onLeave);
    };
  }, [recoveryBlocks, guestDispositionRef, saving]);

  /** The draft's first save, when a logo or an allowlist needs it to exist. */
  const ensureSaved = useCallback(async (): Promise<boolean> => {
    if (!accountReady) return false;
    const current = createStore.get();
    const controller = session.current;
    if (recoveryBlocks() || current.phase !== "ready" || !controller || controller.signal.aborted) return false;
    if (current.version > 0 || !current.draftId) return current.version > 0;
    if (saving.current && !saving.current.signal.aborted) return false;
    const result = await saveWhilePending(controller, saving, setAccountSavePending,
      () => saveDraft(api(controller.signal), current.draftId!, 0, current.draft));
    if (controller.signal.aborted || result.status !== "ok" || result.body.draft_id !== current.draftId || createStore.get().draftId !== current.draftId) return false;
    acknowledgeSavedGuest(current, controller);
    createStore.adopt(result.body, createStore.get().draft !== current.draft);
    return true;
  }, [api, recoveryBlocks, acknowledgeSavedGuest, accountReady, setAccountSavePending, saving, session]);

  return { save, ensureSaved, resetRetries };
}

/** Release only this session's pending save, including when the request throws. */
async function saveWhilePending<T>(controller: AbortController, saving: SessionRef,
  setPending: (value: boolean) => void, save: () => Promise<T>): Promise<T> {
  saving.current = controller;
  setPending(true);
  try {
    return await save();
  } finally {
    releasePendingSave(controller, saving, setPending);
  }
}

function releasePendingSave(controller: AbortController, saving: SessionRef, setPending: (value: boolean) => void): void {
  if (saving.current !== controller) return;
  saving.current = null;
  setPending(false);
}

function useCreateImages({ api, session, ensureSaved, toast }: Readonly<{
  api: CreateApi;
  session: SessionRef;
  ensureSaved: () => Promise<boolean>;
  toast: CreateToast;
}>) {
  const onLogo = useCallback(
    async (file: File) => {
      const controller = session.current;
      if (!controller || controller.signal.aborted || createStore.get().phase !== "ready") return;
      if (file.size > CREATE_LOGO_MAX_BYTES) {
        toast(diagnosticMessage("Use an image under 2 MB", { code: "body_too_large" }), { tone: "error" });
        return;
      }
      const preview = URL.createObjectURL(file);
      createStore.set({ logoPreview: preview });
      const finish = () => {
        if (createStore.get().logoPreview === preview) createStore.set({ logoPreview: null });
        URL.revokeObjectURL(preview);
      };
      if (!(await ensureSaved())) {
        finish();
        if (controller.signal.aborted) return;
        toast("Your logo couldn’t upload", { tone: "error", sub: diagnosticMessage("Check your connection, then try again.") });
        return;
      }
      const result = await uploadLogo(api(controller.signal), createStore.get().draftId!, file);
      if (controller.signal.aborted) { finish(); return; }
      if (result.status === "ok") createStore.adopt(result.body, true);
      else toast("Your logo couldn’t upload", { tone: "error", sub: diagnosticMessage((result.status === "refused" && LOGO_REFUSALS[result.code]) || "Check your connection, then try again.", result) });
      finish();
    },
    [api, ensureSaved, toast, session],
  );

  /** R3-25: the sale's cover, uploaded as it is picked (the gate refuses one over 4 MB before reading it). */
  const onCover = useCallback(
    async (file: File) => {
      const controller = session.current;
      if (!controller || controller.signal.aborted || createStore.get().phase !== "ready") return;
      if (file.size > SALE_COVER_MAX_BYTES) {
        toast(diagnosticMessage("Use an image under 4 MB", { code: "body_too_large" }), { tone: "error" });
        return;
      }
      const preview = URL.createObjectURL(file);
      createStore.set({ coverPreview: preview });
      const finish = () => {
        if (createStore.get().coverPreview === preview) createStore.set({ coverPreview: null });
        URL.revokeObjectURL(preview);
      };
      if (!(await ensureSaved())) {
        finish();
        if (controller.signal.aborted) return;
        toast("Your cover couldn’t upload", { tone: "error", sub: diagnosticMessage("Check your connection, then try again.") });
        return;
      }
      const result = await uploadCover(api(controller.signal), createStore.get().draftId!, file);
      if (controller.signal.aborted) { finish(); return; }
      if (result.status === "ok") createStore.adopt(result.body, true);
      else toast("Your cover couldn’t upload", { tone: "error", sub: diagnosticMessage((result.status === "refused" && COVER_REFUSALS[result.code]) || "Check your connection, then try again.", result) });
      finish();
    },
    [api, ensureSaved, toast, session],
  );

  const onCoverRemove = useCallback(async () => {
    const current = createStore.get();
    const controller = session.current;
    if (current.phase !== "ready" || !controller || controller.signal.aborted || !current.draftId || current.version === 0) return;
    const result = await removeCover(api(controller.signal), current.draftId);
    if (controller.signal.aborted) return;
    if (result.status === "ok") createStore.adopt(result.body, true);
    else toast("The cover is still there", { tone: "error", sub: diagnosticMessage((result.status === "refused" && COVER_REFUSALS[result.code]) || "Check your connection, then try again.", result) });
  }, [api, toast, session]);

  return { onLogo, onCover, onCoverRemove };
}

async function importRecoveryFile(file: File, snapshot: GuestDraftSnapshot, actions: Readonly<{
  setBusy: (value: boolean) => void;
  setError: (value: string | null) => void;
  onRecovered: (value: GuestDraftRestore) => void;
}>): Promise<void> {
  actions.setBusy(true);
  actions.setError(null);
  try {
    const raw = await readRecoveryFile(file);
    actions.onRecovered(importGuestDraft(window.sessionStorage, raw, snapshot));
  } catch (error) {
    const code = error instanceof GuestDraftStorageError ? error.code : "storage_error";
    actions.setError(code === "invalid_file" ? "Choose a valid canonical recovery file. Your retained draft is unchanged." : code === "changed" || code === "conflict" ? "Browser copies changed or conflict. Export them and check storage again; nothing was overwritten." : "The recovery file could not be saved and verified. Your retained source is unchanged.");
  } finally {
    actions.setBusy(false);
  }
}

async function readRecoveryFile(file: File): Promise<string> {
  if (file.size > GUEST_DRAFT_MAX_BYTES) throw new GuestDraftStorageError("invalid_file");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    throw new GuestDraftStorageError("invalid_file");
  }
}

function guestIdentity(guest: GuestDraftRestore | null, ownerId: string | null, draftId: string | null): AdoptedGuest | null {
  if (!ownsGuestSnapshot(guest)) return null;
  const source = guest === null ? null : guestDraftSource(guest);
  return ownerId === null || draftId === null || source === null ? null : { ownerId, draftId, source };
}

function isAccountIdentityUnknown(viewer: Pick<SocialViewer, "signedIn" | "sessionPending">, status: UseSocialAccount["status"], accountId: string | null): boolean {
  return viewer.sessionPending === true || (viewer.signedIn && status !== "signed_out" && !hasVerifiedAccount(status, accountId, viewer.sessionPending));
}

function hasVerifiedAccount(status: UseSocialAccount["status"], accountId: string | null, sessionPending: boolean | undefined): boolean {
  return sessionPending !== true && status === "ready" && accountId !== null;
}

function accountViewState(current: CreateState, status: UseSocialAccount["status"], unknownAccount: boolean): CreateState {
  return unknownAccount ? { ...current, phase: status === "loading" ? "loading" : "error", errorMessage: "Your account could not load. Try again." } : current;
}

function setUnknownAccountPhase(current: CreateState, phase: "loading" | "error", fees: CreateFeePolicy, publish: CreatePublishAvailability): void {
  createStore.set({ fees, publish, ...(current.ownerId === null ? { phase } : {}) });
}

function adoptedGuestSnapshot(disposition: GuestDisposition, guest: GuestDraftRestore): GuestDraftSnapshot | null {
  return disposition === "adopted" && guest.status === "canonical" ? guest.snapshot : null;
}

function activeDraftOperation(current: Pick<CreateState, "publishLocked" | "logoPreview" | "coverPreview" | "allowlistUploading">): boolean {
  return current.publishLocked || current.logoPreview !== null || current.coverPreview !== null || current.allowlistUploading;
}

function browserGuestDraft(): GuestDraftRestore {
  try {
    const restored = restoreGuestDraft(window.sessionStorage);
    const saved = createStore.guestRecovery().savedSnapshot;
    return restored.status === "canonical" && saved !== null && sameGuestSnapshot(restored.snapshot, saved)
      ? { status: "acknowledged", snapshot: restored.snapshot }
      : restored;
  } catch { return { status: "storage_error" }; }
}

function sameGuestSnapshot(first: GuestDraftSnapshot, second: GuestDraftSnapshot): boolean {
  return first.canonicalRaw === second.canonicalRaw && first.retainedRaw === second.retainedRaw;
}

function ownsGuestSnapshot(guest: GuestDraftRestore | null): boolean {
  const adopted = createStore.guestRecovery().adoptedSnapshot;
  return guest?.status === "canonical" && adopted !== null && sameGuestSnapshot(guest.snapshot, adopted);
}

function guestWriteRefusal(error: unknown): GuestDraftRestore {
  const restored = browserGuestDraft();
  if (error instanceof GuestDraftStorageError && (error.code === "changed" || error.code === "conflict") && restored.status !== "storage_error")
    return { status: "recovery_required", snapshot: restored.snapshot, reason: error.code };
  return { status: "storage_error" };
}

function guestRecoveryBlocks(guest: GuestDraftRestore | null, disposition: GuestDisposition, current: Pick<CreateState, "ownerId" | "version">): boolean {
  const editingSavedAccount = disposition === "keep_current" && current.ownerId !== null && current.version > 0;
  return disposition !== "separate" && !editingSavedAccount && guest !== null && (guest.status === "acknowledged" || guest.status === "storage_error" || guest.status === "recovery_required" || (guest.status === "canonical" && disposition !== "adopted"));
}

function restoreLocalDraft(patch: Pick<CreateState, "fees" | "publish" | "quotes" | "suiPrice" | "cetusTiers" | "bluefinOptions">, guest: GuestDraftRestore, ownerId: string | null): GuestDisposition {
  const current = createStore.get();
  const disposition = guestDispositionForOwner(createStore.guestRecovery().choice, ownerId);
  if (disposition === "separate" || disposition === "keep_current") return disposition;
  if (disposition === "adopted") return ownsGuestSnapshot(guest) ? "adopted" : "review";
  if (current.ownerId !== null || current.draftId !== null || current.dirty) return "review";
  createStore.reset(patch);
  if (guest.status === "canonical" && guest.recoveredFrom === null) {
    createStore.set({ draft: guest.draft, dirty: true });
    return "adopted";
  }
  return "review";
}
