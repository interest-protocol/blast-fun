import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { PortfolioPositionStatus } from "@blast/core/modules/social/contracts/portfolio.ts";
import type { MeHoldingCoin, MePresalePosition, MeVesting, ProfileMutual, SocialMePresales, SocialProfileMutuals } from "@blast/core/modules/social/contracts/profile-page.ts";
import { vestedAtoms, vestingSteps } from "@blast/core/modules/social/contracts/vesting.ts";
import { readCreatedPresaleIds } from "@blast/server/modules/social/profiles/created-presales.ts";
import { costBasisFiguresOf, readCostBasisLedgerOrNull } from "@blast/server/modules/social/portfolio/cost-basis.ts";
import { readSaleCoinHoldings, readVestingSchedules, saleCoinValueUsd } from "@blast/server/modules/social/portfolio/holdings.ts";
import { readAccountAddresses } from "@blast/server/modules/social/accounts/read-wallet-addresses.ts";
import { readWatchlistEntries } from "@blast/server/modules/social/watchlist/store.ts";
import { atomsToUsd, isFreshPrice } from "@blast/core/modules/social/portfolio/read.ts";
import { presalePrices } from "@blast/server/modules/social/profiles/calls.ts";
import { readPresaleFacts, type PresaleFacts } from "@blast/server/modules/social/profiles/presales.ts";
import { readSteps } from "@blast/server/modules/social/read-steps.ts";

/**
 * The profile page's viewer reads: who of the people the viewer follows
 * follows this account ("Followed by …", §6.1), and the viewer's own presales
 * for the right column (§5.5: "In right now", "Watchlist", "Backed
 * together"). Both answer only the signed-in viewer and are never cached.
 */

type MutualRow = ProfileMutual & { total: number };

/**
 * Accounts the viewer follows that follow the target, newest follow first.
 * The viewer's follows come from its primary-key prefix; each candidate's
 * follow of the target is a primary-key lookup. Private accounts are left
 * out (they share nothing on Blast, follows included), and so is a private
 * target: who follows it is its owner's alone to see. The total is counted
 * before the limit.
 */
const MUTUALS_SQL = `
  SELECT i.callsign, i.display_name, i.avatar_url, (count(*) OVER ())::int AS total
  FROM social_account_callsigns target
  JOIN social_accounts t ON t.account_id = target.account_id AND (t.privacy = 'public' OR t.account_id = $1::uuid)
  JOIN social_follows mine
    ON mine.follower_account_id = $1::uuid AND mine.target_kind = 'account' AND mine.target_id <> target.account_id::text
  JOIN social_follows theirs
    ON theirs.follower_account_id = mine.target_id::uuid AND theirs.target_kind = 'account'
      AND theirs.target_id = target.account_id::text
  JOIN social_accounts a ON a.account_id = mine.target_id::uuid AND a.privacy = 'public'
  JOIN social_account_identities i ON i.account_id = a.account_id
  WHERE target.callsign = $2
  ORDER BY mine.created_at DESC, i.callsign
  LIMIT 3`;

export async function readMutuals(db: ReadableDatabase, viewerId: string, callsign: string): Promise<SocialProfileMutuals> {
  const { rows } = await db.read<MutualRow>(MUTUALS_SQL, [viewerId, callsign]);
  return {
    accounts: rows.map(({ callsign: handle, display_name, avatar_url }) => ({ callsign: handle, display_name, avatar_url })),
    total: rows[0]?.total ?? 0,
  };
}

type PositionRow = { presale_id: string; commitment: string; all_claimed: boolean; claimed_tokens: string | null; refund: string | null };

/** The viewer's wallets' positions, one per presale, newest commit first (the positions primary key is by presale). */
const POSITIONS_SQL = `
  SELECT pp.presale_id, sum(pp.commitment)::text AS commitment, bool_and(pp.claim_digest IS NOT NULL) AS all_claimed,
    sum(pp.claimed_tokens)::text AS claimed_tokens, sum(pp.claimed_quote_refund)::text AS refund
  FROM chain_read_v1.presale_positions pp
  WHERE pp.wallet = ANY($1::text[])
  GROUP BY pp.presale_id
  ORDER BY max(pp.last_commit_ms) DESC NULLS LAST, pp.presale_id DESC
  LIMIT 200`;

/**
 * The watchlist's first rows: starred presales newest first, then followed
 * presales not starred (UI-12, OA-11, OA-17; `watchlist/route.ts`).
 */
const WATCHLIST_ROWS = 50;

const fixed2 = (value: number) => (Math.round(value * 100) / 100).toFixed(2);

/**
 * A position's commitment in USD (R3-40): a USDC sale's at face value (as
 * before), another quote's at the quote's price when at most 120 s old
 * (exact, `atomsToUsd`), else null — never the coin's units read as dollars.
 */
function committedUsdOf(presale: PresaleFacts, atoms: string, units: number, nowMs: number): string | null {
  if (presale.quoteSymbol === "USDC") return fixed2(units);
  const price = presale.quotePrice;
  if (!price || !isFreshPrice({ usd_price: price.text, as_of_ms: price.asOfMs }, nowMs)) return null;
  return atomsToUsd(atoms, presale.quoteDecimals, price.text);
}
/** Whole units of `atoms` as a plain decimal string (up to the coin's decimals, trailing zeros dropped). */
function wholeUnits(atoms: string, decimals: number): string {
  const digits = atoms.replace(/^0+(?=\d)/, "").padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** T-019's position statuses from a presale's profile status and whether every wallet claimed. */
export function positionStatusOf(facts: PresaleFacts, claimed: boolean): PortfolioPositionStatus {
  if (claimed) return "delivered";
  if (facts.presale.status === "trading" || facts.presale.status === "cancelled") return "claimable";
  return facts.presale.status === "open" ? "open" : "closed";
}

export async function readMePresales(db: ReadableDatabase, accountId: string, nowMs: number): Promise<SocialMePresales> {
  const step = readSteps("me_presales");
  const [addresses, watch] = await step("round_1", () => Promise.all([
    readAccountAddresses(db, accountId),
    readWatchlistEntries(db, accountId, { limit: WATCHLIST_ROWS, cursor: null, includeFollows: true }),
  ]));
  const [positions, coins, vestings, ledger, created] = await step("round_2", () => Promise.all([
    addresses.length ? step("positions", () => db.read<PositionRow>(POSITIONS_SQL, [addresses])).then((result) => result.rows) : [],
    addresses.length ? step("coins", () => readSaleCoinHoldings(db, addresses)) : [],
    addresses.length ? step("vestings", () => readVestingSchedules(db, addresses)) : [],
    addresses.length ? step("cost_basis", () => readCostBasisLedgerOrNull(db, addresses)) : { rows: [], truncated: false },
    step("created", () => readCreatedPresaleIds(db, accountId, addresses)),
  ]));
  // R3-32: the same figures `/me/portfolio` answers for each position and coin.
  const basisOf = costBasisFiguresOf(ledger, coins, nowMs);
  const facts = await step("round_3", () => readPresaleFacts(
    db,
    [...positions, ...watch.entries, ...coins, ...vestings].map((row) => row.presale_id).concat(created),
    nowMs,
  ));
  const multipleOf = (presale: PresaleFacts) => presalePrices(presale, nowMs).multiple;
  const valueOf = (presale: PresaleFacts, units: number) => {
    const { current } = presalePrices(presale, nowMs);
    return current === null ? null : fixed2(units * current);
  };
  return {
    created: created.flatMap((id) => {
      const presale = facts.get(id);
      return presale ? [presale.presale] : [];
    }),
    positions: positions.flatMap((row): MePresalePosition[] => {
      const presale = facts.get(row.presale_id);
      if (!presale) return [];
      const units = Number(row.commitment) / 10 ** presale.quoteDecimals;
      const tokens = row.claimed_tokens === null ? null : wholeUnits(row.claimed_tokens, presale.saleDecimals);
      const multiple = multipleOf(presale);
      return [{
        presale: presale.presale,
        committed_usd: committedUsdOf(presale, row.commitment, units, nowMs),
        committed_atoms: row.commitment,
        status: positionStatusOf(presale, row.all_claimed),
        claimed_tokens: tokens,
        refunded_usd: row.refund === null || presale.quoteSymbol !== "USDC" ? null : fixed2(Number(row.refund) / 10 ** presale.quoteDecimals),
        refunded_atoms: row.refund,
        value_usd: tokens === null ? null : valueOf(presale, Number(tokens)),
        multiple: multiple === null ? null : multiple.toFixed(4),
        ...basisOf(row.presale_id),
      }];
    }),
    watchlist: watch.entries.flatMap((row) => {
      const presale = facts.get(row.presale_id);
      return presale ? [presale.presale] : [];
    }),
    coins: coins
      .flatMap((row): MeHoldingCoin[] => {
        const presale = facts.get(row.presale_id);
        if (!presale) return [];
        const quantity = wholeUnits(row.balance, row.decimals);
        const multiple = multipleOf(presale);
        // The portfolio's own value (`holdings.ts`), so the gold card's Tokens and these rows agree.
        return [{
          presale: presale.presale,
          quantity,
          value_usd: saleCoinValueUsd(row, nowMs),
          multiple: multiple === null ? null : multiple.toFixed(4),
          ...basisOf(row.presale_id),
        }];
      })
      .sort((a, b) => Number(b.value_usd ?? -1) - Number(a.value_usd ?? -1) || a.presale.name.localeCompare(b.presale.name)),
    vestings: vestings.flatMap((row): MeVesting[] => {
      const presale = facts.get(row.presale_id);
      if (!presale) return [];
      const times = { start_ms: Number(row.start_ms), cliff_end_ms: Number(row.cliff_end_ms), end_ms: Number(row.end_ms) };
      const total = BigInt(row.total), claimed = BigInt(row.claimed);
      // Nothing unlocks before the cliff ends (OA-18), then whole steps; the claimable part is what vested and was not claimed.
      const vested = vestedAtoms(total, times, nowMs, vestingSteps(row));
      const claimable = vested > claimed ? vested - claimed : 0n;
      const units = (atoms: bigint) => wholeUnits(atoms.toString(), presale.saleDecimals);
      return [{
        schedule_id: row.schedule_id,
        presale: presale.presale,
        total: units(total),
        claimed: units(claimed),
        claimable: units(claimable),
        claimable_usd: valueOf(presale, Number(units(claimable))),
        ...times,
        vested_pct: total > 0n ? Number((vested * 100n) / total) : 0,
      }];
    }),
  };
}
