"use client";

import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { useEffect, useId, useRef, useState } from "react";

import { isEnterSubmit } from "#web/lib/ime-enter.ts";
import { invalidateAfter } from "#web/lib/query/invalidate.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";

import type { SocialWhyCreated } from "@blast/core/web/contracts/whys.ts";
import { WHY_MAX_CODE_POINTS, validateWhy, whyLength } from "@blast/core/modules/social/whys/validate.ts";

import { useSocialViewer } from "../SignInGate";
import { whyPrompt } from "./post-model";
import { WHY_TEXT_MESSAGES, addWhy, addWhyFailureMessage } from "./why-client";
import styles from "./WhyComposer.module.css";

/** The counter turns to the warning colour past this many code points (the design's `.counter.near`). */
const NEAR = 250;

const signedOut = async () => null;

/**
 * "Add why" on the viewer's own named item inside its 24 hours (T-021; an
 * OA-13 addition: the canonical UI draws the why box only in the commit
 * dialog, §4, so this is that box on the card). Collapsed it is the one
 * button; open, the design's why box (label, counter, field, inline error)
 * with Cancel and Post. The shared rules (`validateWhy`) refuse a link or an
 * over-long text as it is typed; the server's refusal shows in the same
 * place. Enter posts (a why is one line); Escape closes and returns focus to
 * "Add why". A posted why replaces the box at once.
 */
export function WhyComposer({ entryId, kind, onPosted }: Readonly<{
  entryId: string;
  kind: string;
  onPosted: (why: SocialWhyCreated) => void;
}>) {
  const viewer = useSocialViewer();
  const [open, setOpen] = useState<"pointer" | "keyboard" | null>(null);
  const [text, setText] = useState("");
  // The why's write (OA-38): its pending state is the "Posting…" flag, so nothing can leave it stuck.
  // Posted, a why joins its sale's theses and its author's profile tabs: those reads are stale.
  const client = useAppQueryClient();
  const write = useMutation(
    {
      mutationFn: (whyText: string) => addWhy({ getAccessToken: viewer.getAccessToken ?? signedOut }, entryId, whyText),
      onSuccess: (result) => {
        if (result.status === "ok") void invalidateAfter(client, { kind: "why" });
      },
    },
    client,
  );
  const posting = write.isPending;
  const [refusal, setRefusal] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const reopenFocus = useRef(false);
  const id = useId();

  useEffect(() => {
    if (open) field.current?.focus();
    else if (reopenFocus.current) {
      reopenFocus.current = false;
      opener.current?.focus();
    }
  }, [open]);

  if (!open) {
    return (
      <button className={clsx("btn btn-quiet btn-sm", styles.add)} onClick={(event) => setOpen(event.detail > 0 ? "pointer" : "keyboard")} ref={opener} type="button">
        Add why
      </button>
    );
  }

  const checked = text.trim() === "" ? null : validateWhy(text);
  const textError = checked && !checked.ok ? WHY_TEXT_MESSAGES[checked.code] : null;
  const error = textError ?? refusal;
  const length = whyLength(text.normalize("NFC").trim());
  const canPost = checked?.ok === true && !posting;
  const hintId = `${id}-hint`;

  function close() {
    reopenFocus.current = true;
    setOpen(null);
    setText("");
    setRefusal(null);
  }

  async function post() {
    if (!checked?.ok || posting) return;
    setRefusal(null);
    const result = await write.mutateAsync(checked.text).catch(() => ({ status: "error" }) as const);
    if (result.status === "ok") onPosted(result.body);
    else setRefusal(addWhyFailureMessage(result));
  }

  return (
    <div className={clsx(styles.whybox, error && styles.err)} data-pointer-reveal={open === "pointer" || undefined} data-why-box="">
      <div className={styles.lbl}>
        <label htmlFor={`${id}-text`}>
          <b>{whyPrompt(kind)}</b>
        </label>
        <span aria-live="off" className={clsx(styles.counter, length > NEAR && styles.near)}>
          {length}/{WHY_MAX_CODE_POINTS}
        </span>
      </div>
      <textarea
        aria-describedby={hintId}
        aria-invalid={error ? true : undefined}
        disabled={posting}
        id={`${id}-text`}
        maxLength={WHY_MAX_CODE_POINTS * 4}
        onChange={(event) => {
          setText(event.target.value);
          setRefusal(null);
        }}
        onKeyDown={(event) => {
          if (isEnterSubmit(event)) {
            event.preventDefault();
            void post();
          } else if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
        placeholder="Add a note"
        ref={field}
        rows={2}
        value={text}
      />
      <span aria-live="polite" className={styles.hint} id={hintId}>
        {error}
      </span>
      <div className={styles.actions}>
        <button className="btn btn-quiet btn-sm" onClick={close} type="button">
          Cancel
        </button>
        <button className="btn btn-primary btn-sm" disabled={!canPost} onClick={() => void post()} type="button">
          {posting ? "Posting…" : "Post"}
        </button>
      </div>
    </div>
  );
}
