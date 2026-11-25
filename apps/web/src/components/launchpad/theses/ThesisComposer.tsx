"use client";

import { useState } from "react";

import type { SignerKind } from "../transaction/action-machine";
import { useLaunchpadSigners } from "../transaction/LaunchpadSignerProvider";
import { ComposerForm } from "./ComposerForm";
import { postThesis } from "./post-flow";
import { EMPTY_DRAFT, type ComposerDraft, type ComposerResult } from "./theses-model";

/**
 * The post form with the page's signers (`LaunchpadSignerProvider`): a Privy
 * session or a direct wallet's Wallet Proof. Nothing initializes Privy or a
 * wallet until the author chooses one.
 *
 * A post shows at once as "Posting…". A failure keeps the text and offers
 * Retry, which sends the same retry key, so a post that did reach the server
 * is answered with, never written twice. Editing the draft starts a new key.
 */
export function ThesisComposer({ launchId, onPublished }: Readonly<{ launchId: string; onPublished: () => void }>) {
  const signers = useLaunchpadSigners();
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [pending, setPending] = useState<SignerKind | null>(null);
  const [problems, setProblems] = useState<readonly string[]>([]);
  const [result, setResult] = useState<ComposerResult | null>(null);
  /** The draft's retry key and the signer of its last failed try (Retry's signer). */
  const [attempt, setAttempt] = useState<Readonly<{ key: string; failed: SignerKind | null }> | null>(null);

  const post = async (signer: SignerKind) => {
    const key = attempt?.key ?? crypto.randomUUID();
    setAttempt({ key, failed: null });
    setPending(signer);
    setResult(null);
    return await (async () => {
      const outcome = await postThesis({ draft, launchId, signer, signers, idempotencyKey: key });
      setProblems(outcome.problems);
      setResult(outcome.result);
      if (outcome.published) {
        // Text typed while the post was on its way stays.
        setDraft((current) => (current === draft ? EMPTY_DRAFT : current));
        setAttempt((current) => (current?.key === key ? null : current));
        onPublished();
      } else if (outcome.result) {
        // An edit while posting dropped the key: the changed text gets a new one.
        setAttempt((current) => (current?.key === key ? { key, failed: signer } : current));
      }
    })().finally(() => {
      setPending(null);
    });
  };

  const change = (next: ComposerDraft) => {
    setDraft(next);
    setAttempt(null);
  };

  const failed = attempt?.failed ?? null;
  return (
    <ComposerForm
      draft={draft}
      signers={signers.kinds}
      pending={pending}
      problems={problems}
      result={result}
      onChange={change}
      onPost={(signer) => void post(signer)}
      onRetry={failed ? () => void post(failed) : undefined}
    />
  );
}
