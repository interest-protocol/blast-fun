"use client";

import { DexIdentity } from "#web/components/blast-ui/DexIdentity.tsx";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { NO_VALUE } from "@blast/core/web/format.ts";

import type { CreateIssue } from "@blast/core/web/contracts/create.ts";

import { allowlistForChecks, issuesOf, type CreateState } from "./create-store";
import { presaleSignLabel, reviewAttention, reviewGroups } from "./create-review-model";
import { cx } from "./cx";
import { Ticker } from "#web/components/blast-ui/Ticker.tsx";
import { CoinMark, FoldList, ReviewFold, SignaturesFold } from "./fields";

function RecipientAddress({ address }: Readonly<{ address: string }>) {
  return <InspectValue label="recipient address" value={address}>{address.slice(0, 8)}…{address.slice(-6)}</InspectValue>;
}

/** The coin over its cover (3:1), or on its own when no cover is added. */
function Hero({ state }: Readonly<{ state: CreateState }>) {
  const { draft } = state;
  const cover = state.coverPreview ?? state.cover?.url ?? null;
  const identity = (
    <div className={cx("cr-hero-id")}>
      <CoinMark draft={draft} logo={state.logoPreview ?? state.logoUrl} size="s56" />
      <span className={cx("t")}>
        {draft.name.trim() ? <b>{draft.name.trim()}</b> : <b className={cx("cr-none")}>{NO_VALUE}</b>}
        {draft.symbol ? <span><Ticker symbol={draft.symbol} /> · Presale on Blast</span> : <span className={cx("cr-none")}>{NO_VALUE}</span>}
      </span>
    </div>
  );
  return (
    <div className={cx("cr-hero", cover && "has-cover")} data-surface="">
      {/* eslint-disable-next-line @next/next/no-img-element -- the sale's cover, or the picked file while it uploads */}
      {cover ? <img alt={`${draft.name.trim() || "Presale"} cover`} height={512} src={cover} width={1_536} /> : null}
      {identity}
    </div>
  );
}

/**
 * Review (the CreateReview board's left column): the coin over its cover,
 * then every term the presale locks in six groups and the wallet's three
 * signatures, each folded into one row with its short value; a group with a
 * missing or wrong value names it in its row. The stepper is the one way
 * back to edit. Publishing is in the right column, its money sentence never
 * folded.
 */
export function CreateSummary({ state, issues = issuesOf(state) }: Readonly<{ state: CreateState; issues?: readonly CreateIssue[] }>) {
  const groups = reviewGroups({ ...state, allowlistWallets: allowlistForChecks(state)?.leaf_count ?? null });
  return (
    <div aria-label="Presale terms to review" className={cx("cr-review")} id="cr-review" role="region" tabIndex={-1}>
      <Hero state={state} />
      <FoldList>
      {groups.map((group) => (
        <ReviewFold
          attention={reviewAttention(issues, group.sections, group.rows.filter((row) => row.address === "").map((row) => row.key))}
          id={`cr-rv-${group.title.replace(/\W+/g, "-").toLowerCase()}`}
          key={group.title}
          title={group.title}
          value={group.summary}
        >
            {group.rows.map((row) => (
              <div key={`${row.key}:${row.address ?? ""}`}>
                <dt>{row.key}</dt>
                <dd className="num">
                  {row.venue ? <DexIdentity iconOnly venue={row.venue} /> : null}
                  {/* The value and its ticker are one run of text (one space between), so they wrap together inside the card. */}
                  {row.value || row.ticker ? <span>{row.value && row.ticker ? `${row.value} ` : row.value}{row.ticker ? <span className="ticker">{row.ticker}</span> : null}</span> : null}
                  {row.detail ? <span className={cx("cr-detail")}>{row.detail}</span> : null}
                  {/* A wallet not added yet is the muted dash, never a blank row. */}
                  {row.address ? <RecipientAddress address={row.address} /> : row.address === "" ? <span className={cx("cr-none")}>{NO_VALUE}</span> : null}
                </dd>
              </div>
            ))}
        </ReviewFold>
      ))}
        <SignaturesFold id="cr-rv-signatures" labels={(["publish_coin", "register_currency", "create_presale"] as const).map((step) => presaleSignLabel(step, state.draft.symbol))} />
      </FoldList>
    </div>
  );
}
