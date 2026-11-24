"use client";

import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { shortAddress as shortId, venueName } from "@blast/core/lib/format.ts";
import type { ReactNode } from "react";

import { LIFECYCLE_FROM_SDK } from "@blast/core/modules/launchpad-coin/availability.ts";
import { witnessVenue, type CoinPage, type CurveRead } from "@blast/core/modules/launchpad-coin/contracts.ts";

import { DexIdentity } from "#web/components/blast-ui/DexIdentity.tsx";
import { DataState } from "../primitives/DataState";
import styles from "./Coin.module.css";
import { formatDuration, formatQuantity, formatUsd } from "./coin-format";
import { allocationRows, coinIdentity, feeRouteLabel, LIFECYCLE_LABEL, sectionState, selectedPrice } from "./coin-view";
import { Fact, Facts, Id } from "./Facts";
import { bpsPercent } from "@blast/core/lib/bps.ts";

const NO_OPENING_ROUND = 0n;

function Group({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <section className={styles.group} aria-label={title}>
      <h3 className={styles.groupTitle}>{title}</h3>
      {children}
    </section>
  );
}

/**
 * The overview slot: the launch’s market, terms, allocations and fees.
 */
export function CoinOverview(props: Readonly<{ page: CoinPage; fees?: ReactNode }>) {
  const { page, fees } = props;
  const identity = coinIdentity(page);
  const fresh = page.fresh.status === "read" ? page.fresh : null;
  const curveState = sectionState(page.curve);
  const meme = identity.symbol;
  const quote = identity.quoteSymbol;

  const curveGroup = (title: string, render: (curve: CurveRead) => ReactNode) => ({ title, render });

  const groups = [
    curveGroup("Lifecycle and graduation", ({ launch, progressBps }) => {
        const { inputs } = launch.economics;
        const quoteAmount = (atoms: bigint) => formatQuantity(atoms, inputs.quoteDecimals, quote);
        return (
          <Facts>
            <Fact term="Lifecycle">{LIFECYCLE_LABEL[launch.lifecycle]}</Fact>
            <Fact term="Created"><DateStamp at={launch.createdAtMs} label="creation time" /></Fact>
            <Fact term="Public start">{launch.publicStartMs === null ? "Not shared yet" : <DateStamp at={launch.publicStartMs} label="public start time" />}</Fact>
            <Fact term="Opening round">
              {launch.launch.openingRoundMs === NO_OPENING_ROUND ? "None" : formatDuration(launch.launch.openingRoundMs)}
            </Fact>
            {inputs.graduationTarget === null ? null : (
              <Fact term="Graduation target">{quoteAmount(inputs.graduationTarget)}</Fact>
            )}
            {launch.lifecycle === "migrated" || inputs.quoteReserve === null ? null : (
              <Fact term={`${quote} raised`}>{quoteAmount(inputs.quoteReserve)}</Fact>
            )}
            <Fact term="Progress">{progressBps === null ? "Unavailable" : bpsPercent(progressBps)}</Fact>
            {launch.migration ? <Fact term="Migrated at"><DateStamp at={launch.migration.timestampMs} label="migration time" /></Fact> : null}
          </Facts>
        );
    }),
    curveGroup("Starting economics", ({ launch, economics }) => {
        const { inputs } = launch.economics;
        const quoteAmount = (atoms: bigint) => formatQuantity(atoms, inputs.quoteDecimals, quote);
        const memeAmount = (atoms: bigint) => formatQuantity(atoms, inputs.memeDecimals, meme);
        return (
          <Facts>
            {inputs.virtualQuote === null ? null : <Fact term="Virtual starting liquidity">{quoteAmount(inputs.virtualQuote)}</Fact>}
            {economics ? (
              <>
                <Fact term="Curve supply">{memeAmount(economics.curveMeme)}</Fact>
                <Fact term="Curve release at graduation">{memeAmount(economics.curveMemeReleased)}</Fact>
                <Fact term="Opening valuation">{quoteAmount(economics.openingValuation)}</Fact>
                <Fact term="Valuation at graduation">{quoteAmount(economics.curveTerminalValuation)}</Fact>
                <Fact term="Pool opening valuation">{quoteAmount(economics.dexOpeningValuation)}</Fact>
                <Fact term="Pool liquidity">
                  {memeAmount(economics.liquidityMeme)} · {quoteAmount(economics.liquidityQuote)}
                </Fact>
              </>
            ) : (
              <Fact term="Launch valuations">Unavailable</Fact>
            )}
          </Facts>
        );
    }),
    curveGroup("Fees", ({ launch, split }) => (
        <>
          <Facts>
            <Fact term="Creation fee">{formatQuantity(launch.launch.creationFee, 9, "SUI")}</Fact>
            <Fact term="Curve trade fee">
              {fresh
                ? `${bpsPercent(fresh.launch.quoteFeeBps)} ${quote} · ${bpsPercent(fresh.launch.memeFeeBps)} ${meme}`
                : "Unavailable"}
            </Fact>
          </Facts>
          <p className={styles.subhead}>LP fee split</p>
          <Facts label="LP fee split">
            {split.routes.filter(({ bps }) => bps > 0).map(({ destination, bps }) => (
              <Fact key={destination.kind === "Address" ? destination.address : destination.kind} term={feeRouteLabel(destination)}>{bpsPercent(bps)}</Fact>
            ))}
          </Facts>
        </>
    )),
    curveGroup("Allocation", ({ plan }) => (
        <Facts>
          <Fact term="Curve">{bpsPercent(plan.curveMemeBps)}</Fact>
          <Fact term="Liquidity">
            {bpsPercent(plan.lpMemeBps)} {meme} · {bpsPercent(plan.lpQuoteBps)} {quote}
          </Fact>
          <Fact term="Blast">
            {bpsPercent(plan.protocolMemeBps)} {meme} · {bpsPercent(plan.protocolQuoteBps)} {quote}
          </Fact>
          {allocationRows(plan).map((recipient) => (
            <Fact key={recipient.key} term={shortId(recipient.recipient.destination)}>
              {bpsPercent(recipient.memeBps)} {meme} · {bpsPercent(recipient.quoteBps)} {quote}
            </Fact>
          ))}
        </Facts>
    )),
    curveGroup("Venue and route", ({ launch }) => {
        const { inputs } = launch.economics;
        const migration = launch.migration;
        const { migrationWitness, poolTickSpacing, poolFeeRate } = launch.launch;
        const venue = witnessVenue(migrationWitness);
        return (
          <Facts>
            {venue ? <Fact term="Migration venue"><DexIdentity venue={venue} iconOnly /></Fact> : null}
            {poolTickSpacing !== null ? (
              <Fact term="Pool tier">
                Tick spacing {poolTickSpacing.toString()}{poolFeeRate !== null ? ` · fee rate ${poolFeeRate}` : null}
              </Fact>
            ) : null}
            {migration ? (
              <>
                {migration.poolKey ? <Fact term="Pool address"><Id>{migration.poolKey.split(":")[1] ?? migration.poolKey}</Id></Fact> : null}
                <Fact term={`${meme} in pool`}>{formatQuantity(migration.meme, inputs.memeDecimals, meme)}</Fact>
                <Fact term={`${quote} in pool`}>{formatQuantity(migration.quote, inputs.quoteDecimals, quote)}</Fact>
                <Fact term="Burned or disposed">{formatQuantity(migration.disposedMeme, inputs.memeDecimals, meme)}</Fact>
                <Fact term="Supply after">{formatQuantity(migration.totalSupplyAfter, inputs.memeDecimals, meme)}</Fact>
                {migration.allocations.map((paid) => (
                  <Fact key={paid.cursor} term="Allocation paid">
                    {shortId(paid.destination)} {formatQuantity(paid.meme, inputs.memeDecimals, meme)} ·{" "}
                    {formatQuantity(paid.quote, inputs.quoteDecimals, quote)}
                  </Fact>
                ))}
              </>
            ) : null}
          </Facts>
        );
    }),
    curveGroup("Identity", ({ launch }) => {
        const coin = page.coin.state === "available" || page.coin.state === "stale" ? page.coin.data : null;
        return (
          <Facts>
            <Fact term="Launch ID"><Id>{launch.launchId}</Id></Fact>
            <Fact term="Coin type"><Id>{launch.coinType}</Id></Fact>
            <Fact term="Quote">{quote} <Id>{launch.quoteType}</Id></Fact>
            <Fact term="Creator">
              {coin?.creator ? (
                <>
                  <code className={styles.id} title={coin.creator}>{shortId(coin.creator)}</code>
                  {coin.creatorSource === "claim" ? " (claimed account)" : ""}
                </>
              ) : (
                "Unknown"
              )}
            </Fact>
            <Fact term="Partner">
              {launch.partner ? (
                <>
                  <code className={styles.id} title={launch.partner.partnerId}>{shortId(launch.partner.partnerId)}</code>{" "}
                  {launch.partner.status === "admitted"
                    ? "Admitted"
                    : launch.partner.status === "removal_scheduled"
                      ? <>Removal scheduled{launch.partner.acceptedUntilMs === null ? null : <>, accepted until <DateStamp at={launch.partner.acceptedUntilMs} label="partner removal time" /></>}</>
                      : "Status unknown"}
                </>
              ) : (
                "None"
              )}
            </Fact>
          </Facts>
        );
    }),
  ];

  return (
    <div className={styles.overview}>
      <Group title="Market">
        <DataState state={sectionState(page.coin)} subject="market facts">
          {(coin) => {
            const { price, known } = selectedPrice(page);
            return (
              <Facts>
                <Fact term="Price">{price ?? (known ? "No price yet" : "Unavailable")}</Fact>
                {coin.market?.fdv_usd != null ? <Fact term="FDV">{formatUsd(coin.market.fdv_usd)}</Fact> : null}
                <Fact term="Supply">{formatQuantity(coin.supply, coin.decimals, meme)}</Fact>
                <Fact term="24h volume">
                  {formatQuantity(coin.stats.day.volumeQuote, coin.quoteDecimals, quote)}
                  {coin.stats.day.volumeUsd === null ? "" : ` · ${formatUsd(coin.stats.day.volumeUsd)}`}
                </Fact>
                <Fact term="All-time volume">
                  {formatQuantity(coin.stats.all.volumeQuote, coin.quoteDecimals, quote)}
                  {coin.stats.all.volumeUsd === null ? "" : ` · ${formatUsd(coin.stats.all.volumeUsd)}`}
                </Fact>
                <Fact term="Trades, 24h">{coin.stats.day.trades.toLocaleString("en-US")}</Fact>
                <Fact term="Indexed holders">{coin.stats.holders.toLocaleString("en-US")}</Fact>
              </Facts>
            );
          }}
        </DataState>
      </Group>
      <Group title="Launch object">
        {fresh ? (
          <Facts>
            <Fact term="Lifecycle">{LIFECYCLE_LABEL[LIFECYCLE_FROM_SDK[fresh.launch.lifecycle]]}</Fact>
            <Fact term="Read from Sui"><DateStamp at={fresh.readAtMs} label="Sui read time" /></Fact>
            <Fact term="Object"><Id>{fresh.launch.objectId}</Id></Fact>
            <Fact term="Recorded route">
              {venueName(fresh.route.venue)} · {fresh.route.supported ? "supported here" : `not supported here: ${fresh.route.reason}`}
            </Fact>
          </Facts>
        ) : (
          <p className={styles.note}>
            {page.fresh.status === "unavailable"
              ? page.fresh.reason
              : "The Sui node does not show a launch of this deployment at this ID."}{" "}
            Actions stay disabled until it can be read.
          </p>
        )}

      </Group>
      <div className={styles.wide}>
        <DataState state={curveState} subject="launch facts">
          {(curve) => <div className={styles.groups}>{groups.map(({ title, render }) => (
            <Group key={title} title={title}>{render(curve)}</Group>
          ))}</div>}
        </DataState>
      </div>
      {fees ? <div className={styles.wide}>{fees}</div> : null}
    </div>
  );
}
