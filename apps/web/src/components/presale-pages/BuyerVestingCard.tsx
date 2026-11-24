"use client";

import { useQuery } from "@tanstack/react-query";

import { vestingDurationText } from "@blast/core/web/contracts/vesting.ts";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { TokenAmount } from "#web/components/vesting/DetailValues.tsx";
import { presaleDetailQuery } from "#web/components/social/queries.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { SocialPresaleDetail } from "@blast/core/web/contracts/presales.ts";

import { cx } from "./cx";

const ZERO_ATOMS = 0n;

/** Always present (the Sale board's Buyer vesting card): configured timing and actual escrow balances have separate meanings. */
export function BuyerVestingCard({ detail }: Readonly<{ detail: SocialPresaleDetail }>) {
  const client = useAppQueryClient();
  const query = useQuery({ ...presaleDetailQuery(detail.presale.presale_id), enabled: false }, client);
  const terms = detail.terms?.buyer_vesting;
  const totals = detail.buyer_vesting;
  const pending = query.isFetching && (terms === undefined || totals === undefined);
  return (
    <section aria-labelledby={`bvest-${detail.presale.presale_id.slice(-6)}`} className={cx("card sale-card")}>
      <div className={cx("sec-title")}><h2 id={`bvest-${detail.presale.presale_id.slice(-6)}`}>Buyer vesting</h2><span>{terms ? "Starts when each buyer claims" : terms === null ? "Tokens paid in full at claim" : ""}</span></div>
      {pending ? <p aria-busy="true" aria-label="Loading buyer vesting" role="status"><SkeletonText>Buyer schedule and balances</SkeletonText></p> : null}
      <BuyerTiming terms={terms} pending={pending} />
      <BuyerBalances detail={detail} pending={pending} />
      {query.isError ? <p className={cx("plain")} role="alert">Couldn’t refresh buyer vesting.{totals ? " Showing the last indexed balances." : " Try again in a moment."}</p> : null}
      {(query.isError || !pending && (terms === undefined || terms !== null && !totals)) ? <Button className={cx("row-retry")} onClick={() => void query.refetch()} size="sm">Try again</Button> : null}
    </section>
  );
}

function BuyerTiming({ terms, pending }: Readonly<{ terms: NonNullable<SocialPresaleDetail["terms"]>["buyer_vesting"]; pending: boolean }>) {
  if (terms === undefined) return pending ? null : <p className={cx("plain")} role="status">The buyer schedule is unavailable.</p>;
  if (terms === null) return null;
  return <>
    <dl className={cx("kv")}>
      <div><dt>Fully vested after</dt><dd className="num">{vestingDurationText(Number(terms.duration_ms))}</dd></div>
      <div><dt>Cliff</dt><dd className="num">{terms.cliff_ms === "0" ? "None" : vestingDurationText(Number(terms.cliff_ms))}</dd></div>
      <div><dt>Unlocks</dt><dd>Linear from your claim</dd></div>
    </dl>
    {terms.cliff_ms !== "0" ? <p className={cx("plain")}>Accrued tokens become claimable at the cliff.</p> : null}
  </>;
}

function BuyerBalances({ detail, pending }: Readonly<{ detail: SocialPresaleDetail; pending: boolean }>) {
  const terms = detail.terms?.buyer_vesting;
  const totals = detail.buyer_vesting;
  if (!totals) return terms && !pending ? <p className={cx("plain")} role="status">Buyer balances are unavailable.</p> : null;
  if (!terms && totals.schedules === 0) return null;
  const outstanding = terms && detail.terms && detail.presale.phase === "trading"
    ? BigInt(detail.terms.supply.participants.amount) - BigInt(totals.total)
    : ZERO_ATOMS;
  const amount = (value: string, label: string) => <TokenAmount decimals={detail.presale.sale_decimals} label={label} symbol={detail.presale.symbol} value={value} />;
  return <>
    <dl className={cx("kv")}>
      <div><dt>In buyer schedules</dt><dd className="num">{amount(totals.total, "Total tokens in buyer schedules")}</dd></div>
      <div><dt>Released to buyers</dt><dd className="num">{amount(totals.claimed, "Total tokens released to buyers")}</dd></div>
      <div><dt>Unclaimed</dt><dd className="num">{amount(totals.remaining, "Total tokens remaining in buyer vesting")}</dd></div>
    </dl>
    <p className={cx("plain")}>{totals.schedules.toLocaleString("en-US")} buyer {totals.schedules === 1 ? "schedule" : "schedules"} started.{outstanding > ZERO_ATOMS ? <> Another {amount(outstanding.toString(), "Buyer tokens awaiting initial claim")} awaits initial presale claims.</> : null}</p>
  </>;
}
