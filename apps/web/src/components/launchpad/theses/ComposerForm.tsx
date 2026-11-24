import { SelectField } from "#web/components/blast-ui/TextField.tsx";
import { useId } from "react";

import { THESIS_STANCES, type PostKind, type ThesisStance } from "@blast/core/modules/launchpad-social/post-contract.ts";
import { SOCIAL_LIMITS } from "@blast/core/modules/launchpad-social/limits.ts";

import type { SignerKind } from "../transaction/action-machine";
import { KIND_LABELS, STANCE_LABELS, type ComposerDraft, type ComposerResult } from "./theses-model";
import styles from "./Theses.module.css";

/** Anyone's thesis first; the creator kinds hold only for the launch's creator wallet. */
const KINDS: readonly PostKind[] = ["community_thesis", "creator_thesis", "creator_update"];

function codePoints(text: string): number {
  return [...text].length;
}

function PostButton({ signer, label, pending, onPost }: Readonly<{ signer: SignerKind; label: string; pending: SignerKind | null; onPost: (signer: SignerKind) => void }>) {
  return (
    <button
      className={styles.button}
      type="button"
      aria-disabled={pending !== null || undefined}
      onClick={() => {
        if (pending === null) onPost(signer);
      }}
    >
      {label}
    </button>
  );
}

/**
 * The post form: kind, stance, inert text, evidence links and an optional
 * disclosure, each with its limit, then one button per credential this app
 * supports. Posting is the author's own claim under the identity that signs.
 */
export function ComposerForm({
  draft,
  signers,
  pending,
  problems,
  result,
  onChange,
  onPost,
}: Readonly<{
  draft: ComposerDraft;
  /** The credentials offered: a Privy session and/or a wallet's Wallet Proof. */
  signers: readonly SignerKind[];
  /** The credential a post is waiting on; null when idle. */
  pending: SignerKind | null;
  /** What to fix before anything is sent. */
  problems: readonly string[];
  result: ComposerResult | null;
  onChange: (draft: ComposerDraft) => void;
  onPost: (signer: SignerKind) => void;
}>) {
  const id = useId();
  const limits = SOCIAL_LIMITS;
  const update = (change: Partial<ComposerDraft>) => onChange({ ...draft, ...change });
  const stances: readonly (ThesisStance | null)[] = draft.kind === "creator_update" ? [...THESIS_STANCES, null] : THESIS_STANCES;
  return (
    <form className={styles.composer} aria-labelledby={`${id}-heading`} onSubmit={(event) => event.preventDefault()}>
      <h3 className={styles.composerHeading} id={`${id}-heading`}>Post a thesis</h3>
      <p className={styles.note}>
        Signing in with Privy or signing a free wallet message posts under that identity. A wallet message is not a transaction.
      </p>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-kind`}>Kind</label>
        <SelectField
          id={`${id}-kind`}
          value={draft.kind}
          aria-describedby={`${id}-kind-hint`}
          onChange={(event) => update({ kind: event.target.value as PostKind })}
        >
          {KINDS.map((kind) => (
            <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>
          ))}
        </SelectField>
        <p className={styles.hint} id={`${id}-kind-hint`}>
          A creator thesis or update stays one only when posted from this launch&apos;s creator wallet; otherwise it is posted as a
          community thesis.
        </p>
      </div>

      <fieldset className={styles.stances}>
        <legend className={styles.label}>Stance{draft.kind === "creator_update" ? " (optional for a creator update)" : ""}</legend>
        {stances.map((stance) => (
          <label key={stance ?? "none"} className={styles.choice}>
            <input
              type="radio"
              name={`${id}-stance`}
              value={stance ?? ""}
              checked={draft.stance === stance}
              onChange={() => update({ stance })}
            />
            {stance ? STANCE_LABELS[stance] : "No stance"}
          </label>
        ))}
      </fieldset>

      <div className={styles.field}>
        <div className={styles.labelRow}>
          <label className={styles.label} htmlFor={`${id}-body`}>Thesis</label>
          <span className={styles.counter} id={`${id}-body-count`}>
            {codePoints(draft.body).toLocaleString("en-US")} / {limits.bodyCodePoints.toLocaleString("en-US")}
          </span>
        </div>
        <textarea
          className={styles.textarea}
          id={`${id}-body`}
          rows={5}
          value={draft.body}
          aria-describedby={`${id}-body-count`}
          onChange={(event) => update({ body: event.target.value })}
        />
      </div>

      <div className={styles.field}>
        <div className={styles.labelRow}>
          <label className={styles.label} htmlFor={`${id}-links`}>Evidence links</label>
          <span className={styles.counter} id={`${id}-links-hint`}>
            https only, up to {limits.evidenceLinks}, separated by spaces or lines
          </span>
        </div>
        <textarea
          className={styles.textarea}
          id={`${id}-links`}
          rows={2}
          inputMode="url"
          spellCheck={false}
          value={draft.links}
          aria-describedby={`${id}-links-hint`}
          onChange={(event) => update({ links: event.target.value })}
        />
      </div>

      <div className={styles.field}>
        <div className={styles.labelRow}>
          <label className={styles.label} htmlFor={`${id}-disclosure`}>Disclosure (optional)</label>
          <span className={styles.counter} id={`${id}-disclosure-count`}>
            {codePoints(draft.disclosureText)} / {limits.disclosureCodePoints}
          </span>
        </div>
        <input
          className={styles.input}
          id={`${id}-disclosure`}
          type="text"
          value={draft.disclosureText}
          aria-describedby={`${id}-disclosure-count`}
          onChange={(event) => update({ disclosureText: event.target.value })}
        />
        <label className={styles.choice}>
          <input type="checkbox" checked={draft.discloseWallet} onChange={(event) => update({ discloseWallet: event.target.checked })} />
          Share the wallet I post with and whether it held this coin when Blast checked.
        </label>
      </div>

      {problems.length > 0 ? (
        <div className={styles.problems} role="alert">
          <ul>
            {problems.map((problem) => <li key={problem}>{problem}</li>)}
          </ul>
        </div>
      ) : null}

      <div className={styles.actions}>
        {signers.includes("privy") ? <PostButton signer="privy" label="Post with Privy" pending={pending} onPost={onPost} /> : null}
        {signers.includes("wallet") ? <PostButton signer="wallet" label="Post with wallet" pending={pending} onPost={onPost} /> : null}
      </div>
      <p className={styles.status} role="status" data-tone={pending === null ? result?.tone : undefined}>
        {pending === "privy"
          ? "Waiting for Privy and Blast…"
          : pending === "wallet"
            ? "Waiting for the wallet and Blast…"
            : result?.message}
      </p>
    </form>
  );
}
