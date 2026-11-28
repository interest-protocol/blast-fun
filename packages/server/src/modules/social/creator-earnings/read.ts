import { settledAll } from "@blast/server/lib/settled-all.ts";
import { normalizeSuiAddress } from "@mysten/sui/utils";

import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type {
  CreatorEarning,
  CreatorEarnings,
  CreatorVesting,
} from "@blast/core/modules/social/contracts/creator-earnings.ts";
import { vestedAtoms, vestingMsSql, vestingSteps, vestingStepsSql } from "@blast/core/modules/social/contracts/vesting.ts";
import { SHOWN_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { wholeUnits } from "@blast/server/modules/social/happening/read.ts";
import type { CreatorChain } from "@blast/server/modules/social/creator-earnings/chain.ts";
import { readSteps } from "@blast/server/modules/social/read-steps.ts";

const step = readSteps("creator_earnings");

export const CREATOR_EARNINGS_SQL = `SELECT v.vault_id, p.presale_id, coalesce(p.sale_name,'') AS name, coalesce(p.sale_symbol,'') AS symbol,
    coalesce(p.sale_icon_url,'') AS icon_url, p.sale_decimals::int AS decimals, p.quote_symbol, p.quote_decimals::int AS quote_decimals
  FROM chain_read_v1.vaults v JOIN ${SHOWN_PRESALES} p ON p.presale_id = v.origin_id AND v.origin_kind = 'presale'
  WHERE p.lifecycle = 'migrated' AND ($3::text IS NULL OR v.vault_id > $3)
    AND (p.presale_id = ANY($2::text[]) OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(v.fee_split->'routes') r WHERE r->'destination'->>'address' = $1))
  ORDER BY v.vault_id LIMIT 11`;
assertChainReadThroughViews(CREATOR_EARNINGS_SQL);

export const CREATOR_RECEIVED_SQL = `SELECT
    coalesce(sum(c.route_meme_amounts[r.ordinality::int]),0)::text AS meme,
    coalesce(sum(c.route_quote_amounts[r.ordinality::int]),0)::text AS quote
  FROM chain_read_v1.vault_fee_collections c,
    jsonb_array_elements(c.fee_split->'routes') WITH ORDINALITY r(recipient,ordinality)
  WHERE c.vault_id = $1 AND r.recipient->'destination'->>'address' = $2`;

export const CREATOR_VESTINGS_SQL = `SELECT v.schedule_id,v.presale_id,coalesce(p.sale_name,'') AS name,
    CASE WHEN v.asset='quote' THEN p.quote_symbol ELSE coalesce(p.sale_symbol,'') END AS symbol,
    CASE WHEN v.asset='quote' THEN p.quote_decimals ELSE p.sale_decimals END::int AS decimals,
    v.total::text,v.claimed::text,v.start_ms::text,
    ${vestingMsSql("v.start_ms + v.cliff_ms")} AS cliff_end_ms,${vestingMsSql("v.end_ms")} AS end_ms,${vestingStepsSql("v")}
  FROM chain_read_v1.vesting_schedules v JOIN ${SHOWN_PRESALES} p ON p.presale_id=v.presale_id
  WHERE v.beneficiary=$1 AND v.share IN ('token','raise') AND v.claimed<v.total
  ORDER BY v.end_ms,v.schedule_id LIMIT 100`;
assertChainReadThroughViews(CREATOR_VESTINGS_SQL);

type EarningRow = Readonly<{
  vault_id: string;
  presale_id: string;
  name: string;
  symbol: string;
  icon_url: string;
  decimals: number;
  quote_symbol: string;
  quote_decimals: number;
}>;
type VestingRow = Readonly<{
  schedule_id: string;
  presale_id: string;
  name: string;
  symbol: string;
  decimals: number;
  total: string;
  claimed: string;
  start_ms: string;
  cliff_end_ms: string;
  end_ms: string;
  period_ms: string | null;
  periods: string | null;
}>;

function vesting(row: VestingRow, nowMs: number): CreatorVesting {
  const times = {
    start_ms: Number(row.start_ms),
    cliff_end_ms: Number(row.cliff_end_ms),
    end_ms: Number(row.end_ms),
  };
  const unlocked = vestedAtoms(BigInt(row.total), times, nowMs, vestingSteps(row)) - BigInt(row.claimed);
  return {
    schedule_id: row.schedule_id,
    presale_id: row.presale_id,
    name: row.name,
    symbol: row.symbol,
    total: wholeUnits(row.total, row.decimals),
    claimed: wholeUnits(row.claimed, row.decimals),
    claimable: wholeUnits((unlocked > 0n ? unlocked : 0n).toString(), row.decimals),
    end_ms: times.end_ms,
  };
}

async function earning(
  db: ReadableDatabase,
  chain: CreatorChain,
  row: EarningRow,
  sender: string,
  signal?: AbortSignal,
): Promise<CreatorEarning | null> {
  const [collectionResult, residualResult] = await step("transactions", () => settledAll([
    chain.transaction(row.vault_id, sender, "collect_fees", signal),
    chain.transaction(row.vault_id, sender, "claim_residuals", signal),
  ]));
  const collection = collectionResult?.presaleId === row.presale_id ? collectionResult : null;
  const residual = residualResult?.presaleId === row.presale_id ? residualResult : null;
  if (!collection && !residual) return null;
  const routes = collection?.vault.feeSplit.routes;
  const index = routes?.findIndex(({ destination }) =>
    destination.kind === "Address" && normalizeSuiAddress(destination.address) === sender,
  ) ?? -1;
  const share = routes?.[index];
  const amounts = (meme: string, quote: string) => ({
    meme: wholeUnits(meme, row.decimals),
    quote: wholeUnits(quote, row.quote_decimals),
  });
  const preview = collection ? await step("preview", () => chain.preview(collection.kindBytes, sender, signal)) : null;
  const event = preview?.find(
    (entry) => entry.kind === "collect_fees" && entry.vaultId === row.vault_id,
  );
  const meme = event?.routeMemeAmounts[index] ?? "0",
    quote = event?.routeQuoteAmounts[index] ?? "0";
  const payable = BigInt(meme) > 0n || BigInt(quote) > 0n;
  const received = (
    await step("received", () => db.read<{ meme: string; quote: string }>(CREATOR_RECEIVED_SQL, [row.vault_id, sender]))
  ).rows[0] ?? { meme: "0", quote: "0" };
  return {
    presale_id: row.presale_id,
    vault_id: row.vault_id,
    name: row.name,
    symbol: row.symbol,
    icon_url: row.icon_url,
    quote_symbol: row.quote_symbol,
    fee_share_bps: Number(share?.bps ?? 0n),
    collection_status: !collection
      ? "ineligible"
      : preview === null || (event === undefined && preview.length > 0)
        ? "unavailable"
        : payable
          ? "ready"
          : "empty",
    collect: payable ? amounts(meme, quote) : null,
    residuals: residual
      ? amounts(
          residual.vault.ownerMeme.toString(),
          residual.vault.ownerQuote.toString(),
        )
      : null,
    received: amounts(received.meme, received.quote),
  };
}

/** Read only the active signing wallet: every action on screen can be signed by that wallet. */
export async function readCreatorEarnings(
  db: ReadableDatabase,
  chain: CreatorChain,
  sender: string,
  cursor: string | null,
  nowMs: number,
  signal?: AbortSignal,
): Promise<CreatorEarnings> {
  assertChainReadThroughViews(CREATOR_RECEIVED_SQL);
  const owner = normalizeSuiAddress(sender);
  const presales = await step("owned_presales", () => chain.ownedPresales(owner, signal));
  const [sources, schedules] = await settledAll([
    step("sources", () => db.read<EarningRow>(CREATOR_EARNINGS_SQL, [owner, presales, cursor])),
    cursor === null
      ? step("vestings", () => db.read<VestingRow>(CREATOR_VESTINGS_SQL, [owner]))
      : Promise.resolve({ rows: [] as VestingRow[] }),
  ]);
  const rows = sources.rows.slice(0, 10);
  const earnings: CreatorEarning[] = [];
  // Two sources at a time bounds fullnode reads and simulations on a portfolio visit.
  await step("earnings", async () => {
    for (let at = 0; at < rows.length; at += 2) {
      const batch = await settledAll(
        rows.slice(at, at + 2).map((row) => earning(db, chain, row, owner, signal)),
      );
      for (const row of batch) if (row) earnings.push(row);
    }
  });
  return {
    earnings,
    vestings: schedules.rows.map((row) => vesting(row, nowMs)),
    next_cursor: sources.rows.length > 10 ? rows.at(-1)!.vault_id : null,
  };
}
