"use client";

import { useId, useRef } from "react";

import { Button } from "#web/components/blast-ui/Button.tsx";
import { Sheet, SheetCta, SheetHeading } from "#web/components/blast-ui/Sheet.tsx";

import { impactTone } from "../trades/trade-quote-view.ts";

import type { Loss } from "./bridge-safety.ts";
import styles from "./bridge.module.css";

/** Rounded up to one decimal: the loss never reads smaller than it is. */
function percent(bps: number): string {
  return `${Math.ceil(bps / 10) / 10}%`;
}

function lossCopy(loss: Loss): Readonly<{ title: string; lead: string; className?: string }> {
  if (loss.kind === "unknown") {
    return { title: "Loss unknown", lead: "Blast can’t price this coin, so we can’t work out the loss. Go for it?" };
  }
  return {
    title: `You might lose ${percent(loss.bps)}`,
    lead: loss.sendMore ? "Send more to lose less. Sure you want to go for it?" : "Sure you want to go for it?",
    className: impactTone(loss.bps) === "down" ? styles.lossDown : styles.lossWarn,
  };
}

/** The second press for a send that loses more than 3% at worst, or whose loss Blast can't work out. */
export function BridgeLossSheet({ loss, open, onBack, onSend, onClosed }: Readonly<{
  loss: Loss;
  open: boolean;
  onBack: () => void;
  onSend: () => void;
  onClosed: () => void;
}>) {
  const titleId = useId();
  const leadId = useId();
  const back = useRef<HTMLButtonElement>(null);
  const { title, lead, className } = lossCopy(loss);
  return (
    <Sheet className={className} describedBy={leadId} hasCta initialFocus={() => back.current} labelledBy={titleId} onClosed={onClosed} onRequestClose={onBack} open={open}>
      <SheetHeading id={titleId} lead={lead} leadId={leadId} title={title} />
      <SheetCta>
        <Button onClick={onBack} ref={back} size="lg" variant="secondary">Back</Button>
        <Button onClick={onSend} size="lg" variant="primary">Send</Button>
      </SheetCta>
    </Sheet>
  );
}
