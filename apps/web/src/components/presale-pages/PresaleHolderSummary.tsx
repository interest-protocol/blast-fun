import type { ReactNode } from "react";

import { presaleHolderShare } from "./sale-market-format";
import type { HomeCoin } from "@blast/core/web/contracts/home.ts";
import { IntentLink as Link } from "#web/components/blast-ui/NavigationLink.tsx";
import { WalletAddress } from "#web/components/launchpad/activity/WalletAddress.tsx";
import { formatQuantity } from "#web/components/launchpad/coin/coin-format.ts";
import { HolderSummary } from "#web/components/launchpad/holders/HolderSummary.tsx";
import { actorName } from "#web/components/social/coin-home/home-model.ts";

export function PresaleHolderSummary({ coin, children }: Readonly<{
  coin: HomeCoin;
  children: ReactNode;
}>) {
  const rows = coin.top_holders.holders.slice(0, 4).map((holder) => {
    const { actor } = holder;
    return {
      key: actor.type === "account" ? actor.callsign : actor.address,
      holder: actor.type === "account"
        ? <Link href={actor.path}>{actorName(actor)}</Link>
        : <WalletAddress address={actor.address} label="holder wallet address">{actor.short}</WalletAddress>,
      balance: formatQuantity(BigInt(holder.balance), coin.decimals, coin.symbol),
      share: presaleHolderShare(holder),
    };
  });
  return <HolderSummary rows={rows} shareNote="Share of total supply. Linked wallets are grouped. Pool and presale balances are excluded.">
    {children}
  </HolderSummary>;
}
