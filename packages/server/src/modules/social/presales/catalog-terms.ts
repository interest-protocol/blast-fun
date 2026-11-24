import type { PresaleTermsSource } from "@blast/server/modules/social/presales/detail.ts";
import type { SocialPresaleSummary } from "@blast/core/modules/social/contracts/presales.ts";

/** Reuse the cached contract reader; a failed terms read must not hide a project. */
export async function withCatalogTerms(sales: readonly SocialPresaleSummary[], terms?: PresaleTermsSource): Promise<SocialPresaleSummary[]> {
  if (!terms) return [...sales];
  const readTerms = terms;
  const result = [...sales];
  let next = 0;
  // Bound projection fan-out even for a maximum-size page. Preserve the supplied order.
  async function readNext(): Promise<void> {
    const index = next++;
    const sale = sales[index];
    if (!sale) return;
    const contract = await readTerms(sale.presale_id);
    result[index] = { ...sale, hard_cap: contract?.hardCap ?? null };
    return readNext();
  }
  await Promise.all(Array.from({ length: Math.min(8, sales.length) }, readNext));
  return result;
}
