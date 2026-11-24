"use client";
import { queryKeys } from "#web/lib/query/keys.ts";
import { RefreshFailed } from "./DataStates";

import { workspaceScrollOwner } from "./scroll-owner";

import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { isValidStructTag } from "@mysten/sui/utils";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { PendingStatus, SkeletonBox } from "#web/components/blast-ui/Skeleton.tsx";
import { Collapse } from "#web/components/blast-ui/Collapse.tsx";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import {
  HOME_DEFAULT_WINDOW,
  type HomeCoin,
  type HomeTrader,
  type HomeTraderHolding,
} from "@blast/core/web/contracts/home.ts";
import {
  actorName,
  coinFigure,
  pnlText,
  portfolioText,
  shareText,
} from "../../coin-home/home-model";
import { fetchHomeCoins } from "../../coin-home/home-client";
import { ActorCell } from "./ActorCell";
import { actorIdentity } from "./actor-identity";
import { CoinPageLink, PanelAddButton, RowToggle } from "./CoinsRows";
import { assetOnScreen, canonicalCoinType } from "./coin-row-model";
import { useWorkspace } from "./workspace-context";
import rowStyles from "./CoinsData.module.css";
import styles from "./TradersData.module.css";

/** How many holding marks the row's "holds" pile shows; the full list is in the details. */
const PILE = 3;

/** A trader's detail line: "holds" and the first few coins held, their symbols kept for assistive technology. */
function HeldCoins({ held }: Readonly<{ held: readonly HomeTraderHolding[] }>) {
  return (
    <span className={styles.detail}>
      holds
      <span aria-hidden="true" className={styles.pile}>
        {held.slice(0, PILE).map((holding) => (
          <CoinMark
            coin={{ key: holding.launch_id ?? holding.presale_id!, iconUrl: holding.icon_url, symbol: holding.symbol, round: true }}
            key={holding.launch_id ?? holding.presale_id}
            size={16}
          />
        ))}
      </span>
      <span className={rowStyles.visuallyHidden}>
        {held.slice(0, PILE).map((holding) => holding.symbol).join(", ")}
      </span>
      {held.length > PILE ? <span>+{held.length - PILE}</span> : null}
    </span>
  );
}

export function TraderRows({
  traders,
}: Readonly<{ traders: readonly HomeTrader[] }>) {
  const { snapshot, dispatch } = useWorkspace();
  const controls = snapshot.data.controls.Traders;
  const list = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    const localBody = list.current?.closest<HTMLElement>("#workspace-data-panel");
    const body = localBody ? workspaceScrollOwner(localBody) : null;
    if (!body) return;
    const rows = [
      ...list.current!.querySelectorAll<HTMLElement>("[data-workspace-trader]"),
    ];
    const anchor = controls.navigation.anchor;
    const exact =
      anchor &&
      rows.find((row) => row.dataset.workspaceTrader === anchor.actor_key);
    const row =
      exact || (anchor && rows[Math.min(anchor.index, rows.length - 1)]);
    if (row && anchor) {
      body.scrollTop +=
        row.getBoundingClientRect().top -
        body.getBoundingClientRect().top -
        anchor.offset;
      if (!exact)
        dispatch.patchDataControls("Traders", {
          ...controls,
          navigation: {
            ...controls.navigation,
            anchor: {
              ...anchor,
              actor_key: row.dataset.workspaceTrader!,
              index: rows.indexOf(row),
            },
          },
        });
    } else body.scrollTop = controls.navigation.scroll_top;
  });
  return (
    <ol ref={list} className={rowStyles.list} aria-label="Global traders">
      {traders.map((trader) => (
        <TraderRow trader={trader} key={trader.key} />
      ))}
    </ol>
  );
}

function TraderRow({ trader }: Readonly<{ trader: HomeTrader }>) {
  const { snapshot, dispatch } = useWorkspace();
  const controls = snapshot.data.controls.Traders;
  const id = useId();
  const open = controls.navigation.expanded_ids.includes(trader.key);
  const holdingsPublic = trader.holdings_public ?? trader.portfolio.public;
  const performancePublic =
    trader.performance_public ?? trader.portfolio.public;
  const name = actorName(trader.actor);
  const identity = actorIdentity(trader.actor);
  const held = holdingsPublic ? (trader.holdings ?? []) : [];
  const rank = performancePublic && trader.rank != null ? trader.rank : null;
  return (
    <li className={rowStyles.row} data-expanded={open} data-workspace-trader={trader.key}>
      <div className={rowStyles.head} data-cols="person" data-disclosure="">
        <RowToggle
          controls={id}
          expanded={open}
          label={`${name} holdings`}
          onToggle={() =>
            dispatch.patchDataControls("Traders", {
              ...controls,
              navigation: {
                ...controls.navigation,
                expanded_ids: open
                  ? controls.navigation.expanded_ids.filter(
                      (key) => key !== trader.key,
                    )
                  : [...controls.navigation.expanded_ids, trader.key],
              },
            })
          }
        />
        <ActorCell
          identity={identity}
          size={28}
          detail={held.length > 0 ? <HeldCoins held={held} /> : undefined}
        />
        <span className={rowStyles.figs}>
          <span className={rowStyles.figTop}>
            <RowPnl value={trader.portfolio.pnl_usd} hidden={!performancePublic} />
          </span>
          {rank !== null && <span className={rowStyles.figSub}>Rank {rank}</span>}
        </span>
      </div>
      <Collapse open={open} keepMounted={false}>
        <div id={id} className={styles.details}>
          <dl className={rowStyles.facts}>
            {rank !== null && <div>
              <dt>Global rank</dt>
              <dd>{rank}</dd>
            </div>}
            {(!holdingsPublic || trader.portfolio.value_usd !== null) && <div>
              <dt>Holdings · USD</dt>
              <dd>
                {!holdingsPublic ? (
                  "Private"
                ) : (
                  <InspectValue
                    label="holdings value in USD"
                    value={trader.portfolio.value_usd!}
                  >
                    {portfolioText(trader.portfolio.value_usd!)}
                  </InspectValue>
                )}
              </dd>
            </div>}
          </dl>
          <TraderDetails trader={trader} active={open} />
        </div>
      </Collapse>
    </li>
  );
}

function TraderDetails({
  trader,
  active,
}: Readonly<{ trader: HomeTrader; active: boolean }>) {
  const client = useAppQueryClient();
  const holdingsPublic = trader.holdings_public ?? trader.portfolio.public;
  const holdings = holdingsPublic ? trader.holdings : undefined;
  const ids = [
    ...new Set([
      ...(holdings?.flatMap((holding) => holding.presale_id ? [holding.presale_id] : []) ?? []),
      ...trader.coins.map((coin) => coin.presale_id),
    ]),
  ];
  const idsKey = ids.join(",");
  useEffect(() => {
    if (!active)
      void client.cancelQueries({
        queryKey: queryKeys.workspace.traderAssets(trader.key, idsKey),
      });
  }, [active, client, idsKey, trader.key]);
  const assets = useQuery(
    {
      queryKey: queryKeys.workspace.traderAssets(trader.key, idsKey),
      queryFn: ({ signal }) =>
        fetchHomeCoins(ids, HOME_DEFAULT_WINDOW, signal).then(
          (page) => page.coins,
        ),
      enabled: active && ids.length > 0,
      retry: false,
      staleTime: 0,
      refetchOnMount: "always",
    },
    client,
  );
  const asset = (presaleId: string) =>
    assets.data?.find(
      (coin) =>
        coin.presale_id === presaleId && isValidStructTag(coin.coin_type),
    );
  const pending = assets.isPending || assets.isError;
  return (
    <>
      <h3>Holdings</h3>
      {assets.isFetching && <PendingStatus label="Resolving trader assets" />}
      {assets.isError && (
        <RefreshFailed onRetry={() => void assets.refetch()} retryLabel="Retry assets" title="Assets could not load">Holdings are still shown.</RefreshFailed>
      )}
      <TraderHoldings trader={trader} asset={asset} pending={pending} />
      {trader.coins.length > 0 && (
        <>
          <h3>Recent assets · 24h</h3>
          <ul className={styles.recent}>
            {trader.coins.map((coin) => (
              <li key={coin.presale_id} className={styles.recentAsset}>
                <CoinPageLink className={rowStyles.coinLink} presaleId={coin.presale_id} symbol={coin.symbol}>
                  <CoinMark
                    coin={{ key: coin.presale_id, iconUrl: coin.icon_url, symbol: coin.symbol, round: true }}
                    size={28}
                  />
                </CoinPageLink>
                <AssetAdd coin={asset(coin.presale_id)} pending={pending} />
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function TraderHoldings({
  trader,
  asset,
  pending,
}: Readonly<{
  trader: HomeTrader;
  asset: (presaleId: string) => HomeCoin | undefined;
  pending: boolean;
}>) {
  const holdingsPublic = trader.holdings_public ?? trader.portfolio.public;
  const performancePublic =
    trader.performance_public ?? trader.portfolio.public;
  const holdings = holdingsPublic ? trader.holdings : undefined;
  return (
    <>
      {!holdingsPublic ? (
        <p className={rowStyles.note}>Private</p>
      ) : holdings === undefined ? (
        <p className={rowStyles.note}>Holdings unavailable.</p>
      ) : holdings.length === 0 ? (
        <p className={rowStyles.note}>No holdings.</p>
      ) : (
        <ul className={styles.holdings}>
          {holdings.map((holding) => (
            <HoldingRow
              key={holding.launch_id ?? holding.presale_id}
              holding={holding}
              performancePublic={performancePublic}
              coin={holding.presale_id ? asset(holding.presale_id) : undefined}
              pending={pending}
            />
          ))}
        </ul>
      )}
      {holdingsPublic &&
        trader.holdings_total !== undefined &&
        trader.holdings_total > (holdings?.length ?? 0) && (
          <p className={rowStyles.note}>
            Showing {holdings?.length ?? 0} of {trader.holdings_total} indexed
            holdings.
          </p>
        )}
    </>
  );
}

function HoldingRow({
  holding,
  performancePublic,
  coin,
  pending,
}: Readonly<{
  holding: HomeTraderHolding;
  performancePublic: boolean;
  coin: HomeCoin | undefined;
  pending: boolean;
}>) {
  const balance = coinFigure(
    holding.balance,
    holding.symbol,
    holding.decimals,
    4,
  );
  return (
    <li className={styles.holding}>
      <div className={styles.holdingHead}>
        <CoinPageLink className={rowStyles.coinLink} presaleId={holding.presale_id} launchId={holding.launch_id} coinType={holding.coin_type} symbol={holding.symbol}>
          <CoinMark
            coin={{ key: holding.launch_id ?? holding.presale_id!, iconUrl: holding.icon_url, symbol: holding.symbol, round: true }}
            size={28}
          />
        </CoinPageLink>
        <span className={rowStyles.text}>
          <strong className={styles.symbol}>{holding.symbol}</strong>
          <span className={rowStyles.t2}>
            <InspectValue
              label={`${holding.symbol} balance in atoms`}
              value={holding.balance}
            >
              {holding.balance !== "0" && balance === `0 ${holding.symbol}`
                ? `<0.0001 ${holding.symbol}`
                : balance}
            </InspectValue>
          </span>
        </span>
        <AssetAdd coin={coin} pending={pending} />
      </div>
      <dl className={styles.metrics}>
        {holding.value_usd !== null && <div>
          <dt>Value · USD</dt>
          <dd>
            <InspectValue
                label={`${holding.symbol} value in USD`}
                value={holding.value_usd}
              >
                {portfolioText(holding.value_usd)}
              </InspectValue>
          </dd>
        </div>}
        {holding.share_bps !== null && <div>
          <dt>Share</dt>
          <dd>
            <InspectValue
                label={`${holding.symbol} holdings share in basis points`}
                value={String(holding.share_bps)}
              >
                {shareText(holding.share_bps)}
              </InspectValue>
          </dd>
        </div>}
        {(!performancePublic || holding.pnl_usd !== null) && <div>
          <dt>Unrealized PnL</dt>
          <dd>
            <RowPnl value={holding.pnl_usd} hidden={!performancePublic} />
          </dd>
        </div>}
      </dl>
    </li>
  );
}

function AssetAdd({
  coin,
  pending,
}: Readonly<{ coin: HomeCoin | undefined; pending: boolean }>) {
  const { snapshot, dispatch } = useWorkspace();
  if (!coin)
    return pending ? (
      <SkeletonBox className={rowStyles.addSkeleton} />
    ) : (
      <span className={rowStyles.note}>Asset unavailable.</span>
    );
  return (
    <PanelAddButton
      open={assetOnScreen(snapshot, canonicalCoinType(coin.coin_type))}
      symbol={coin.symbol}
      onAdd={() => {
        const id = dispatch.add({
          panel_id: crypto.randomUUID(),
          chain: "sui",
          network: "mainnet",
          coin_type: coin.coin_type,
          presale_id: coin.presale_id,
        });
        if (coin.lifecycle === "migrated")
          dispatch.patchPanel(id, { active_namespace: "coin" });
      }}
    />
  );
}

/** The row's PnL: signed, its sign the direction and colour repeating it; the exact dollars inspect. */
function RowPnl({
  value,
  hidden,
}: Readonly<{ value: string | null; hidden: boolean }>) {
  const pnl = pnlText(value);
  if (hidden) return <span className={styles.muted}>Private</span>;
  if (!pnl || value === null) return null;
  return (
    <span className={styles.pnl} data-direction={pnl.tone}>
      <InspectValue label="PnL in USD" value={value}>
        {pnl.text}
      </InspectValue>
    </span>
  );
}
