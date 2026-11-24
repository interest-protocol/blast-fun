"use client";

import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { coinPagePath } from "@blast/core/modules/launchpad-coin/page-key.ts";
import { watchClaimSettlement } from "#web/components/social/claim/claim-settlement.ts";
import { createQuoteOf } from "@blast/core/web/contracts/create.ts";
import { NO_VALUE, shortAddress as shortId } from "@blast/core/web/format.ts";
import Link from "next/link";
import { useEffect, useEffectEvent, useMemo, useState, type ReactNode } from "react";

import type { HolderPayout, PendingCreatorClaim, Share, WalletLaunchReward } from "#web/modules/launchpad-contract/browser-rewards.ts";
import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";

import { Button } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { ClaimButton } from "#web/components/social/claim/ClaimButton.tsx";

import { browserMarketDependencies } from "../../launchpad/blast-infra-browser";
import { shiftDecimal } from "../../launchpad/coin/coin-format";
import { describeReason } from "../../launchpad/coin/coin-view";
import { LIFECYCLE_LABELS, quoteSymbol } from "../../launchpad/discovery/discovery-model";
import { creatorCapsClaimTarget, launchClaimTarget, type ClaimTarget } from "../claim/claims";
import type { Claims } from "../claim/use-claims";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import styles from "../creator-earnings/CreatorEarnings.module.css";
import { earningAmount } from "../creator-earnings/earning-amount";
import { readAccountCreatorClaimsPage, readHolderPayoutsPage, readLaunchFeesPage, readWalletCreatorClaimsPage } from "./launch-rewards-client";
import own from "./LaunchRewards.module.css";
import { CreatorRightsSkeleton, LaunchRewardsSkeleton } from "./LaunchRewardsSkeleton";
import { useWalletPages, type WalletPages } from "./use-wallet-pages";

/** A coin type's last segment, the symbol a payout names its coin by. */
function typeName(coinType: string): string {
  return coinType.split("::").at(-1) ?? coinType;
}

/** Atomic `atoms` in whole units, never a positive amount shown as zero. */
function amount(atoms: bigint, decimals: number | null, hidden: boolean): string {
  if (hidden) return "••••";
  return decimals === null ? NO_VALUE : earningAmount(shiftDecimal(atoms.toString(), -decimals));
}

function Pair({ meme, quote, row, hidden }: Readonly<{ meme: bigint; quote: bigint; row: Units; hidden: boolean }>) {
  return (
    <span className={styles.amounts}>
      <span className="num">
        <span className={styles.quantity}>{amount(meme, row.memeDecimals, hidden)}</span> <span className={styles.symbol}>{row.memeSymbol}</span>
      </span>
      <span className="num">
        <span className={styles.quantity}>{amount(quote, row.quoteDecimals, hidden)}</span> <span className={styles.symbol}>{row.quoteSymbol}</span>
      </span>
    </span>
  );
}

type Units = Readonly<{ memeSymbol: string; memeDecimals: number | null; quoteSymbol: string; quoteDecimals: number | null }>;

function unitsOf(row: Readonly<{ coin: string; quote: string; memeDecimals: number | null; quoteDecimals: number | null }> & Partial<{ symbol: string | null }>): Units {
  return { memeSymbol: row.symbol ?? typeName(row.coin), memeDecimals: row.memeDecimals, quoteSymbol: quoteSymbol(row.quote), quoteDecimals: row.quoteDecimals ?? createQuoteOf(row.quote)?.decimals ?? null };
}

/** The words for a share's three figures, the same on the coin page's fees. */
const FIGURES = { accrued: "Earned", claimed: "Claimed", outstanding: "Unclaimed" } as const;

/**
 * A ledger's (or a launch's creator rights') claim: the shared claim button, and under it why a
 * claim did not go through, unless the host's toast is the one place a refusal is said
 * (`inlineRefusal` false).
 */
function LedgerClaim({
  claims,
  target,
  ariaLabel,
  label = "Claim",
  inlineRefusal = true,
}: Readonly<{ claims: Claims; target: ClaimTarget; ariaLabel: string; label?: string; inlineRefusal?: boolean }>) {
  const view = claims.view(target.key, undefined, target.collection?.received);
  return (
    <div className={styles.control}>
      <div aria-live="polite">
        <ClaimButton ariaLabel={ariaLabel} claims={claims} label={label} small target={target} />
      </div>
      {inlineRefusal && view.state === "failed" ? (
        <p className={styles.refusal} role="alert">
          {view.message}
        </p>
      ) : null}
    </div>
  );
}

/** One ledger's creator share: earned, claimed and unclaimed, in both coins, and its claim when the reader can make it. */
function Ledger({
  label,
  share,
  row,
  hidden,
  claim,
}: Readonly<{ label: string; share: Readonly<{ meme: Share; quote: Share }>; row: Units; hidden: boolean; claim?: ReactNode }>) {
  return (
    <div className={styles.action}>
      <span className={styles.label}>{label}</span>
      <div className={styles.value}>
        <dl className={own.ledger}>
          {(["accrued", "claimed", "outstanding"] as const).map((figure) => (
            <div key={figure}>
              <dt>{FIGURES[figure]}</dt>
              <dd>
                <Pair meme={share.meme[figure]} quote={share.quote[figure]} row={row} hidden={hidden} />
              </dd>
            </div>
          ))}
        </dl>
      </div>
      {claim}
    </div>
  );
}

/**
 * Whom a launch row's claims are for: the shared claim path and the wallet it signs with. A
 * ledger is claimable from here when its row is that wallet's, the wallet holds the launch's cap
 * (a launch whose caps were never claimed has none to claim with), and something is unclaimed.
 */
type LaunchClaiming = Readonly<{ claims: Claims; wallet: string }> | null;

function ledgerClaim(claiming: LaunchClaiming, row: WalletLaunchReward, share: Readonly<{ meme: Share; quote: Share }>, vault: boolean, units: Units): ReactNode {
  if (claiming === null || row.entitledBy !== "curve_fee_cap" || (share.meme.outstanding === 0n && share.quote.outstanding === 0n)) return null;
  const target = launchClaimTarget({ launchId: row.launchId, name: row.name ?? units.memeSymbol }, { vault, claimed: `${share.meme.claimed}:${share.quote.claimed}` });
  const ledger = vault ? "migration vault" : "bonding curve";
  return <LedgerClaim claims={claiming.claims} target={target} ariaLabel={`Claim ${units.memeSymbol} creator fees from the ${ledger}`} />;
}

function LaunchFee({ row, hidden, claiming }: Readonly<{ row: WalletLaunchReward; hidden: boolean; claiming: LaunchClaiming }>) {
  const units = unitsOf(row);
  return (
    <div className={styles.earning}>
      <Link className={styles.name} href={coinPagePath(row.coin)}>
        <CoinMark coin={{ key: row.launchId, iconUrl: row.iconUrl ?? "", round: false, symbol: units.memeSymbol }} size={40} />
        <span>
          <b>{row.name ?? "Unnamed coin"}</b>
          <span>
            {units.memeSymbol} · {LIFECYCLE_LABELS[row.lifecycle]}
          </span>
        </span>
      </Link>
      <div className={styles.rows}>
        <Ledger
          label={row.vault ? "Bonding curve, until migration" : "Bonding curve"}
          share={row.curve}
          row={units}
          hidden={hidden}
          claim={ledgerClaim(claiming, row, row.curve, false, units)}
        />
        {row.vault ? (
          <Ledger
            label="Migration vault, since migration"
            share={row.vault}
            row={units}
            hidden={hidden}
            claim={ledgerClaim(claiming, row, row.vault, true, units)}
          />
        ) : null}
      </div>
    </div>
  );
}

function Payout({ payout, hidden }: Readonly<{ payout: HolderPayout; hidden: boolean }>) {
  const units = unitsOf(payout);
  return (
    <div className={styles.earning}>
      <Link className={styles.name} href={coinPagePath(payout.coin)}>
        <CoinMark coin={{ key: payout.launchId, iconUrl: "", round: false, symbol: units.memeSymbol }} size={40} />
        <span>
          <b>{units.memeSymbol}</b>
          <span>
            Round {payout.round.toString()} · <DateStamp at={payout.paidAtMs} label="payout time" />
          </span>
        </span>
      </Link>
      <div className={styles.rows}>
        <div className={styles.action}>
          <span className={styles.label}>Received</span>
          <div className={styles.value}>
            <Pair meme={payout.memeAmount} quote={payout.quoteAmount} row={units} hidden={hidden} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** A wallet's list in its honest state: skeleton, rows, empty after a read, or a retry. */
function List<Row>({
  pages,
  subject,
  errorTitle,
  skeleton,
  empty,
  more,
  retry,
  children,
}: Readonly<{
  pages: WalletPages<Row>;
  subject: string;
  errorTitle?: string;
  /** The pending row's shape, and the read's name for its status label. */
  skeleton: Readonly<{ label: string; line: string; figures: readonly string[] }>;
  empty: Readonly<{ title: string; hint: string }>;
  more: () => void;
  retry: () => void;
  children: (row: Row) => ReactNode;
}>) {
  if (pages.status === "loading") return <LaunchRewardsSkeleton {...skeleton} />;
  if (pages.status === "error") {
    return (
      <EmptyState action={<Button onClick={retry}>Try again</Button>} role="alert" title={errorTitle ?? `${subject} could not load`}>
        {errorTitle ? null : <>Nothing changed: {describeReason(pages.failed ?? "unreachable")}. Try again in a moment.</>}
      </EmptyState>
    );
  }
  return (
    <>
      {pages.rows.map(children)}
      {pages.rows.length === 0 && pages.next === null ? <EmptyState title={empty.title}>{empty.hint}</EmptyState> : null}
      {pages.failed ? (
        <p className={styles.note} role="alert">
          More could not be loaded: {describeReason(pages.failed)}. Try again.
        </p>
      ) : null}
      {/* The busy Load more names the read; its pending row stays silent. */}
      {pages.loadingMore ? <LaunchRewardsSkeleton {...skeleton} silent /> : null}
      {pages.next ? (
        <Button loading={pages.loadingMore} loadingLabel={`Loading more ${subject.toLowerCase()}`} onClick={more}>
          Load more
        </Button>
      ) : null}
    </>
  );
}

/** Each launchpad list's words: its heading, what it is, its pending shape and its empty state. */
const LISTS = {
  fees: {
    title: "Launchpad creator fees",
    note: "Launch a coin to earn trading fees.",
    skeleton: { label: "Loading launchpad creator fees", line: "Bonding curve", figures: Object.values(FIGURES) },
    empty: { title: "No creator fees yet", hint: "" },
  },
  rights: {
    title: "Launchpad creator rights",
    note: "Claim a launch to move its creator fees and metadata to your Blast wallet.",
    loading: "Loading launchpad creator rights",
    loadingMore: "Loading more launchpad creator rights",
  },
  payouts: {
    title: "Launchpad holder rewards",
    note: "Hold eligible graduated coins to earn rewards.",
    skeleton: { label: "Loading launchpad holder rewards", line: "Received", figures: [] },
    empty: { title: "No holder rewards yet", hint: "" },
  },
} as const;

/** A list's section: its heading (naming the wallet when there are several) and note, then the list. */
function Frame({ id, list, wallet, children }: Readonly<{ id: string; list: keyof typeof LISTS; wallet: string | null; children: ReactNode }>) {
  const { title, note } = LISTS[list];
  return (
    <section aria-labelledby={id} className={styles.section}>
      <div className={styles.header}>
        <h3 id={id}>
          {title}
          {wallet ? (
            <>
              <span aria-hidden="true"> · {shortId(wallet)}</span>
              <span className="sr-only">, wallet {wallet}</span>
            </>
          ) : null}
        </h3>
      </div>
      <p className={styles.note}>{note}</p>
      {children}
    </section>
  );
}

function answeredClaims(claiming: LaunchClaiming, rows: readonly WalletLaunchReward[]): string {
  if (claiming === null) return "";
  return rows.flatMap((row) => [
    [false, row.curve] as const,
    ...(row.vault ? [[true, row.vault] as const] : []),
  ].map(([vault, share]) => {
    const target = launchClaimTarget({ launchId: row.launchId, name: row.name ?? typeName(row.coin) }, { vault, claimed: `${share.meme.claimed}:${share.quote.claimed}` });
    return `${target.key}=${claiming.claims.view(target.key, undefined, target.collection?.received).state}`;
  })).filter((entry) => entry.endsWith("=done") || entry.endsWith("=failed")).join("|");
}

function WalletRewards({
  address,
  heading,
  dependencies,
  active,
  hidden,
  claiming,
  refreshOn = "",
  rightsAwaitingFees = [],
}: Readonly<{
  address: string;
  heading: boolean;
  dependencies: MarketDataDependencies;
  active: boolean;
  hidden: boolean;
  claiming: LaunchClaiming;
  /** Answered creator-rights claims of this wallet: once their caps are indexed here, their fees become this list's rows. */
  refreshOn?: string;
  rightsAwaitingFees?: readonly string[];
}>) {
  const fees = useWalletPages(readLaunchFeesPage, (row) => row.launchId, address, dependencies, active);
  const payouts = useWalletPages(readHolderPayoutsPage, (row) => row.position, address, dependencies, active);
  const wallet = heading ? address : null;
  const claimsAnswered = answeredClaims(claiming, fees.state.rows);
  const answered = [claimsAnswered, refreshOn].filter(Boolean).join("#");
  const missingFees = rightsAwaitingFees.filter((launchId) => !fees.state.rows.some((row) => row.launchId === launchId && row.entitledBy === "curve_fee_cap")).join("|");
  const settling = [claimsAnswered.split("|").filter((entry) => entry.endsWith("=done")).join("|"), missingFees].filter(Boolean).join("#");
  const refresh = useEffectEvent(() => fees.refresh());
  useEffect(() => {
    if (!answered) return undefined;
    refresh();
  }, [answered]);
  useEffect(() => settling ? watchClaimSettlement(refresh) : undefined, [settling]);
  return (
    <>
      <Frame id={`${address}-launch-fees`} list="fees" wallet={wallet}>
        <List pages={fees.state} subject={LISTS.fees.title} skeleton={LISTS.fees.skeleton} empty={LISTS.fees.empty} more={fees.more} retry={fees.retry}>
          {(row) => <LaunchFee key={row.launchId} row={row} hidden={hidden} claiming={claiming} />}
        </List>
      </Frame>
      <Frame id={`${address}-launch-payouts`} list="payouts" wallet={wallet}>
        <List
          pages={payouts.state}
          subject={LISTS.payouts.title}
          errorTitle="Couldn’t load holder rewards"
          skeleton={LISTS.payouts.skeleton}
          empty={LISTS.payouts.empty}
          more={payouts.more}
          retry={payouts.retry}
        >
          {(payout) => <Payout key={payout.position} payout={payout} hidden={hidden} />}
        </List>
      </Frame>
    </>
  );
}

/** Whether the account's creator commitment (LP-16) is known yet, for its pending creator claims. */
export type CreatorAccountRead =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "ready"; commitment: string }>
  | Readonly<{ status: "failed"; retry: () => void }>;

/** Whether the Blast wallet (`/me/wallet`) is known yet; a ready null address is an account without one. */
export type CreatorWalletRead =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "ready"; address: string | null }>
  | Readonly<{ status: "failed"; retry: () => void }>;

/** One launch whose creator rights the reader can claim: its identity, and the claim. */
function CreatorRight({ row, claims }: Readonly<{ row: PendingCreatorClaim; claims: Claims | null }>) {
  const symbol = row.symbol ?? typeName(row.coin);
  const target = creatorCapsClaimTarget({ launchId: row.launchId, name: row.name ?? symbol });
  return (
    <div className={styles.earning}>
      <Link className={styles.name} href={coinPagePath(row.coin)}>
        <CoinMark coin={{ key: row.launchId, iconUrl: row.iconUrl ?? "", round: false, symbol }} size={40} />
        <span>
          <b>{row.name ?? "Unnamed coin"}</b>
          <span>
            {symbol} · {LIFECYCLE_LABELS[row.lifecycle]}
          </span>
        </span>
      </Link>
      <div className={styles.rows}>
        <div className={styles.action}>
          <span className={styles.label}>Creator rights</span>
          {/* The host's toast says a refusal, once (Portfolio toasts every claim's). */}
          {claims ? <LedgerClaim claims={claims} target={target} label="Claim rights" ariaLabel={`Claim ${symbol} creator rights`} inlineRefusal={false} /> : null}
        </div>
      </div>
    </div>
  );
}

/** The creator-rights claims of `listed` launches that have answered, as one value that changes when another answers. */
function answeredRights(claims: Claims | null, listed: readonly string[]): string {
  if (claims === null) return "";
  return listed
    .map((launchId) => `creator-caps:${launchId}`)
    .map((key) => `${key}=${claims.view(key).state}`)
    .filter((entry) => entry.endsWith("=done") || entry.endsWith("=failed"))
    .join("|");
}

type RightsList = Readonly<{ state: WalletPages<PendingCreatorClaim>; retry: () => void }>;

/** Where the creator-rights reads stand together: the first failure, whether any is pending, paging, and one retry for every failed read. */
function rightsReads(account: CreatorAccountRead, wallet: CreatorWalletRead, lists: readonly RightsList[]) {
  const recipientFailed = account.status === "failed" || wallet.status === "failed";
  return {
    failure: recipientFailed ? "unreachable" : (lists.find((list) => list.state.status === "error")?.state.failed ?? null),
    pending: account.status === "loading" || wallet.status === "loading" || lists.some((list) => list.state.status === "loading"),
    moreFailure: lists.find((list) => list.state.status === "ready" && list.state.failed)?.state.failed ?? null,
    loadingMore: lists.some((list) => list.state.loadingMore),
    more: lists.some((list) => list.state.next !== null),
    retry: () => {
      if (account.status === "failed") account.retry();
      if (wallet.status === "failed") wallet.retry();
      lists.filter((list) => list.state.status === "error").forEach((list) => list.retry());
    },
  };
}

/**
 * The launches whose creator rights the reader can still claim (LP-17), from blast-infra's
 * `/v1/creator-claims` for the Blast wallet (`recipient=`) and for the account's commitment
 * (`account=`): the two recipients LP-16 lets this reader claim as, both into the Blast wallet.
 * Another linked wallet's launches are not offered here. While any read is pending and nothing
 * is listed, the section shows a pending row; a failed read (the wallet's, the commitment's or a
 * list's) offers a retry; only when every read answered empty is there no section. Rows keep the
 * order they arrived in, so a later page never lands above rows already shown. After a
 * claim answers, both lists and the Blast wallet's fees read again until
 * blast-infra shows where the caps went; the client never moves a row on its own.
 */
type CreatorRightsInput = Readonly<{
  wallet: CreatorWalletRead;
  account: CreatorAccountRead;
  dependencies: MarketDataDependencies;
  active: boolean;
  claims: Claims | null;
}>;

function useCreatorRightsReads({ wallet, account, dependencies, active, claims }: CreatorRightsInput) {
  const commitment = account.status === "ready" ? account.commitment : null;
  const address = wallet.status === "ready" ? wallet.address : null;
  const byWallet = useWalletPages(readWalletCreatorClaimsPage, (row) => row.launchId, address ?? "", dependencies, active && address !== null);
  const byAccount = useWalletPages(readAccountCreatorClaimsPage, (row) => row.launchId, commitment ?? "", dependencies, active && commitment !== null);
  // The lists this reader has: an account without a Blast wallet has no wallet list to read.
  const lists = wallet.status === "ready" && address === null ? [byAccount] : [byAccount, byWallet];
  const answeredRows = new Map(lists.flatMap((list) => list.state.rows).map((row) => [row.launchId, row] as const));

  // Every launch this section has listed, in the order it arrived and kept after it leaves: rows
  // show in that order, and a claim's answer still drives the reads that move its row (adjusted
  // during render, React's pattern for derived state).
  const { rows, listed } = useListedRights(answeredRows);
  const completed = claims === null ? [] : listed.filter((launchId) => claims.view(`creator-caps:${launchId}`).state === "done");
  const answered = answeredRights(claims, rows.map((row) => row.launchId));
  const settling = answered.split("|").filter((entry) => entry.endsWith("=done")).join("|");
  const refresh = useEffectEvent(() => lists.forEach((list) => list.refresh()));
  useEffect(() => {
    if (!answered) return undefined;
    refresh();
  }, [answered]);
  useEffect(() => settling ? watchClaimSettlement(refresh) : undefined, [settling]);

  const { failure, pending, moreFailure, loadingMore, more, retry } = rightsReads(account, wallet, lists);
  return { rows, answered, completed, failure, pending, moreFailure, loadingMore, more, retry, lists };
}

function useListedRights(answeredRows: ReadonlyMap<string, PendingCreatorClaim>) {
  const [listed, setListed] = useState<readonly string[]>([]);
  const listedIds = new Set(listed);
  const added = [...answeredRows.keys()].filter((launchId) => !listedIds.has(launchId));
  if (added.length > 0) setListed([...listed, ...added]);
  const rows = [...listed, ...added].flatMap((launchId) => answeredRows.get(launchId) ?? []);
  return { rows, listed };
}

function CreatorRights({ reads, claims }: Readonly<{ reads: ReturnType<typeof useCreatorRightsReads>; claims: Claims | null }>) {
  const { rows, failure, pending, moreFailure, loadingMore, more, retry, lists } = reads;
  // Only every read answering empty means there is nothing to claim.
  if (rows.length === 0 && failure === null && !pending) return null;
  return (
    <Frame id="launch-creator-rights" list="rights" wallet={null}>
      {rows.map((row) => <CreatorRight key={row.launchId} row={row} claims={claims} />)}
      {rows.length === 0 && failure === null ? <CreatorRightsSkeleton label={LISTS.rights.loading} /> : null}
      {failure !== null ? (
        <EmptyState action={<Button onClick={retry}>Try again</Button>} role="alert" title={`${LISTS.rights.title} could not load`}>
          Nothing changed: {describeReason(failure)}. Try again in a moment.
        </EmptyState>
      ) : null}
      {moreFailure ? (
        <p className={styles.note} role="alert">
          More could not be loaded: {describeReason(moreFailure)}. Try again.
        </p>
      ) : null}
      {/* The busy Load more names the read; its pending row stays silent. */}
      {loadingMore ? <CreatorRightsSkeleton label={LISTS.rights.loadingMore} silent /> : null}
      {more ? (
        <Button loading={loadingMore} loadingLabel={LISTS.rights.loadingMore} onClick={() => lists.forEach((list) => list.more())}>
          Load more
        </Button>
      ) : null}
    </Frame>
  );
}

/**
 * The portfolio's launchpad rewards: for each linked wallet, the creator fees of the launches it
 * can claim for — the launch's `CurveFeeCap` as blast-infra follows it, so a cap moved to another
 * wallet moves the launch there — in both ledgers, and the holder rewards it received. Read in the
 * browser while signed in, through this app's private market routes; never in the server's HTML.
 * `addresses` null is a reader whose wallets are not known yet: both lists show as pending.
 * With `claims` (the shell's claim path), the rows of `claimWallet` — the Blast wallet, which
 * signs — can be claimed in place; the other wallets' rows are shown, not claimed, here.
 * `creatorAccount` (the account's creator commitment) adds the launches whose creator rights the
 * Blast wallet or the account can claim (LP-17), above the fees they lead to; `creatorWallet` is
 * the Blast wallet's read state (by default pending while `claimWallet` is null).
 */
export function LaunchRewards({
  addresses,
  active,
  hidden,
  market,
  claims,
  claimWallet = null,
  creatorAccount,
  creatorWallet,
}: Readonly<{
  addresses: readonly string[] | null;
  active: boolean;
  hidden: boolean;
  market?: MarketDataDependencies;
  claims?: Claims;
  claimWallet?: string | null;
  creatorAccount?: CreatorAccountRead;
  creatorWallet?: CreatorWalletRead;
}>) {
  const browser = useMemo(() => browserMarketDependencies(null), []);
  const dependencies = market ?? browser;
  const availableClaims = claims?.available ? claims : null;
  const creatorReads = useCreatorRightsReads({
    wallet: creatorWallet ?? (claimWallet === null ? { status: "loading" } : { status: "ready", address: claimWallet }),
    account: creatorAccount ?? { status: "loading" },
    dependencies,
    active: active && creatorAccount !== undefined,
    claims: availableClaims,
  });
  const rights = creatorAccount ? <CreatorRights reads={creatorReads} claims={availableClaims} /> : null;
  if (addresses === null) {
    return (
      <>
        {rights}
        {(["fees", "payouts"] as const).map((list) => (
          <Frame key={list} id={`pending-launch-${list}`} list={list} wallet={null}>
            <LaunchRewardsSkeleton {...LISTS[list].skeleton} />
          </Frame>
        ))}
      </>
    );
  }
  return (
    <>
      {rights}
      {addresses.map((address) => (
        <WalletRewards
          key={address}
          address={address}
          heading={addresses.length > 1}
          dependencies={dependencies}
          active={active}
          hidden={hidden}
          claiming={claims?.available && address === claimWallet ? { claims, wallet: address } : null}
          refreshOn={address === claimWallet ? creatorReads.answered : ""}
          rightsAwaitingFees={address === claimWallet ? creatorReads.completed : []}
        />
      ))}
    </>
  );
}
