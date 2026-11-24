"use client";

import { useState } from "react";

import type { SignerKind } from "../transaction/action-machine";
import { useLaunchpadSigners } from "../transaction/LaunchpadSignerProvider";
import { ComposerForm } from "./ComposerForm";
import { postThesis } from "./post-flow";
import { EMPTY_DRAFT, type ComposerResult } from "./theses-model";

/**
 * The post form with the page's signers (`LaunchpadSignerProvider`): a Privy
 * session or a direct wallet's Wallet Proof. Nothing initializes Privy or a
 * wallet until the author chooses one.
 */
export function ThesisComposer({ launchId, onPublished }: Readonly<{ launchId: string; onPublished: () => void }>) {
  const signers = useLaunchpadSigners();
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [pending, setPending] = useState<SignerKind | null>(null);
  const [problems, setProblems] = useState<readonly string[]>([]);
  const [result, setResult] = useState<ComposerResult | null>(null);

  const post = async (signer: SignerKind) => {
    setPending(signer);
    setResult(null);
    return await (async () => {
      const attempt = await postThesis({ draft, launchId, signer, signers });
      setProblems(attempt.problems);
      setResult(attempt.result);
      if (attempt.published) {
        setDraft(EMPTY_DRAFT);
        onPublished();
      }
    })().finally(() => {
      setPending(null);
    });
  };

  return (
    <ComposerForm
      draft={draft}
      signers={signers.kinds}
      pending={pending}
      problems={problems}
      result={result}
      onChange={setDraft}
      onPost={(signer) => void post(signer)}
    />
  );
}
