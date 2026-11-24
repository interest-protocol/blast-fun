"use client";

import clsx from "clsx";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { MahaloLogo, NightlyLogo, ScallopLogo, SlushLogo } from "#web/components/blast-ui/Icons.tsx";
import { Sheet, SheetClose, SheetHeading } from "#web/components/blast-ui/Sheet.tsx";

import styles from "./LinkWalletSheet.module.css";
import {
  LINK_COPY,
  LINK_WALLETS,
  walletMonogram,
  type LinkOutcome,
  type LinkWalletChoice,
  type LinkWalletId,
} from "./link-wallet-flow";

/**
 * "Link a Sui wallet" (FEATURE-MAP §14.3): a modal sheet over the page
 * (bottom sheet on phones) with Sui wallet choices. Choosing one
 * disables the others and shows "Sign in <wallet>" with a spinner while
 * `onPick` connects, signs and links; a cancel or a failure says what
 * happened and lets the person try again. A success closes the sheet, then
 * hands the outcome to `onLinked` (the page toasts and reads `me` again).
 *
 * It is the shared `Sheet` (OA-28 M2: base-ui's `Dialog`, the gate's
 * version 5 motion and pull-down, the layers' stacking, scroll lock and
 * focus return), mounted while the page is linking. Escape is heard on the
 * document, so it still closes the sheet while a wallet signs (the picked
 * button is disabled, and focus falls to `<body>`). Closed again while it
 * closes, it still leaves once and runs every close's callback (OA-31: a
 * wallet linked after Escape is still toasted; the gate's `scrim._closing`).
 */
export type LinkWalletSheetProps = Readonly<{
  onClose(): void;
  onPick(choice: LinkWalletChoice): Promise<LinkOutcome>;
  onLinked(outcome: Extract<LinkOutcome, { status: "linked" }>): void;
}>;

export function LinkWalletSheet({ onClose, onPick, onLinked }: LinkWalletSheetProps) {
  const titleId = useId();
  const [open, setOpen] = useState(true);
  // The closing motion's callbacks: null while open. Closing again joins them.
  const closing = useRef<(() => void)[] | null>(null);
  // They ran (the exit ended); a sheet replaced before then still runs them as it leaves.
  const delivered = useRef(false);
  const mounted = useRef(true);
  const [signing, setSigning] = useState<LinkWalletId | null>(null);
  const [message, setMessage] = useState<Readonly<{ tone: "status" | "error"; text: string }> | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Replaced by a fresh sheet while it was leaving (`useLinkWalletSession`): a wallet linked meanwhile is still heard.
      if (!delivered.current) for (const callback of closing.current ?? []) callback();
    };
  }, []);

  const close = useCallback((then?: () => void) => {
    if (closing.current) {
      // Already on its way out: one exit, every callback.
      if (then) closing.current.push(then);
      return;
    }
    closing.current = then ? [then] : [];
    setOpen(false);
  }, []);

  // The sheet is gone: the page unmounts it, then hears every close's callback.
  const closed = () => {
    delivered.current = true;
    const callbacks = closing.current ?? [];
    onClose();
    for (const callback of callbacks) callback();
  };

  const pick = async (choice: LinkWalletChoice) => {
    if (signing) return;
    setSigning(choice.id);
    setMessage(null);
    const outcome = await onPick(choice);
    if (!mounted.current) {
      if (outcome.status === "linked") onLinked(outcome);
      return;
    }
    if (outcome.status === "linked") {
      close(() => onLinked(outcome));
      return;
    }
    setSigning(null);
    setMessage({ tone: outcome.status === "cancelled" ? "status" : "error", text: outcome.message });
  };

  return (
    <Sheet labelledBy={titleId} onClosed={closed} onRequestClose={() => close()} open={open}>
      <SheetClose onClick={() => close()} />
      <SheetHeading id={titleId} lead={LINK_COPY.lead} title={LINK_COPY.title} />
      <div className={styles.wallets}>
        {LINK_WALLETS.map((choice) => (
          <button
            aria-busy={signing === choice.id || undefined}
            className={clsx("btn btn-line", styles.wallet)}
            disabled={signing !== null}
            key={choice.id}
            onClick={() => void pick(choice)}
            type="button"
          >
            {signing === choice.id ? (
              <>
                <span aria-hidden="true" className={styles.spin} />
                {LINK_COPY.signing(choice.name)}
              </>
            ) : (
              <>
                {choice.id === "slush" ? <SlushLogo /> : choice.id === "nightly" ? <NightlyLogo /> : choice.id === "scallop" ? <ScallopLogo /> : choice.id === "mahalo" ? <MahaloLogo /> : (
                  <span aria-hidden="true" className={styles.mono}>
                    {walletMonogram(choice.name)}
                  </span>
                )}
                {choice.name}
              </>
            )}
          </button>
        ))}
      </div>
      {message ? (
        <p className={styles.message} data-tone={message.tone} role={message.tone === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      ) : null}
    </Sheet>
  );
}

/**
 * The page's side of the link sheet: mounted while the page is linking.
 * Asked for again while it is still closing (the row under its fading scrim
 * takes presses), a fresh sheet takes its place at once and stays, as the
 * gate's `openLayer` replaces a layer on its way out; the leaving one's
 * `onClose` then changes nothing.
 *
 *     const link = useLinkWalletSession();
 *     <SettingsView onLinkWallet={link.open} … />
 *     {link.session !== null ? <LinkWalletSheet key={link.session} onClose={() => link.closed(link.session)} … /> : null}
 */
export function useLinkWalletSession(): Readonly<{ session: number | null; open: () => void; closed: (session: number | null) => void }> {
  const [session, setSession] = useState<number | null>(null);
  const next = useRef(0);
  const open = useCallback(() => {
    next.current += 1;
    setSession(next.current);
  }, []);
  const closed = useCallback((which: number | null) => setSession((current) => (current === which ? null : current)), []);
  return { session, open, closed };
}
