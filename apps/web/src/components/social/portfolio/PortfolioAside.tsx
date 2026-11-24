"use client";

import { OwnInRightNowCard } from "../profile/ProfileAside";
import { useAmountsHidden, useMePresales } from "../profile/use-profile-data";
import { RewardsSideCard, useRowContext } from "../rewards/RewardsParts";
import { useRewards } from "../rewards/use-rewards";
import { WatchlistCard } from "../watchlist/WatchlistCard";
import { usePortfolioTab } from "./portfolio-tab";

/**
 * The right column of `/portfolio` (the Portfolio board; the shell's column
 * sets them 16px apart): the Rewards card once a payout exists (OA-45,
 * `/me/rewards`, the page's own read), "In right now" from the viewer's open
 * positions (`/me/presales`), the same card one's own profile draws, and the
 * Watchlist, which reads itself. The eye hides the amounts here too. A
 * visitor sees only the Watchlist's empty card: nothing of anyone's is shown
 * to a visitor here.
 */
export function PortfolioAside({ nowMs }: Readonly<{ nowMs: number }>) {
  const tab = usePortfolioTab();
  const me = useMePresales(true, true);
  const hidden = useAmountsHidden();
  const rewards = useRewards();
  const ctx = useRowContext(nowMs, hidden);
  return (
    <>
      {tab !== "claims" && rewards.status === "ready" && rewards.view ? <RewardsSideCard coins={rewards.view.coins} ctx={ctx} latest={rewards.view.latest} /> : null}
      <OwnInRightNowCard hidden={hidden} me={me.status === "ready" ? me.value : null} nowMs={nowMs} />
      <WatchlistCard nowMs={nowMs} />
    </>
  );
}
