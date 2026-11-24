"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";

import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { diagnosticMessage, PublicError, publicErrorCopy, publicErrorMessage } from "#web/lib/errors.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { CREATE_LOGO_MAX_BYTES } from "@blast/core/web/contracts/create.ts";
import type { LaunchDraftResponse, LaunchPageContext } from "@blast/core/web/contracts/launch.ts";
import { SALE_COVER_MAX_BYTES } from "@blast/core/web/contracts/sales.ts";

import { usePublishConfirmationToast, type PublishConfirmation } from "../use-publish-confirmation-toast";
import type { PrivyCoinSigner } from "../coins/signers.tsx";
import type { SocialViewer } from "../SignInGate";
import { fetchLatestLaunchDraftId, fetchLaunchDraft, removeLaunchCover, saveLaunchDraft, uploadLaunchCover, uploadLaunchLogo, type LaunchApiOptions } from "./launch-client";
import { admittedLaunchDraft, initialLaunchState, issuesOf, launchStore, type LaunchState } from "./launch-store";

const SAVE_DELAY_MS = 800;
/** The draft read's generic failure: the load error's title already says it, so only its code shows. */
export const NOT_LOADED = "Check your connection, then try again.";

type Api = (signal?: AbortSignal) => LaunchApiOptions;

/** Applies a stored draft the server answered, keeping typing that has not gone out yet. */
function adopt(body: LaunchDraftResponse, keepTyping: boolean): void {
  const current = launchStore.get();
  // A launch already publishing keeps its coin: its stored draft is frozen.
  const draft = body.publishing || body.published_launch_id ? body.draft : admittedLaunchDraft(body.draft, body.rules);
  launchStore.set({
    phase: "ready",
    draftId: body.draft_id,
    version: body.version,
    rules: body.rules,
    logoUrl: body.logo_url,
    publishing: body.publishing,
    cover: body.cover,
    publishedLaunchId: body.published_launch_id,
    // A swapped coin is saved back, so the stored draft stops holding it.
    ...(keepTyping && current.dirty ? {} : { draft, dirty: draft !== body.draft }),
  });
}

/** The page's calls with the viewer's current credentials. */
export function useLaunchApi(viewer: Pick<SocialViewer, "getAccessToken">): Api {
  const tokens = useRef(viewer.getAccessToken);
  useEffect(() => {
    tokens.current = viewer.getAccessToken;
  }, [viewer.getAccessToken]);
  return useCallback((signal?: AbortSignal): LaunchApiOptions => ({ getAccessToken: () => tokens.current?.() ?? Promise.resolve(null), signal }), []);
}

async function loadNewest(api: Api, signal: AbortSignal): Promise<void> {
  const latest = await fetchLatestLaunchDraftId(api(signal));
  if (signal.aborted) return;
  if (latest.status !== "ok") return launchStore.set({ phase: "error", errorMessage: diagnosticMessage(publicErrorCopy(latest.code, NOT_LOADED), latest) });
  if (latest.body === null) return launchStore.set({ phase: "ready", draftId: crypto.randomUUID(), version: 0 });
  const draft = await fetchLaunchDraft(api(signal), latest.body);
  if (signal.aborted) return;
  if (draft.status === "ok") adopt(draft.body, false);
  else launchStore.set({ phase: "error", errorMessage: diagnosticMessage(publicErrorCopy(draft.code, NOT_LOADED), draft) });
}

/** Loads the account's newest unpublished draft once the account is known; a visitor is asked to sign in. */
export function useLaunchLoad(input: Readonly<{ context: LaunchPageContext; signedIn: boolean; sessionPending: boolean; ready: boolean; accountId: string | null; api: Api }>): void {
  const { context, signedIn, sessionPending, ready, accountId, api } = input;
  useEffect(() => {
    if (!context.publish.available) return;
    if (!signedIn && !sessionPending) {
      launchStore.reset({ ...initialLaunchState(context), phase: "visitor" });
      return;
    }
    if (!ready || !accountId) return;
    const controller = new AbortController();
    launchStore.reset({ ...initialLaunchState(context), accountId });
    void loadNewest(api, controller.signal);
    return () => controller.abort();
  }, [context, signedIn, sessionPending, ready, accountId, api]);
}

/**
 * Saves the typed draft, one save at a time, after a pause in typing; the
 * returned `save` resolves once the store holds a stored version.
 */
export function useLaunchSave(api: Api, state: Pick<LaunchState, "draft" | "dirty" | "phase">): () => Promise<void> {
  const toast = useToast();
  const saving = useRef<Promise<void> | null>(null);
  const save = useCallback(async (): Promise<void> => {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Draft versions share one save queue; each caller must wait for the current write before reading its version.
    while (saving.current) await saving.current;
    const current = launchStore.get();
    if (current.publishing || !current.draftId || current.phase !== "ready" || (!current.dirty && current.version > 0)) return;
    saving.current = (async () => {
      launchStore.set({ dirty: false });
      const answer = await saveLaunchDraft(api(), current.draftId!, current.version, current.draft);
      if (launchStore.get().accountId !== current.accountId) return;
      if (answer.status === "ok") return adopt(answer.body, true);
      launchStore.set({ dirty: true });
      if (answer.status === "refused" && answer.code === "draft_conflict" && answer.error.draft) {
        adopt(answer.error.draft as LaunchDraftResponse, false);
        toast("This draft changed in another tab", { sub: "The latest saved version is shown." });
        return;
      }
      throw new PublicError("Your draft couldn’t save. It will retry when you edit again.", answer);
    })().finally(() => {
      saving.current = null;
    });
    return saving.current;
  }, [api, toast]);

  const { draft, dirty, phase } = state;
  useEffect(() => {
    if (!dirty || phase !== "ready") return;
    const timer = setTimeout(() => {
      void save().catch(() => undefined);
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, dirty, phase, save]);
  return save;
}

function handleImageAnswer(answer: Awaited<ReturnType<typeof uploadLaunchLogo>>, kind: "logo" | "cover", toast: ReturnType<typeof useToast>): void {
  if (answer.status === "ok") adopt(answer.body, true);
  else {
    const invalid = answer.status === "refused" && (answer.code === "invalid_logo" || answer.code === "invalid_cover");
    toast(kind === "logo" ? "The logo didn’t upload" : "The cover didn’t upload", { tone: "error", sub: invalid ? "Use a still PNG, JPEG or WebP image." : "Try again in a moment." });
  }
}

async function uploadImage(api: Api, save: () => Promise<void>, toast: ReturnType<typeof useToast>, kind: "logo" | "cover", file: File): Promise<void> {
  if (file.size > (kind === "logo" ? CREATE_LOGO_MAX_BYTES : SALE_COVER_MAX_BYTES)) {
    toast(kind === "logo" ? "Use a logo under 2 MB" : "Use a cover under 4 MB", { tone: "error" });
    return;
  }
  const owner = launchStore.get().accountId;
  if (launchStore.get().publishing) return;
  const preview = URL.createObjectURL(file);
  launchStore.set(kind === "logo" ? { logoPreview: preview, dirty: true } : { coverPreview: preview, dirty: true });
  try {
    await save();
    if (launchStore.get().accountId !== owner) return;
    const draftId = launchStore.get().draftId!;
    const answer = kind === "logo" ? await uploadLaunchLogo(api(), draftId, file) : await uploadLaunchCover(api(), draftId, file);
    if (launchStore.get().accountId !== owner) return;
    handleImageAnswer(answer, kind, toast);
  } catch (error) {
    toast("The image didn’t upload", { tone: "error", sub: publicErrorMessage(error, "Try again in a moment.", "upload_failed") });
  } finally {
    URL.revokeObjectURL(preview);
    if (launchStore.get().accountId === owner) launchStore.set(kind === "logo" ? { logoPreview: null } : { coverPreview: null });
  }
}

/** The logo and the cover: shown at once from the picked file, uploaded once the draft is stored. */
export function useLaunchImages(api: Api, save: () => Promise<void>) {
  const toast = useToast();
  const upload = useCallback((kind: "logo" | "cover", file: File) => uploadImage(api, save, toast, kind, file), [api, save, toast]);
  const removeCover = useCallback(async () => {
    const owner = launchStore.get().accountId;
    const { draftId, version } = launchStore.get();
    if (!draftId || version === 0) return;
    const answer = await removeLaunchCover(api(), draftId);
    if (launchStore.get().accountId !== owner) return;
    if (answer.status === "ok") adopt(answer.body, true);
    else toast("The cover couldn’t be removed", { tone: "error", sub: "Try again in a moment." });
  }, [api, toast]);
  return { upload, removeCover };
}

async function runLaunch(
  api: Api,
  save: () => Promise<void>,
  privy: PrivyCoinSigner | null,
  onConfirmed: PublishConfirmation,
): Promise<string> {
  if (!navigator.locks) throw new PublicError("This browser can’t safely coordinate launching. Use a current browser.");
  await save();
  const current = launchStore.get();
  if (current.dirty || !current.draftId || current.version === 0 || current.logoPreview || current.coverPreview) throw new PublicError("Wait for your draft and images to finish saving, then launch.");
  // Resuming before a publication exists still starts a new launch.
  const issue = current.publishing ? undefined : issuesOf(current)[0];
  if (issue) throw new PublicError(issue.message, { code: "draft_incomplete" });
  const draftId = current.draftId;
  const [{ publishLaunch, launchProgressKey }, { loadPublishSigner }, { createMainnetClient }] = await Promise.all([
    import("./launch-publish-flow.ts"),
    import("../create/create-publish-wallet.ts"),
    import("../sponsored-transaction.ts"),
  ]);
  const options = api();
  const signer = await loadPublishSigner(options, current.selfAddress, privy);
  return navigator.locks.request(launchProgressKey(draftId, signer.address), { ifAvailable: true }, async (lock) => {
    if (!lock) throw new PublicError("This draft is already launching in another tab. Finish there first.", { code: "publish_in_progress" });
    return publishLaunch({
      api: options,
      client: createMainnetClient(),
      storage: window.localStorage,
      draftId,
      version: current.version,
      creator: signer.address,
      fee: signer.fee,
      sign: (bytes) => {
        if (launchStore.get().accountId !== current.accountId) throw new PublicError("The signed-in account changed. Resume with the original account.");
        return signer.sign(bytes);
      },
      onConfirmed: (step, digest) => {
        if (launchStore.get().accountId === current.accountId) onConfirmed(step, digest);
      },
      progress: (publishStep) => {
        if (launchStore.get().accountId !== current.accountId) throw new PublicError("The signed-in account changed. Resume with the original account.");
        launchStore.set({ publishStep });
      },
    });
  });
}

/** Launching: saves, then signs and sends the three steps, resuming saved progress. */
export function useLaunchPublish(api: Api, save: () => Promise<void>, privy: RefObject<PrivyCoinSigner | null>): () => void {
  const queries = useAppQueryClient();
  const launching = useRef(false);
  const captureConfirmation = usePublishConfirmationToast();
  return useCallback(() => {
    if (launching.current) return;
    launching.current = true;
    launchStore.set({ publishError: null, sheetOpen: true, publishStep: "publish_coin" });
    const owner = launchStore.get().accountId;
    void runLaunch(api, save, privy.current, captureConfirmation())
      .then((launchId) => {
        if (launchStore.get().accountId !== owner) return;
        launchStore.set({ publishedLaunchId: launchId, publishing: true });
        void queries.invalidateQueries({ queryKey: queryKeys.feed.all });
      })
      .catch(async (error: unknown) => {
        if (launchStore.get().accountId !== owner) return;
        const draftId = launchStore.get().draftId;
        const answer = draftId ? await fetchLaunchDraft(api(), draftId) : null;
        if (launchStore.get().accountId !== owner) return;
        if (answer?.status === "ok") adopt(answer.body, false);
        launchStore.set({ publishError: publicErrorMessage(error, "Launching could not finish.", "launch_failed") });
      })
      .finally(() => {
        launching.current = false;
      });
  }, [api, save, privy, queries, captureConfirmation]);
}
