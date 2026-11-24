"use client";
import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { Button } from "#web/components/blast-ui/Button.tsx";

import { useId, useState } from "react";
import { Sheet, SheetClose, SheetHeading } from "#web/components/blast-ui/Sheet.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import type { SocialPresaleDetail } from "@blast/core/web/contracts/presales.ts";
import { PresaleAmount } from "./PresaleContent";
import styles from "./FocusPanel.module.css";
import workspaceStyles from "../WorkspaceHost.module.css";

export function PresaleFocusDetails({ detail, pending, visible }: Readonly<{ detail: SocialPresaleDetail | null; pending: boolean; visible: boolean }>) {
  return <section className={styles.details} aria-label="Presale details">
    {pending ? <SkeletonText>Schedule, allocation and vesting</SkeletonText> : !detail ? <p>Presale details are unavailable.</p> : <>
      <PresaleDecisionFacts detail={detail} />
      <SaleDetails detail={detail} visible={visible} />
    </>}
  </section>;
}

function PresaleDecisionFacts({ detail }: Readonly<{ detail: SocialPresaleDetail }>) {
  const closing = presaleClose(detail.presale);
  return <dl className={styles.facts}>
    <div><dt>{closing.label}</dt><dd><PresaleTime at={closing.at} /></dd></div>
    <div><dt>Buyer allocation</dt><dd>{allocationText(detail.terms)}</dd></div>
    <div><dt>Vesting</dt><dd>{vestingText(detail.terms)}</dd></div>
  </dl>;
}

function SaleDetails({ detail, visible }: Readonly<{ detail: SocialPresaleDetail; visible: boolean }>) {
  const [open, setOpen] = useState(false);
  const title = useId();
  const { presale: sale, terms } = detail;
  const closing = presaleClose(sale);
  const close = () => setOpen(false);
  return <>
    <Button variant="secondary" size="sm"  type="button" aria-haspopup="dialog" aria-expanded={open && visible} onClick={() => setOpen(true)}>Sale details</Button>
    <Sheet className={workspaceStyles.tradeSheet} open={open && visible} onRequestClose={close} onClosed={close} labelledBy={title}>
      <SheetClose onClick={close} />
      <SheetHeading id={title} title="Sale details" />
      <dl className={styles.facts}>
        <div><dt>Opens</dt><dd><PresaleTime at={sale.start_ms} /></dd></div>
        <div><dt>{closing.label}</dt><dd><PresaleTime at={closing.at} /></dd></div>
        <div><dt>Buyer allocation</dt><dd>{allocationText(terms)}</dd></div>
        <div><dt>Total supply</dt><dd>{terms ? <PresaleAmount compact atoms={terms.supply.total} decimals={sale.sale_decimals} symbol={sale.symbol} label="Total supply" /> : "Unavailable"}</dd></div>
        <div><dt>Vesting</dt><dd>{vestingText(terms)}</dd></div>
      </dl>
      {terms?.buyer_vesting && <p>Vesting starts from your initial presale claim.</p>}
    </Sheet>
  </>;
}

function allocationText(terms: SocialPresaleDetail["terms"]) {
  return terms ? `${terms.supply.participants.bps / 100}%` : "Unavailable";
}

function presaleClose(sale: SocialPresaleDetail["presale"]) {
  if (sale.ended_ms != null) return { label: "Closed", at: sale.ended_ms };
  return { label: ["open", "pending"].includes(sale.phase) ? "Closes" : "Scheduled close", at: sale.end_ms };
}

function vestingText(terms: SocialPresaleDetail["terms"] | undefined) {
  if (!terms || terms.buyer_vesting === undefined) return "Unavailable";
  const vesting = terms.buyer_vesting;
  if (!vesting) return "None";
  return `${Number(vesting.cliff_ms) / 86_400_000} day cliff · ${Number(vesting.duration_ms) / 86_400_000} days from first claim`;
}

function PresaleTime({ at }: Readonly<{ at: number }>) {
  if (at <= 0) return <>Not scheduled</>;
  return <DateStamp at={at} />;
}
