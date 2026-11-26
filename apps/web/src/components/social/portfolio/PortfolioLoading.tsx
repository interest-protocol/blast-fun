"use client";

import clsx from "clsx";
import { useState } from "react";
import { Button, IconButton } from "#web/components/blast-ui/Button.tsx";
import { Segmented } from "#web/components/blast-ui/Segmented.tsx";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { EyeIcon, ArrowDownIcon, ArrowUpIcon, BridgeIcon } from "#web/components/blast-ui/Icons.tsx";
import { PageHeader } from "#web/components/blast-ui/PageHeader.tsx";
import { SkeletonText as Text } from "#web/components/blast-ui/Skeleton.tsx";
import { LockIcon } from "../profile/icons";
import { CreatorEarningsSkeleton } from "../creator-earnings/CreatorEarningsSkeleton";
import creator from "../creator-earnings/CreatorEarnings.module.css";
import { RewardsSkeleton } from "../rewards/RewardsSkeleton";
import { RowSkeletons } from "./HoldingsSkeleton";
import portfolio from "./Portfolio.module.css";
import { heroFigures } from "./portfolio-model";
import { portfolioTabs } from "#web/components/blast-ui/portfolio-navigation.ts";
import { usePortfolioTab } from "./portfolio-tab";
import { useSocialAccount } from "../use-social-account";
import { useSocialViewer } from "../SignInGate";
import { useAmountsHidden } from "../profile/use-profile-data";
import { PORTFOLIO_PERIODS } from "./portfolio-history";
import { PortfolioScreen } from "./PortfolioScreen";
import { useBridge } from "../bridge/bridge-context.tsx";

const ACTION_ICONS = { Deposit: ArrowDownIcon, Withdraw: ArrowUpIcon, Bridge: BridgeIcon } as const;

/** The live rows' buttons, disabled: Deposit, Withdraw and Bridge (while it is on), primary at the trailing edge on desktop. */
function PortfolioActions({ mobile = false }: Readonly<{ mobile?: boolean }>) {
  const bridge = useBridge() !== null;
  const labels = (["Deposit", "Withdraw", ...(bridge ? ["Bridge"] as const : [])] as const);
  return (
    <div className={mobile ? portfolio.actsM : portfolio.actsD} data-three={(mobile && bridge) || undefined}>
      {(mobile ? labels : [...labels].reverse()).map((label) => {
        const Icon = ACTION_ICONS[label];
        return (
          <Button
            disabled
            key={label}
            size={mobile ? "lg" : "md"}
            variant={label === "Deposit" ? "primary" : "secondary"}
          >
            <Icon />
            {label}
          </Button>
        );
      })}
    </div>
  );
}

export function PortfolioLoading() {
  const tab = usePortfolioTab();
  const hidden = useAmountsHidden();
  const client = useAppQueryClient();
  const viewer = useSocialViewer();
  const account = useSocialAccount();
  const [nowMs] = useState(() => Date.now());
  const tabs = portfolioTabs();
  if (viewer.signedIn && account.status === "ready" && account.account && client.getQueryData(queryKeys.me.portfolio())) {
    return <PortfolioScreen nowMs={nowMs} />;
  }
  return (
    <article
      aria-busy="true"
      aria-label="Loading portfolio"
      className={portfolio.page}
      data-route-loading="portfolio"
    >
      <PageHeader actions={<PortfolioActions />} title="Portfolio" />
      <section
        aria-label="Your portfolio"
        className={clsx("card", portfolio.hero)}
        id="pfHero"
      >
        <div className={portfolio.head}>
          <div className={portfolio.sum}>
            <span className={portfolio.lbl}>
              <Text>Portfolio value</Text>
              <IconButton aria-label="Hide amounts" className={portfolio.eye} disabled size="xs">
                <EyeIcon />
              </IconButton>
              <span aria-hidden="true" className={portfolio.priv}><LockIcon /><Text>Only you</Text></span>
            </span>
            <div className={clsx(portfolio.val, "num")}>
              <Text>Amount</Text>
            </div>
            <div className={portfolio.chg}><Text>Valuation coverage</Text></div>
          </div>
          <Segmented className={portfolio.period} disabled label="Range" onChange={() => undefined} options={PORTFOLIO_PERIODS} size="sm" value="1w" />
        </div>
        {!hidden && <div aria-label="Loading the value history" className={portfolio.chart} role="status" />}
        <div className={portfolio.mix}>
          <div aria-hidden="true" className={portfolio.alloc} />
          <div className={portfolio.split}>
            {heroFigures({ total: null, coins: null, committed: null, claimable: null }, true).map((figure) => (
              <button className={portfolio.st} disabled key={figure.key} type="button">
                <span>{figure.label}</span>
                <b className="num">
                  <Text>Amount</Text>
                </b>
              </button>
            ))}
          </div>
        </div>
        <PortfolioActions mobile />
      </section>
      <div className={portfolio.secs}>
        <section
          aria-label="Your holdings"
          className={clsx("card", portfolio.hold)}
          id="pfHold"
        >
          <div className={portfolio.tabs}>
            <Segmented disabled label="Holdings" onChange={() => undefined} options={tabs} value={tab} />
          </div>
          <div className={portfolio.body}>
            {tab === "claims" ? (
              <>
                <RowSkeletons kind="vestings" />
                <RewardsSkeleton />
                <section aria-label="Creator earnings" className={creator.section}>
                  <div className={creator.header}>
                    <h3>Creator earnings</h3>
                    <span aria-hidden="true" className={creator.refresh}><Text>↻</Text></span>
                  </div>
                  <CreatorEarningsSkeleton />
                </section>
              </>
            ) : (
              <RowSkeletons
                kind={
                  tab === "presales" ? "presales" : "coins"
                }
              />
            )}
          </div>
        </section>
      </div>
    </article>
  );
}
