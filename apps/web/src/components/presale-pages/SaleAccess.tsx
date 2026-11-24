"use client";

import type { MouseEvent, ReactNode } from "react";

import type { SocialPresaleDetail } from "@blast/core/web/contracts/presales.ts";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { DiagnosticText } from "#web/components/blast-ui/DiagnosticText.tsx";
import { DexIdentity } from "#web/components/blast-ui/DexIdentity.tsx";
import { SkeletonBox, SkeletonRegion } from "#web/components/blast-ui/Skeleton.tsx";
import { Ticker, TickerText } from "#web/components/blast-ui/Ticker.tsx";
import { useSignInGate } from "#web/components/social/SignInGate.tsx";
import { diagnosticMessage, publicErrorCopy } from "#web/lib/errors.ts";

import { cx } from "./cx";
import { DashIcon, InfoIcon, LockIcon, PeopleIcon, TickIcon } from "./icons";
import type { SaleAccess } from "./sale-access";
import { useSaleAccess } from "./use-sale-access";

function Mark({ kind }: Readonly<{ kind: SaleAccess["kind"] }>) {
  if (kind === "checking") return <SkeletonBox className={cx("access-mark")} round />;
  const icon = { listed: <TickIcon />, not_listed: <DashIcon />, signed_out: <LockIcon />, open: <PeopleIcon />, unknown: <InfoIcon /> }[kind];
  return <span aria-hidden="true" className={cx("access-mark")} data-kind={kind}>{icon}</span>;
}

function Status({ access }: Readonly<{ access: SaleAccess }>) {
  const [title, sub] = statusText(access);
  return (
    <div className={cx("access-status")}>
      <Mark kind={access.kind} />
      <span className={cx("access-who")}>
        <b>{title}</b>
        {access.kind === "checking" ? <SkeletonBox className={cx("access-sub-skeleton")} /> : sub ? <span>{sub}</span> : null}
      </span>
    </div>
  );
}

/** The status line's title and its muted second line (omitted when there is nothing to say). */
function statusText(access: SaleAccess): readonly [string, string | null] {
  switch (access.kind) {
    case "listed":
      return ["You’re on the whitelist", `Wallet ${access.wallet}`];
    case "not_listed":
      return ["You’re not on the whitelist", `Wallet ${access.wallet}`];
    case "signed_out":
      // Not "whitelist only": a sale may open to anyone later (#1082), which is unknown here until the sale opens.
      return ["Whitelist sale", access.wallets === null ? null : `${access.wallets.toLocaleString("en-US")} ${access.wallets === 1 ? "wallet" : "wallets"} on the list`];
    case "open":
      return ["Open to everyone", "No whitelist"];
    case "checking":
      return ["Checking the whitelist…", null];
    default:
      return ["Can’t check the whitelist", access.wallet === null ? null : `Wallet ${access.wallet}`];
  }
}

function Figure({ label, value, note, symbol }: Readonly<{ label: string; value: string; note: string | null; symbol: string }>) {
  return (
    <div className={cx("access-figure")}>
      <span>{label}</span>
      <b className="num">{value}</b>
      {note ? <span className="num"><TickerText symbols={[symbol]} text={note} /></span> : null}
    </div>
  );
}

function PublicOpening({ at, start }: Readonly<{ at: number; start: number }>) {
  return at <= start ? <>Anyone can buy when the sale opens.</> : <>Anyone can buy from <DateStamp at={at} label="public opening time" />.</>;
}

type Retry = Readonly<{ retry: () => void; retrying: boolean }>;

function Body({ access, detail }: Readonly<{ access: SaleAccess; detail: SocialPresaleDetail }>) {
  const sale = detail.presale;
  switch (access.kind) {
    case "listed":
      return <Figure label="You can buy up to" note={access.tokens} symbol={sale.symbol} value={access.cap} />;
    case "open":
      return access.range === null ? null : <Figure label="You can buy" note={access.tokens ? `Per wallet · ${access.tokens}` : "Per wallet"} symbol={sale.symbol} value={access.range} />;
    case "not_listed":
      return (
        <p className={cx("plain flush")}>
          {access.publicFrom === null ? (
            <>You can buy <Ticker symbol={sale.symbol} /> on <DexIdentity venue={sale.venue} /> once it trades.</>
          ) : (
            <PublicOpening at={access.publicFrom} start={sale.start_ms} />
          )}
        </p>
      );
    case "signed_out":
      return (
        <p className={cx("plain flush")}>
          {access.publicFrom === null ? "Sign in to see if you’re on the list and how much you can buy." : <>Sign in to see what you can buy. <PublicOpening at={access.publicFrom} start={sale.start_ms} /></>}
        </p>
      );
    case "checking":
      return (
        <div aria-hidden="true" className={cx("access-figure")}>
          <SkeletonBox className={cx("access-skeleton-label")} />
          <SkeletonBox className={cx("access-skeleton-hero")} />
          <SkeletonBox className={cx("access-skeleton-note")} />
        </div>
      );
    default:
      return (
        <p className={cx("plain flush")}>
          <DiagnosticText message={diagnosticMessage(publicErrorCopy(access.code, "We couldn’t reach the list. Nothing is wrong with your wallet."), { code: access.code })} />
        </p>
      );
  }
}

/**
 * The access card's content (approved 2026-11-20): the status line, then the
 * viewer's figure or the one sentence that explains it. The desktop Blast box
 * and the phone card above the bottom bar both draw it.
 */
export function SaleAccessContent({ access, detail, retry, retrying }: Readonly<{ access: SaleAccess; detail: SocialPresaleDetail }> & Retry): ReactNode {
  const content = <><Status access={access} /><Body access={access} detail={detail} /></>;
  if (access.kind === "checking") return <SkeletonRegion className={cx("access-checking")} label="Checking the whitelist">{content}</SkeletonRegion>;
  if (access.kind !== "unknown") return content;
  // The failure is announced whole (title, wallet, sentence, code); Try again sits outside it, so its loading state is not re-announced.
  return (
    <>
      <div className={cx("access-alert")} role="alert">{content}</div>
      <Button className={cx("access-retry")} loading={retrying} loadingLabel="Checking the whitelist" onClick={retry} size="sm">Try again</Button>
    </>
  );
}

/** "Sign in to check": the signed-out viewer's way to the answer (pink in the desktop box, where it is the one primary). */
export function SignInToCheck({ primary }: Readonly<{ primary: boolean }>) {
  const gate = useSignInGate();
  return (
    <Button
      className={cx(primary && "btn-block")}
      disabled={gate.sessionPending}
      onClick={(event: MouseEvent) => {
        gate.openSignIn(event);
        if (!event.defaultPrevented) window.location.assign(gate.signInHref);
      }}
      size={primary ? "lg" : "sm"}
      variant={primary ? "primary" : "secondary"}
    >
      Sign in to check
    </Button>
  );
}

/** The phone and tablet card in the page body, above the bottom bar (which keeps Notify me). */
export function SaleAccessCard({ detail }: Readonly<{ detail: SocialPresaleDetail }>) {
  const { access, retry, retrying } = useSaleAccess(detail);
  return (
    <section aria-label="Your access" className={cx("card access-card only-narrow")}>
      <SaleAccessContent access={access} detail={detail} retry={retry} retrying={retrying} />
      {access.kind === "signed_out" ? <SignInToCheck primary={false} /> : null}
    </section>
  );
}
