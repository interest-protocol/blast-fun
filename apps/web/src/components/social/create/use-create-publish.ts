import { PublicError, publicErrorMessage } from "#web/lib/errors.ts";
import { useCallback, useEffect, useRef, type RefObject } from "react";

import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { invalidateAfter } from "#web/lib/query/invalidate.ts";
import { coinTextIssues } from "@blast/core/modules/social/create/coin-text-policy.ts";
import { usePublishConfirmationToast, type PublishConfirmation } from "../use-publish-confirmation-toast";
import type { PrivyCoinSigner } from "../coins/signers.tsx";
import type { CreateApiOptions } from "./create-client.ts";
import { review } from "./create-navigation.ts";
import { createStore, presaleRaiseIssue, type CreateState } from "./create-store.ts";
import { isEmptyPublishCheckpoint, publishStorageKey } from "./create-publish-storage.ts";

type PublishOptions = Readonly<{
  state: CreateState;
  api(signal?: AbortSignal): CreateApiOptions;
  save(): Promise<void>;
  saving: RefObject<AbortController | null>;
  session: RefObject<AbortController | null>;
  privy: RefObject<PrivyCoinSigner | null>;
}>;

export function useCreatePublish(options: PublishOptions): () => void {
  const toast = useToast();
  const captureConfirmation = usePublishConfirmationToast();
  const client = useAppQueryClient();
  const publishing = useRef(false);
  const { draftId, selfAddress } = options.state;

  useEffect(() => {
    if (hasPublishProgress(draftId, selfAddress)) {
      createStore.set({ publishLocked: true, reviewOpen: true });
    }
  }, [draftId, selfAddress]);

  return useCallback(() => {
    const controller = options.session.current;
    if (publishing.current || !controller || controller.signal.aborted) {
      return;
    }
    const issue = presaleRaiseIssue(createStore.get());
    if (issue) {
      createStore.set({ reviewOpen: false, publishProgress: null, publishError: null });
      review([issue]);
      return;
    }
    publishing.current = true;
    createStore.set({ publishProgress: "Save draft", publishError: null, publishedPresaleId: null, publishLocked: true, reviewOpen: true });

    void runPublishing(options, controller, toast, captureConfirmation(), (presaleId) => {
      createStore.set({ publishedPresaleId: presaleId });
      void invalidateAfter(client, { kind: "publish" });
    }).finally(() => {
      publishing.current = false;
    });
  }, [options, toast, captureConfirmation, client]);
}

async function runPublishing(
  options: PublishOptions,
  controller: AbortController,
  toast: ReturnType<typeof useToast>,
  onConfirmed: PublishConfirmation,
  onPublished: (presaleId: string) => void,
): Promise<void> {
  try {
    if (!navigator.locks) {
      throw new PublicError("This browser can’t safely coordinate publishing. Use a current browser.");
    }
    await options.save();
    const draft = requireSavedDraft(options.saving.current);
    if (!hasPublishProgress(draft.draftId, draft.selfAddress)) {
      const [issue] = coinTextIssues(draft.draft);
      if (issue) throw new PublicError(issue.message, { code: "blocked_term" });
    }
    const [
      { publishPresale },
      { loadPublishSigner },
      { createMainnetClient },
    ] = await Promise.all([
      import("./create-publish-flow.ts"),
      import("./create-publish-wallet.ts"),
      import("../sponsored-transaction.ts"),
    ]);
    const api = options.api(controller.signal);
    const signer = await loadPublishSigner(api, draft.selfAddress, options.privy.current);
    const presaleId = await navigator.locks.request(
      publishStorageKey(draft.draftId, signer.address),
      { ifAvailable: true },
      async (lock) => {
        if (!lock) {
          throw new PublicError("This draft is already publishing in another tab. Finish there first.", { code: "publish_in_progress" });
        }
        return publishPresale({
          api,
          client: createMainnetClient(),
          storage: window.localStorage,
          draftId: draft.draftId,
          version: draft.version,
          creator: signer.address,
          fee: signer.fee,
          sign: signer.sign,
          progress: (publishProgress) => {
            if (!controller.signal.aborted) createStore.set({ publishProgress });
          },
          onConfirmed,
        });
      },
    );

    if (!controller.signal.aborted) {
      onPublished(presaleId);
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      const message = publicErrorMessage(error, "Publishing could not finish.", "publish_failed");
      createStore.set({ publishError: message });
      // The open sheet shows the error and says once that progress is saved; with it closed, the toast says both.
      if (!createStore.get().reviewOpen) toast("Publishing paused. Your progress is saved.", { sub: message });
    }
  } finally {
    if (!controller.signal.aborted) {
      const current = createStore.get();
      createStore.set({
        publishProgress: current.publishError ? current.publishProgress : null,
        publishLocked: current.publishedPresaleId !== null || hasPublishProgress(current.draftId, current.selfAddress),
      });
    }
  }
}

function requireSavedDraft(saving: AbortController | null) {
  const draft = createStore.get();
  if (
    saving ||
    draft.dirty ||
    !draft.draftId ||
    draft.version === 0 ||
    draft.logoPreview ||
    draft.coverPreview ||
    draft.allowlistUploading
  ) {
    throw new PublicError("Wait for your draft and images to finish saving, then publish.");
  }
  return { ...draft, draftId: draft.draftId };
}

function hasPublishProgress(draftId: string | null, creator: string | null): boolean {
  if (!draftId || !creator) {
    return false;
  }
  try {
    const raw = window.localStorage.getItem(publishStorageKey(draftId, creator));
    return !!raw && !isEmptyPublishCheckpoint(raw);
  } catch {
    return false;
  }
}
