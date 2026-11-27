"use client";

import { useId, useRef, useState } from "react";

import { Button } from "#web/components/blast-ui/Button.tsx";
import { DiagnosticText } from "#web/components/blast-ui/DiagnosticText.tsx";
import { Sheet, SheetCta, SheetHeading } from "#web/components/blast-ui/Sheet.tsx";
import { publicErrorMessage } from "#web/lib/errors.ts";

import { UNLINK_FAILED, shortWallet } from "./settings-model";

type Props = Readonly<{
  address: string;
  callsign: string;
  deleteAccount: boolean;
  onClose(): void;
  onConfirm(): Promise<string | null>;
}>;

export function UnlinkWalletSheet({ address, callsign, deleteAccount, onClose, onConfirm }: Props) {
  const titleId = useId();
  const leadId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const committing = useRef(false);
  const [open, setOpen] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    if (!committing.current) setOpen(false);
  };

  async function confirm() {
    if (committing.current || !open) return;
    committing.current = true;
    setPending(true);
    setError(null);
    const failure = await Promise.resolve()
      .then(onConfirm)
      .catch((error) => publicErrorMessage(error, UNLINK_FAILED))
      .finally(() => {
        committing.current = false;
        setPending(false);
      });
    if (failure) setError(failure);
    else setOpen(false);
  }

  return (
    <Sheet describedBy={leadId} hasCta initialFocus={() => cancel.current} labelledBy={titleId} onClosed={onClose} onRequestClose={close} open={open}>
      <SheetHeading
        id={titleId}
        leadId={leadId}
        title={deleteAccount ? "Delete Blast account?" : "Unlink Slush wallet?"}
        lead={deleteAccount
          ? `Slush ${shortWallet(address)} is the only wallet on @${callsign}. Deleting the account hides its Blast profile and retires any Season Zero card. Your funds stay in Slush.`
          : `Remove Slush ${shortWallet(address)} from @${callsign}. You can then link it to another Blast account.`}
      />
      {error ? <p role="alert"><DiagnosticText message={error} /></p> : null}
      <SheetCta>
        <Button disabled={pending} onClick={close} ref={cancel} size="lg" variant="secondary">Cancel</Button>
        <Button
          loading={pending}
          loadingLabel={deleteAccount ? "Deleting Blast account" : "Unlinking Slush wallet"}
          onClick={() => void confirm()}
          size="lg"
          variant="danger"
        >
          {deleteAccount ? "Delete account and unlink" : "Unlink wallet"}
        </Button>
      </SheetCta>
    </Sheet>
  );
}
