"use client";

import { createContext, useContext, type ReactNode } from "react";

import { usePortfolioState } from "../portfolio/use-portfolio-state";

import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { CoinGroup, RewardsEmpty, RewardsFailed, RewardsSignedOut, RewardsSkeleton, SummaryFigures, useRowContext } from "./RewardsParts";
import type { RewardCoinMeta, RewardCoinView, RewardPayoutView } from "./rewards-model";
import styles from "./Rewards.module.css";
import { useRewardCoinPayouts } from "./use-rewards";
import type { RoundsSource } from "./rewards-page-model";

/** What the Rewards page shows: `visitor` asks to sign in, `no-account` a session without a Blast Account yet, `loading` the moment before the session is known. */
export type RewardsMode = "loading" | "visitor" | "no-account" | "ready";

export type RewardsPageData = Readonly<{
  mode: RewardsMode;
  status: "off" | "loading" | "ready" | "error";
  errorMessage?: string;
  coins: readonly RewardCoinView[];
  latest: readonly RewardPayoutView[];
  retry: () => void;
}>;

/** Complete holder rewards, embedded in the Portfolio section. */
export function RewardsSection({
  data,
  nowMs,
  hidden,
  signIn,
  Rounds = LiveRounds,
}: Readonly<{ data: RewardsPageData; nowMs: number; hidden: boolean; signIn?: ReactNode; Rounds?: RoundsSource }>) {
  const ctx = useRowContext(nowMs, hidden);
  const [toggled, setToggled] = usePortfolioState<Record<string, boolean>>("reward-expansions", {});
  const { coins } = data;
  let body: ReactNode;
  if (data.mode === "visitor" || data.mode === "no-account") body = (
    <section aria-label="Rewards by coin" className={styles.coins}>
      <div className={styles.lh}><h3>By coin</h3></div>
      {data.mode === "visitor" ? <RewardsSignedOut signIn={signIn} /> : <EmptyState title="Finish setting up your account" />}
    </section>
  );
  else if (data.mode === "loading" || data.status === "loading" || data.status === "off") {
    body = (
      <RewardsSkeleton />
    );
  } else if (data.status === "error") body = <RewardsFailed card={false} message={data.errorMessage} onRetry={data.retry} />;
  else if (coins.length === 0) {
    body = (
      <div>
        <RewardsEmpty />
      </div>
    );
  } else {
    body = (
      <>
        <section aria-label="Rewards received" className={styles.sum}>
          <SummaryFigures coins={coins} hidden={hidden} last={data.latest[0] ?? null} nowMs={nowMs} />
        </section>
        <section aria-label="Rewards by coin" className={styles.coins}>
          <div className={styles.lh}>
            <h3>By coin</h3>
            {coins.length > 1 ? <span>{coins.length} coins</span> : null}
          </div>
          {coins.map((coin) => (
            <CoinGroup
              coin={coin}
              showHistorySummary={coins.length !== 1 || coin.payouts !== 1}
              ctx={ctx}
              key={coin.sourceId}
              onToggle={(open) => setToggled((current) => ({ ...current, [coin.sourceId]: open }))}
              open={toggled[coin.sourceId] ?? false}
              Rounds={Rounds}
            />
          ))}
        </section>
      </>
    );
  }
  return (
    <section aria-label="Holder rewards" className={styles.section}>
      {body}
    </section>
  );
}

const MetaContext = createContext<RewardCoinMeta>(new Map());

/** An open coin's rounds from `GET /api/social/me/rewards?presale=`: five, then ten more a page. */
function LiveRounds({ coin, open, children }: Parameters<RoundsSource>[0]) {
  const meta = useContext(MetaContext);
  const read = useRewardCoinPayouts(coin.sourceId, meta, open);
  return children({ errorMessage: read.errorMessage, pageError: read.pageError, rows: read.rows, status: read.status, more: read.more, loadingMore: read.loadingMore, loadMore: read.loadMore, retry: read.retry });
}

/** The summary and expanded histories share their existing metadata and API queries. */
export function RewardRoundsProvider({ meta, children }: Readonly<{ meta: RewardCoinMeta; children: ReactNode }>) {
  return <MetaContext value={meta}>{children}</MetaContext>;
}
