"use client";

import { diagnosticMessage } from "#web/lib/errors.ts";

import { useFeedbackReveal } from "#web/components/blast-ui/feedback-motion.ts";
import { Button, ButtonLink } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { CoinVerifiedMark } from "#web/components/blast-ui/Icons.tsx";
import { Segmented } from "#web/components/blast-ui/Segmented.tsx";

import clsx from "clsx";
import { IntentLink as Link } from "#web/components/blast-ui/NavigationLink.tsx";
import { useRef, useSyncExternalStore } from "react";

import { presalePath } from "@blast/core/modules/social/items/do-the-same.ts";
import type { ProfilePresale, SocialProfileCalls } from "@blast/core/web/contracts/profile-page.ts";
import { socialProfileItemsPath } from "@blast/core/web/contracts/profiles.ts";

import { Sparkline } from "#web/components/charts/Sparkline.tsx";

import { OwnProfileActivity } from "../post/own-profile-activity";
import { FeedList } from "../FeedList";
import { CallsSkeleton } from "./CallsSkeleton";
import { sparkOf, usePrice } from "../prices/price-client";
import styles from "./Profile.module.css";
import { PresaleMark, StatusChip } from "./parts";
import { callRow } from "./profile-model";
import type { Loadable } from "./use-profile-data";

/**
 * The Profile board's sections; Created is the owner's alone. Backed carries
 * each call's thesis, so there is no separate Calls tab showing the same
 * presales again (2026-11-14, TS-5: three choices at most).
 */
const PROFILE_TABS = [["backed", "Backed"], ["activity", "Activity"]] as const;
const OWN_PROFILE_TABS = [["created", "Created"], ["backed", "Backed"], ["activity", "Activity"]] as const;
export type ProfileTab = (typeof OWN_PROFILE_TABS)[number][0];

const rememberedTabs = new Map<string, ProfileTab>();
const tabListeners = new Set<() => void>();
const subscribeTab = (listener: () => void) => {
  tabListeners.add(listener);
  return () => tabListeners.delete(listener);
};

/**
 * Backed (§6.5): one row per presale the account backed by name, trading
 * calls best first, each linking to its presale. A trading call shows its
 * coin since launch in a sparkline (R3-20, coloured by its multiple, hidden
 * on phones) and its multiple "since presale"; the others their status. A
 * coin without a price history keeps the line's place, empty. The account's
 * thesis on the call (its why) sits on one line under the row's figures.
 */
export function CallsList({ calls, onRetry }: Readonly<{ calls: Loadable<SocialProfileCalls>; onRetry?: () => void }>) {
  if (calls.status === "loading" || calls.status === "none") {
    return <CallsSkeleton />;
  }
  if (calls.status === "error") {
    return (
      <EmptyState action={onRetry ? <Button onClick={onRetry} size="sm">Try again</Button> : null} role="alert" title="Calls could not load">
        {calls.message ?? diagnosticMessage("Nothing changed. Check your connection and try again.")}
      </EmptyState>
    );
  }
  if (calls.value.calls.length === 0) return <EmptyState title="No presales backed yet" />;
  return (
    <div className={styles.rows}>
      {calls.value.calls.map((call) => {
        const row = callRow(call);
        return (
          <Link className={styles.prow} href={presalePath(row.presale.presale_id)} key={row.presale.presale_id}>
            <PresaleMark presale={row.presale} />
            <span className={styles.t}>
              {row.presale.verified_team ? <span className={styles.named}><b>{row.presale.name}</b><CoinVerifiedMark /></span> : <b>{row.presale.name}</b>}
              <span>{row.sub}</span>
              {row.why ? <span className={styles.why} title={row.why}>{row.why}</span> : null}
            </span>
            {row.result ? <CallSpark presaleId={row.presale.presale_id} up={row.result.tone === "up"} /> : null}
            <span className={styles.v}>
              {row.result ? (
                <>
                  <b className={styles[row.result.tone]}>{row.result.text}</b>
                  <span>since presale</span>
                </>
              ) : (
                <StatusChip status={row.status.tone} />
              )}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

/** Presales created by this account; only the owner receives this list. */
export function CreatedPresalesList({ presales, onRetry }: Readonly<{ presales: Loadable<readonly ProfilePresale[]>; onRetry?: () => void }>) {
  if (presales.status === "loading" || presales.status === "none") {
    return <CallsSkeleton created />;
  }
  if (presales.status === "error") {
    return (
      <EmptyState action={onRetry ? <Button onClick={onRetry} size="sm">Try again</Button> : null} role="alert" title="Your created presales could not load">
        {presales.message ?? diagnosticMessage("Check your connection and try again.")}
      </EmptyState>
    );
  }
  if (presales.value.length === 0) {
    return <EmptyState action={<ButtonLink href="/create" size="sm">Create a presale</ButtonLink>} title="No created presales yet" />;
  }
  return (
    <div className={styles.rows}>
      {presales.value.map((presale) => (
        <Link className={styles.prow} href={presalePath(presale.presale_id)} key={presale.presale_id}>
          <PresaleMark presale={presale} />
          <span className={styles.t}>
            {presale.verified_team ? <span className={styles.named}><b>{presale.name}</b><CoinVerifiedMark /></span> : <b>{presale.name}</b>}
            <span>{presale.symbol} · {presale.fill_pct}% filled</span>
          </span>
          <span className={styles.v}><StatusChip status={presale.status} /></span>
        </Link>
      ))}
    </div>
  );
}

/**
 * A trading call's line since launch, read with the rest of the page's calls
 * in one request. Its 89×28 place is kept while the line loads or when the
 * coin has no history, so the row never moves.
 */
function CallSpark({ presaleId, up }: Readonly<{ presaleId: string; up: boolean }>) {
  const price = usePrice({ presaleId, window: "launch" });
  return <Sparkline className={styles.spark} height={28} points={sparkOf(price)} slot="profile-call-sparkline" up={up} width={89} />;
}

/**
 * The sections card (the Profile board): the switch and its rows in one 24px
 * card. Selection is immediate; changed content reveals as one region.
 */
export function ProfileTabs({
  callsign,
  calls,
  nowMs,
  onRetryCalls,
  own = false,
  created = { status: "none" },
  onRetryCreated,
  loading = false,
}: Readonly<{
  callsign: string;
  calls: Loadable<SocialProfileCalls>;
  nowMs: number;
  onRetryCalls?: () => void;
  own?: boolean;
  created?: Loadable<readonly ProfilePresale[]>;
  onRetryCreated?: () => void;
  loading?: boolean;
}>) {
  const remembered = useSyncExternalStore(subscribeTab, () => rememberedTabs.get(callsign) ?? (own ? "created" : "backed"), () => own ? "created" : "backed");
  const tab = !own && remembered === "created" ? "backed" : remembered;
  const body = useRef<HTMLDivElement>(null);
  useFeedbackReveal(`${tab}:${calls.status}:${created.status}`, body);
  function setTab(next: ProfileTab) {
    rememberedTabs.set(callsign, next);
    for (const listener of tabListeners) listener();
  }
  return (
    <section aria-label="Profile sections" className={clsx("card", styles.secCard)}>
      <div className={styles.secH}>
        <Segmented disabled={loading} label="Profile sections" onChange={setTab} options={own ? OWN_PROFILE_TABS : PROFILE_TABS} value={tab} />
      </div>
      <div className={styles.tabBody} ref={body}>
        {tab === "created" && own ? (
          <CreatedPresalesList onRetry={onRetryCreated} presales={created} />
        ) : tab === "backed" ? (
          <CallsList calls={calls} onRetry={onRetryCalls} />
        ) : (
          <OwnProfileActivity value={own}><FeedList
            empty={<EmptyState title="No public activity yet" />}
            endpoint={socialProfileItemsPath(callsign)}
            heading={`@${callsign}'s activity`}
            initial={null}
            nowMs={nowMs}
          /></OwnProfileActivity>
        )}
      </div>
    </section>
  );
}
