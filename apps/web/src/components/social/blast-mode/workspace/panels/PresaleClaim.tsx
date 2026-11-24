import Link from "next/link";
import { vestingPath } from "@blast/core/modules/vesting/model.ts";
import { claimableTokenText } from "@blast/core/modules/presale/presentation.ts";
import { claimDone } from "../../../claim/claim-projection";
import type {
  SocialPresaleDetail,
  SocialPresaleViewerEntry,
} from "@blast/core/web/contracts/presales.ts";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { groupedExact, exactAtoms } from "@blast/core/web/exact-amount.ts";
import { ClaimButton, useToastedClaims } from "#web/components/social/claim/ClaimButton.tsx";
import { saleClaimTarget } from "../../../claim/claims";
import type { Claims } from "../../../claim/use-claims";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { QuoteMark } from "#web/components/social/coin-home/glyphs.tsx";
import { PresaleAmount, PresaleReadProblem } from "./PresaleContent";
import type { PresalePanelProps } from "./PresalePanel";
import styles from "./PresalePanel.module.css";

export function PresaleClaim({
  detail,
  entry,
  status,
  retry,
  actions,
  visible,
}: Readonly<{
  detail: SocialPresaleDetail;
  entry: SocialPresaleViewerEntry | null;
  status: "ready" | "pending" | "error";
  retry: () => void;
  actions: PresalePanelProps["actions"];
  visible: boolean;
}>) {
  const claims = useToastedClaims(visible ? actions.claimPath : undefined);
  const sale = detail.presale;
  if (status === "error")
    return <PresaleReadProblem name="Your position" retry={retry} />;
  if (status === "pending")
    return (
      <div role="status" aria-label="Loading your presale position">
        <SkeletonText>Your commitment and claim status</SkeletonText>
      </div>
    );
  if (!entry?.mine) return null;
  const mine = entry.mine;
  return (
    <section className={styles.position} aria-label="Your presale position">
      <div className={styles.positionHead}>
        <h3>Your position</h3>
        <span>
          <QuoteMark symbol={sale.quote_symbol} />
          Committed{" "}
          <b>
            <PresaleAmount
              atoms={mine.commitment_atoms}
              decimals={sale.quote_decimals}
              symbol={sale.quote_symbol}
              label="your commitment"
            />
          </b>
        </span>
      </div>
      <PositionAction
        sale={sale}
        mine={mine}
        buyerVesting={!!detail.terms?.buyer_vesting || !!mine.buyer_vesting}
        claims={claims}
        visible={visible}
      />
    </section>
  );
}

function PositionAction({
  sale,
  mine,
  buyerVesting,
  claims,
  visible,
}: Readonly<{
  sale: SocialPresaleDetail["presale"];
  mine: NonNullable<SocialPresaleViewerEntry["mine"]>;
  buyerVesting: boolean;
  claims: Claims;
  visible: boolean;
}>) {
  const cancelled = sale.phase === "cancelled";
  const claimable =
    cancelled || (sale.phase === "trading" && mine.claimable_tokens !== "0");
  const kind = cancelled ? "claim_refund" : "claim_tokens";
  const amount = exactAtoms(
    cancelled ? mine.commitment_atoms : mine.refund_atoms,
    sale.quote_decimals,
  );
  const refund = amount
    ? `${groupedExact(amount, sale.quote_decimals)} ${sale.quote_symbol}`
    : sale.quote_symbol;
  if (sale.phase === "trading" && buyerVesting) {
    return <BuyerPosition sale={sale} mine={mine} claims={claims} visible={visible} refund={refund} />;
  }
  if (mine.claimed) return <p>Already claimed.</p>;
  if (!claimable) return <p>Claims open once trading starts or the sale is cancelled.</p>;
  return (
    <>
      <p>{cancelled ? "Everything you committed comes back in the commitment asset." : "Claim your tokens and any presale refund together."}</p>
      <ClaimButton
        claims={claims}
        keepVisible
        disabled={!visible}
        label={cancelled ? "Claim refund" : `Claim ${sale.symbol}`}
        target={saleClaimTarget(kind, sale, refund)}
      />
      {!claims.available && <p>Claiming unavailable.</p>}
    </>
  );
}

function BuyerPosition({ sale, mine, claims, visible, refund }: Readonly<{
  sale: SocialPresaleDetail["presale"];
  mine: NonNullable<SocialPresaleViewerEntry["mine"]>;
  claims: Claims;
  visible: boolean;
  refund: string;
}>) {
  const vesting = mine.buyer_vesting;
  const mark = <CoinMark coin={{ key: sale.sale_token, coinType: sale.sale_token, symbol: sale.symbol, iconUrl: sale.icon_url || null, round: false }} size={16} />;
  const amount = (atoms: string | null | undefined, label: string) => (
    <>{exactAtoms(atoms, sale.sale_decimals) ? mark : null}<PresaleAmount atoms={atoms} decimals={sale.sale_decimals} symbol={sale.symbol} label={label} /></>
  );
  if (vesting) return (
    <>
      <dl className={styles.positionTiles}>
        <div><dt>Claimed to date</dt><dd>{amount(vesting.claimed, "Your buyer tokens claimed to date")}</dd></div>
        <div><dt>Unclaimed</dt><dd>{amount(vesting.remaining, "Your remaining buyer vesting tokens")}</dd></div>
      </dl>
      <p className={styles.note}>Blast wallet</p>
      <Link className={`btn btn-primary ${styles.positionAction}`} href={vestingPath(vesting.schedule_id)}>{vesting.remaining === "0" ? "View completed schedule" : "View schedule and claim"}</Link>
    </>
  );
  if (mine.claim_wallet_participated === false) return <p>This presale was backed by another linked wallet. Use that wallet to view and claim its vesting.</p>;
  if ((mine.claim_wallet_claimed ?? mine.claimed) || claimDone(claims, sale.presale_id, "claim_tokens")) return <p role="status">Your initial presale claim is confirmed. Your vesting balances are updating.</p>;
  const canStart = mine.claimable_tokens != null && BigInt(mine.claimable_tokens) > BigInt(0);
  const claimAmount = claimableTokenText(sale, mine);
  return (
    <>
      <p>Initial claim starts vesting. Refunds go to your wallet.</p>
      <dl className={styles.positionTiles}>
        <div><dt>Claimed to date</dt><dd>{mine.claim_wallet_participated || canStart ? amount("0", "Your buyer tokens claimed to date") : "Unavailable"}</dd></div>
        <div><dt>Awaiting vesting</dt><dd>{amount(mine.claimable_tokens, "Your buyer tokens awaiting vesting")}</dd></div>
      </dl>
      {canStart ? <>
        <ClaimButton claims={claims} keepVisible disabled={!visible} label="Start your vesting" target={saleClaimTarget("claim_tokens", sale, refund, claimAmount, true)} />
        {!claims.available && <p>Claiming unavailable.</p>}
      </> : null}
    </>
  );
}
