import type { PresaleTerms, PresaleTermsReader } from "@blast/core/modules/presale/terms/index.ts";

/**
 * Fully diluted value: the coin's price now × its total supply, from the
 * indexed currency. A fixed-supply presale can fall back to its terms.
 * Market cap uses the same multiplication with circulating supply.
 * Missing price or supply gives null.
 *
 * Read for the page's coins only (a bounded fan-out, each with the reader's
 * timeout), never for the whole candidate set: that is why Discover offers no
 * order or filter by it (`contracts/home.ts`).
 */

export { fdvOf } from "@blast/core/modules/social/prices/valuation.ts";

const ATOMS = /^(0|[1-9][0-9]*)$/;

type PresaleSupplyTerms = Pick<PresaleTerms, "supply" | "burnable">;

/** The sale's original supply is current only for an explicitly fixed currency. */
export function presaleTotalSupply(observed: string | null, terms: PresaleSupplyTerms | undefined | null): string | null {
  return observed ?? (terms?.burnable === false ? terms.supply.total : null);
}

/** Supply terms for the page's sales, with failed reads left out. */
export async function readSupplies(
  terms: PresaleTermsReader,
  presaleIds: readonly string[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, PresaleSupplyTerms>> {
  const supplies = new Map<string, PresaleSupplyTerms>();
  await Promise.all(presaleIds.map(async (presaleId) => {
    try {
      const answer = await terms(presaleId, signal);
      if (answer) supplies.set(presaleId, answer);
    } catch {
      // Unavailable: the coin shows no FDV.
    }
  }));
  return supplies;
}

/** Outstanding vesting uses the same sale-token balance in every market view. */
export function outstandingSaleTokensSql(presaleId: string): string {
  return `SELECT coalesce(sum(v.total - v.claimed), 0)::text AS escrowed
    FROM chain_read_v1.vesting_schedules v
    WHERE v.presale_id = ${presaleId} AND v.asset = 'sale_token'`;
}

/** The total, escrowed and circulating atoms; null without a well-formed total. */
export function supplyOf(total: string | null, escrowed: string | null): Readonly<{ total: string; escrowed: string; circulating: string }> | null {
  if (total === null || !ATOMS.test(total)) return null;
  const held = escrowed !== null && ATOMS.test(escrowed) ? BigInt(escrowed) : 0n;
  const circulating = BigInt(total) - held;
  return { total, escrowed: held.toString(), circulating: (circulating < 0n ? 0n : circulating).toString() };
}
