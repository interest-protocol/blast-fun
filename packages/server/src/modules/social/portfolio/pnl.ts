import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { SocialAccountWallet } from "@blast/core/modules/social/contracts/me.ts";
import type { CostBasisFigures } from "@blast/core/modules/social/contracts/portfolio.ts";
import type { PnlAsset, PnlFigures, SocialPnl } from "@blast/core/modules/social/contracts/pnl.ts";
import { readWalletHoldings, walletHoldingValue, type WalletHolding, type WalletHoldings } from "@blast/server/modules/social/portfolio/wallet-holdings.ts";
import { BLAST_LAUNCH_COINS } from "@blast/server/modules/social/read-model/blast-launch-coins.ts";
import { readPnlLedger } from "@blast/server/modules/social/portfolio/pnl-ledger.ts";
import { coinBasisFigures, costBasisBook, type CostBasisLedger } from "@blast/server/modules/social/portfolio/cost-basis.ts";

type AssetMetadata = Readonly<{ presale_id: string | null; launch_id?: string | null; coin_type: string; symbol: string; icon_url: string | null; decimals: number }>;
export type PnlAssetMetadata = AssetMetadata;
const UNKNOWN: PnlFigures = Object.freeze({ realized_usd: null, unrealized_usd: null, total_usd: null });
const USD_UNIT = 10n ** 18n;

/** Integer USD units (10^-18) to signed cents, half away from zero. */
function usd(absoluteUnits: bigint): string {
  const negative = absoluteUnits < 0n;
  const magnitude = negative ? -absoluteUnits : absoluteUnits;
  const cents = (magnitude + USD_UNIT / 200n) / (USD_UNIT / 100n);
  const digits = cents.toString().padStart(3, "0");
  return `${negative && cents !== 0n ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/** Add displayed cents exactly; any unknown component makes the total unknown. */
function sum(values: readonly (string | null)[]): string | null {
  let cents = 0n;
  for (const value of values) {
    if (value === null) return null;
    cents += BigInt(value.replace(".", ""));
  }
  return usd(cents * (USD_UNIT / 100n));
}

function unrealizedPnl(figures: CostBasisFigures, holding: WalletHolding | undefined, tracked: bigint, nowMs: number): string | null {
  if (tracked === 0n) return "0.00";
  if (!holding || !figures.basis_complete || figures.basis_usd === null) return null;
  const value = walletHoldingValue({ ...holding, balance: tracked.toString() }, nowMs);
  return sum([value, `-${figures.basis_usd}`]);
}

function launchIdentity(item: AssetMetadata): Pick<PnlAsset, "presale_id" | "launch_id"> {
  return { presale_id: item.presale_id, ...(item.launch_id ? { launch_id: item.launch_id } : {}) };
}

function hasCompleteHistory(ledger: CostBasisLedger, wallet: WalletHoldings): boolean {
  return !ledger.truncated && ledger.rows.every((row) => row.accounting_complete !== false) && wallet.sync.status === "ready";
}

function completeBasisUsd(figures: CostBasisFigures): string | null {
  return figures.basis_complete ? figures.basis_usd : null;
}

/** Pure accounting shared by the owner and opt-in profile reads. */
export function lifetimePnl(ledger: CostBasisLedger, wallet: WalletHoldings, metadata: readonly PnlAssetMetadata[], nowMs: number): SocialPnl {
  const book = costBasisBook(ledger);
  const holdings = new Map(wallet.holdings.map((holding) => [holding.coin_type, holding]));
  const historyComplete = hasCompleteHistory(ledger, wallet);
  const assets: PnlAsset[] = [];
  for (const item of metadata) {
    const assetId = item.launch_id ?? item.presale_id!;
    const state = book.coins.get(assetId);
    if (!state) continue;
    const holding = holdings.get(item.coin_type);
    const balance = BigInt(holding?.balance ?? "0");
    const tracked = balance < state.tracked ? balance : state.tracked;
    const figures = coinBasisFigures(book, assetId, { balance: tracked.toString(), decimals: item.decimals, price: holding?.price ?? null }, nowMs);
    // shortcut: transfers are reconciled at the current balance; replay transfer events before attributing PNL across intervening external transfers.
    const accounted = historyComplete && balance >= state.tracked;
    const realized = accounted && state.realised !== null ? usd(state.realised) : null;
    const unrealized = accounted ? unrealizedPnl(figures, holding, tracked, nowMs) : null;
    assets.push({
      ...launchIdentity(item), coin_type: item.coin_type, symbol: item.symbol, icon_url: item.icon_url || null,
      tracked_balance: tracked.toString(), basis_usd: accounted ? completeBasisUsd(figures) : null,
      realized_usd: realized, unrealized_usd: unrealized, total_usd: sum([realized, unrealized]),
    });
  }
  return {
    scope: "indexed_sale_coins", period: "since_launch", assets,
    totals: historyComplete ? {
      realized_usd: sum(assets.map((asset) => asset.realized_usd)),
      unrealized_usd: sum(assets.map((asset) => asset.unrealized_usd)),
      total_usd: sum(assets.map((asset) => asset.total_usd)),
    } : UNKNOWN,
    history_complete: historyComplete, wallet_sync: wallet.sync,
  };
}

/** The Blast launches named by a wallet's indexed history. */
export function pnlAssetIds(ledger: CostBasisLedger): readonly string[] {
  return [...new Set(ledger.rows.map((row) => row.presale_id))];
}

/** The Blast launches' coin identities, for the assets a ledger names (Home's traders read the same). */
export async function readPnlAssets(db: ReadableDatabase, ids: readonly string[]): Promise<readonly PnlAssetMetadata[]> {
  if (ids.length === 0) return [];
  return (await db.read<AssetMetadata>(`SELECT presale_id, launch_id, coin_type, symbol, icon_url, decimals::int
    FROM ${BLAST_LAUNCH_COINS} c WHERE asset_id = ANY($1::text[]) ORDER BY coin_type`, [ids])).rows;
}

export async function readLifetimePnl(db: ReadableDatabase, wallets: readonly SocialAccountWallet[], nowMs: number): Promise<SocialPnl> {
  const [ledger, wallet] = await Promise.all([
    readPnlLedger(db, wallets.map((wallet) => wallet.address)),
    readWalletHoldings(db, wallets.map((wallet) => wallet.address)),
  ]);
  return lifetimePnl(ledger, wallet, await readPnlAssets(db, pnlAssetIds(ledger)), nowMs);
}
