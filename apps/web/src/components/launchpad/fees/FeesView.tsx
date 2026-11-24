import { shortAddress as shortId } from "@blast/core/lib/format.ts";
import { CoinAmount } from "#web/components/blast-ui/CoinAmount.tsx";
import { Button } from "#web/components/blast-ui/Button.tsx";
import type { ReactNode } from "react";

import type { CurveParty, LaunchRewards, Pair, Share, VaultParty, VaultRewards } from "#web/modules/launchpad-contract/browser-rewards.ts";

import { Fact, Facts } from "../coin/Facts";
import { formatAmountShort, formatQuantity } from "../coin/coin-format";
import { describeReason } from "../coin/coin-view";
import { provenanceRecord } from "../primitives/provenance";
import { DataState } from "../primitives/DataState";
import { DataTable, type DataTableColumn } from "../primitives/DataTable";
import type { SectionState } from "../primitives/data-state";
import primitives from "../primitives/primitives.module.css";
import styles from "./Fees.module.css";
import { feesDisplay, type FeesState, type FeesView as FeesFigures } from "./fees-model";

/** The coin's and its Quote's symbols and decimals; unknown decimals omit the amount. */
export type FeeUnits = Readonly<{
  symbol: string;
  memeDecimals: number | null;
  coinType?: string | null;
  iconUrl?: string | null;
  quoteSymbol: string;
  quoteDecimals: number | null;
  quoteType?: string | null;
}>;

export type FeesViewProps = Readonly<{
  launchId: string;
  state: FeesState;
  units: FeeUnits;
  pending: boolean;
  onRefresh: () => void;
}>;

type Coin = "meme" | "quote" | "sui";

/** SUI's decimals: Blast's creation fee is in SUI whatever the launch's Quote. */
const SUI_DECIMALS = 9;

function unitOf(units: FeeUnits, coin: Coin): Readonly<{ symbol: string; decimals: number | null }> {
  switch (coin) {
    case "meme":
      return { symbol: units.symbol, decimals: units.memeDecimals };
    case "quote":
      return { symbol: units.quoteSymbol, decimals: units.quoteDecimals };
    case "sui":
      return { symbol: "SUI", decimals: SUI_DECIMALS };
  }
}

/** An atomic amount cut to display units, as Overview and Holders show them. */
function quantity(atoms: bigint, units: FeeUnits, coin: Coin): string {
  const { symbol, decimals } = unitOf(units, coin);
  return formatQuantity(atoms, decimals, symbol);
}

/** One row of a ledger's shares table: whose share, in which coin. */
type ShareRow = Readonly<{ key: string; party: string; coin: Coin; share: Share }>;

function shareRows(parties: ReadonlyArray<readonly [string, CurveParty | VaultParty, readonly Coin[]]>): ShareRow[] {
  return parties.flatMap(([party, figures, coins]) =>
    coins.map((coin) => ({ key: `${party}-${coin}`, party, coin, share: (figures as Record<Coin, Share>)[coin] })),
  );
}

function Shares({ caption, rows, units }: Readonly<{ caption: string; rows: readonly ShareRow[]; units: FeeUnits }>) {
  // SUI is Blast's creation fee, and may also be the Quote: the row says which.
  const coinName = (coin: Coin) => (coin === "sui" ? "creation fees (SUI)" : unitOf(units, coin).symbol);
  const columns: DataTableColumn<ShareRow>[] = [
    { header: "Share", cell: (row) => `${row.party}, ${coinName(row.coin)}` },
    { header: "Earned", numeric: true, cell: (row) => quantity(row.share.accrued, units, row.coin) },
    { header: "Claimed", numeric: true, cell: (row) => quantity(row.share.claimed, units, row.coin) },
    { header: "Unclaimed", numeric: true, cell: (row) => quantity(row.share.outstanding, units, row.coin) },
  ];
  // The ledger's heading names the table on screen; the caption names it to a screen reader.
  return <DataTable caption={caption} captionHidden columns={columns} rows={rows} rowKey={(row) => row.key} />;
}

function Partner({ partnerId }: Readonly<{ partnerId: string }>) {
  return (
    <>
      <code className={styles.mono} aria-hidden="true">{shortId(partnerId)}</code>
      <span className={primitives.srOnly}>{partnerId}</span>
    </>
  );
}

/** Facts under a visible label naming them, the same words their list is named by. */
function LabeledFacts({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div className={styles.labeled}>
      <p className={styles.subhead}>{label}</p>
      <Facts label={label}>{children}</Facts>
    </div>
  );
}

function PairFact({ term, pair, units }: Readonly<{ term: string; pair: Pair; units: FeeUnits }>) {
  return (
    <Fact term={term}>
      {quantity(pair.meme, units, "meme")}, {quantity(pair.quote, units, "quote")}
    </Fact>
  );
}

/** The curve's ledger: from creation to migration, then closed as it stands. */
function CurveLedger({ launchId, rewards, units }: Readonly<{ launchId: string; rewards: LaunchRewards; units: FeeUnits }>) {
  const migrated = rewards.vault !== null;
  const rows = shareRows([
    ["Creator", rewards.creator, ["meme", "quote"]],
    ["Blast", rewards.protocol, ["meme", "quote", "sui"]],
  ]);
  return (
    <section className={styles.ledger} aria-labelledby={`${launchId}-fees-curve`}>
      <h4 className={styles.subheading} id={`${launchId}-fees-curve`}>{migrated ? "Bonding curve, until migration" : "Bonding curve"}</h4>
      <p className={styles.note}>
        {migrated
          ? "The creator's and Blast's share of every curve trade, Blast's SUI creation fee and its one-time migration fee. The ledger closed at migration and keeps its totals; what it holds stays claimable."
          : "The creator's and Blast's share of every curve trade, and Blast's SUI creation fee. At migration Blast's one-time migration fee joins its share and the ledger closes."}
        {rewards.partner ? " Blast's claimed amounts include what its claims paid the launch's partner." : null}
      </p>
      <Shares caption={migrated ? "Bonding curve fees until migration" : "Bonding curve fees"} rows={rows} units={units} />
      {rewards.partner ? (
        <LabeledFacts label="Paid to the partner from Blast's curve fees">
          <Fact term="Partner">
            <Partner partnerId={rewards.partner.partnerId} />
          </Fact>
          <Fact term="Paid">
            {quantity(rewards.partner.paidMeme, units, "meme")}, {quantity(rewards.partner.paidQuote, units, "quote")},{" "}
            {quantity(rewards.partner.paidSui, units, "sui")}
          </Fact>
        </LabeledFacts>
      ) : null}
    </section>
  );
}

/** The migration vault's ledger: its LP fees, each share, and what they returned to holders and the coin. */
function VaultLedger({ launchId, vault, units }: Readonly<{ launchId: string; vault: VaultRewards; units: FeeUnits }>) {
  const rows = shareRows([
    ["Creator", vault.creator, ["meme", "quote"]],
    ["Blast", vault.protocol, ["meme", "quote"]],
  ]);
  return (
    <section className={styles.ledger} aria-labelledby={`${launchId}-fees-vault`}>
      <h4 className={styles.subheading} id={`${launchId}-fees-vault`}>Migration vault, since migration</h4>
      <p className={styles.note}>
        The vault collects the venue pool&apos;s LP fees and splits each collection: shares for the creator and Blast, and
        the rest returned to holders and the coin.
        {vault.partner ? " Blast's claimed amounts include what its claims paid the partner." : null}
      </p>
      <Facts label="LP fees collected">
        <PairFact term="Collected" pair={vault.collected} units={units} />
      </Facts>
      <Shares caption="Migration vault fee shares" rows={rows} units={units} />
      {vault.partner ? (
        <LabeledFacts label="Paid to the partner from Blast's LP fees">
          <Fact term="Partner">
            <Partner partnerId={vault.partner.partnerId} />
          </Fact>
          <Fact term="Paid">
            {quantity(vault.partner.paidMeme, units, "meme")}, {quantity(vault.partner.paidQuote, units, "quote")}
          </Fact>
        </LabeledFacts>
      ) : null}
      <LabeledFacts label="Returned to holders and the coin">
        <PairFact term="Holder rewards set aside" pair={vault.returned.rewards} units={units} />
        <PairFact term="Published to reward rounds" pair={vault.deployed.rewardsPublished} units={units} />
        <PairFact term="Liquidity set aside" pair={vault.returned.autoLp} units={units} />
        <PairFact term="Liquidity added" pair={vault.deployed.autoLpAdded} units={units} />
        <PairFact term="Buyback set aside" pair={vault.returned.burn} units={units} />
        <Fact term="Bought back and burned">
          {units.memeDecimals === null ? quantity(vault.deployed.buyback.memeBurned, units, "meme") : (
            <CoinAmount amount={formatAmountShort(vault.deployed.buyback.memeBurned, units.memeDecimals)} symbol={units.symbol} coinType={units.coinType} iconUrl={units.iconUrl} />
          )} for {units.quoteDecimals === null ? quantity(vault.deployed.buyback.quoteSpent, units, "quote") : (
            <CoinAmount amount={formatAmountShort(vault.deployed.buyback.quoteSpent, units.quoteDecimals)} symbol={units.quoteSymbol} coinType={units.quoteType} />
          )}
        </Fact>
        <PairFact term="Paid to fee recipients" pair={vault.returned.recipients} units={units} />
      </LabeledFacts>
    </section>
  );
}

function sectionOf(state: FeesState): SectionState<FeesFigures> {
  const display = feesDisplay(state);
  switch (display.kind) {
    case "loading":
      return { status: "loading" };
    case "unavailable":
      return { status: "unavailable", reason: describeReason(display.reason) };
    case "rewards": {
      const provenance = provenanceRecord(display.view.provenance);
      if (!display.stale) return { status: "ready", value: display.view, provenance };
      const reason =
        display.stale.cause === "failed"
          ? `The last refresh failed: ${describeReason(display.stale.reason)}`
          : `The fees were served while ${describeReason("lagging")}`;
      return { status: "stale", value: display.view, provenance, reason };
    }
  }
}

/** The fees section's frame: its heading, then what it can show. "Fees" alone is the Overview's fee settings. */
export function FeesSection({ launchId, children }: Readonly<{ launchId: string; children: ReactNode }>) {
  return (
    <section className={styles.fees} aria-labelledby={`${launchId}-fees`}>
      <h3 className={styles.heading} id={`${launchId}-fees`}>Fees and payouts</h3>
      <div className={styles.body}>{children}</div>
    </section>
  );
}

/**
 * The coin page's fees: the launch's two ledgers as blast-infra keeps them — the bonding
 * curve's until migration, then the migration vault's — each party's earned, claimed and
 * unclaimed amounts in their own coin, what the partner was paid, and what the vault returned
 * to holders. Nothing is summed across ledgers or priced; an outage keeps the last figures
 * Stale, else Unavailable.
 */
export function FeesView({ launchId, state, units, pending, onRefresh }: FeesViewProps): ReactNode {
  return (
    <FeesSection launchId={launchId}>
      <DataState
        state={sectionOf(state)}
        subject="fees"
        loading="Reading the launch's fees from blast-infra…"
        recovery="Use Refresh fees to try again."
      >
        {(view) => (
          <>
            <CurveLedger launchId={launchId} rewards={view.rewards} units={units} />
            {view.rewards.vault ? <VaultLedger launchId={launchId} vault={view.rewards.vault} units={units} /> : null}
            <p className={styles.note}>Amounts are cut to two decimal places (four significant digits below 1), never rounded up.</p>
          </>
        )}
      </DataState>
      <Button className={styles.refresh} loading={pending} loadingLabel="Refreshing fees" onClick={onRefresh} size="sm">
        Refresh fees
      </Button>
    </FeesSection>
  );
}
