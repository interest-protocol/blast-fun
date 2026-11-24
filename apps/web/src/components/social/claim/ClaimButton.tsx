"use client";

import { useCallback, useRef } from "react";

import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import { useDevicePrefs } from "#web/components/blast-ui/device-prefs.ts";
import { dismissToast } from "#web/components/blast-ui/toast-actions.ts";
import { useToast, type ToastOptions } from "#web/components/blast-ui/Toasts.tsx";
import { EXPLORER_NAMES, explorerTransactionUrl } from "@blast/core/lib/explorer.ts";
import { claimButtonText, claimRefusalDescription, type ClaimPath, type ClaimTarget, type ClaimView } from "./claims.ts";
import { useClaimsController, type Claims } from "./use-claims.tsx";

import styles from "./ClaimButton.module.css";

/**
 * A claim's button (R3-63), wherever a sale's claim is pressed in place: the
 * sale page's side box, Portfolio's Presales and Vestings rows, "Your
 * presales". A centered indicator while it runs, `Claimed` once it
 * landed. The side box draws a refusal under it (`role="alert"`); a row
 * (`small`) has no room for one, so its host toasts it. Null when the path
 * cannot claim this kind (no button). With `keepVisible`, unavailable and
 * completed actions remain visible as disabled buttons.
 */
type ClaimButtonProps = Readonly<{
  claims: Claims;
  target: ClaimTarget;
  label: string;
  ariaLabel?: string;
  describedBy?: string;
  small?: boolean;
  disabled?: boolean;
  keepVisible?: boolean;
}>;

export function ClaimButton({ claims, target, keepVisible = false, ...props }: ClaimButtonProps) {
  const supported = claims.available && claims.supports(target.kind);
  if (!supported && !keepVisible) return null;
  const view = claims.view(target.key, target.vesting?.claimed, target.collection?.received);
  if (view.state === "done" && !keepVisible) {
    return <span className="num" data-claim-complete={target.kind}>{claimButtonText(view, props.label, target.kind)}</span>;
  }
  return <ClaimAction {...props} claims={claims} disabled={props.disabled || !supported} target={target} view={view} />;
}

function ClaimAction({
  claims,
  target,
  label,
  ariaLabel,
  describedBy,
  small = false,
  disabled = false,
  view,
}: Omit<ClaimButtonProps, "keepVisible"> & Readonly<{ view: ClaimView }>) {
  const busy = view.state === "claiming";
  const done = view.state === "done";
  const blocked = disabled || done;
  const inactive = busy || blocked;
  const progress = claimButtonText(view, label, target.kind);
  const progressLabel = ariaLabel ? `${progress} · ${ariaLabel}` : progress;
  return (
    <>
      <button
        aria-label={busy || done ? progressLabel : ariaLabel}
        aria-describedby={describedBy}
        aria-busy={busy ? true : undefined}
        aria-disabled={inactive ? true : undefined}
        className={small ? "btn btn-primary btn-sm" : "btn btn-primary btn-lg btn-block"}
        data-claim={done ? undefined : target.kind}
        data-claim-complete={done ? target.kind : undefined}
        disabled={blocked}
        onClick={() => {
          if (!inactive) claims.run(target);
        }}
        type="button"
      >
        <LoadingIndicator label={progressLabel} loading={busy}>{done ? progress : label}</LoadingIndicator>
      </button>
      {!small && view.state === "failed" ? (
        <p className={styles.refusal} data-claim-refusal={view.code} role="alert">{view.message}</p>
      ) : null}
    </>
  );
}

/**
 * The claims of one screen over `path`: after each answer `onSettled` (the
 * screen's own reads; the shell's path already invalidates the shared ones),
 * then the gate's toast for a claim that landed, with its explorer link, and
 * with `toastRefusals` the published refusal for one that did not.
 */
export function useToastedClaims(
  path: ClaimPath | undefined,
  options: Readonly<{ onSettled?: () => void; toastRefusals?: boolean; mobileTargetId?: (target: ClaimTarget) => string | undefined }> = {},
): Claims {
  const toast = useToast();
  const resultToasts = useRef(new Map<string, string>());
  const { explorer } = useDevicePrefs();
  const { onSettled, toastRefusals = false, mobileTargetId } = options;
  const settled = useCallback(
    (target: ClaimTarget, view: ClaimView, retry?: () => void) => {
      onSettled?.();
      const showResult = (title: string, result: ToastOptions) => {
        const previous = resultToasts.current.get(target.key);
        if (previous) dismissToast(previous);
        // A previous toast can still be exiting when a fast retry settles.
        const id = `claim:${target.key}:${crypto.randomUUID()}`;
        resultToasts.current.set(target.key, id);
        toast(title, { ...result, id, mobileTargetId: mobileTargetId?.(target) });
      };
      if (view.state === "failed" && toastRefusals) {
        const href = view.digest ? explorerTransactionUrl(explorer, view.digest) ?? undefined : undefined;
        showResult(view.digest || view.code === "claim_pending" ? "Claim awaiting confirmation" : view.code === "rejected" ? "Claim cancelled" : "Claim failed", {
          tone: "error",
          sub: view.digest ? "Check your transaction on Sui before claiming again." : claimRefusalDescription(view.code),
          href,
          link: `View on ${EXPLORER_NAMES[explorer]}`,
          action: retry ? { label: "Retry", onClick: retry } : undefined,
        });
      }
      if (view.state !== "done") return;
      const href = explorerTransactionUrl(explorer, view.digest) ?? undefined;
      showResult(target.done.title, { sub: target.done.sub, href, link: href === undefined ? undefined : `View on ${EXPLORER_NAMES[explorer]}` });
    },
    [explorer, onSettled, toast, toastRefusals, mobileTargetId],
  );
  return useClaimsController(path, settled);
}
