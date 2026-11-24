import { exactAtoms, groupedExact } from "@blast/core/web/exact-amount.ts";
import type { PresaleListStatus, SocialPresaleSummary } from "@blast/core/web/contracts/presales.ts";

/** Two decimals normally; reveal small positive ratios and overflow near 100%. Null without a target. */
function fundingPercentage(raised: bigint, target: bigint): string | null {
  if (target <= 0n) return null;
  const scaled = raised * 100_000_000n / target;
  if (raised > target && scaled === 100_000_000n) return ">100%";
  if (raised > 0n && scaled === 0n) return "<0.000001%";
  let digits = 2;
  while (digits < 6) {
    const visible = scaled / 10n ** BigInt(6 - digits);
    if (visible > 0n && !(raised > target && visible === 100n * 10n ** BigInt(digits))) break;
    digits++;
  }
  const shown = scaled / 10n ** BigInt(6 - digits);
  const divisor = 10n ** BigInt(digits);
  const fraction = String(shown % divisor).padStart(digits, "0").replace(/0+$/, "");
  return `${shown / divisor}${fraction ? `.${fraction}` : ""}%`;
}

/** Discovery uses committed quote atoms against raise_target, never rounded USD or fill_bps. */
export function catalogFunding(sale: SocialPresaleSummary) {
  const raised = BigInt(sale.raised_atoms);
  const target = BigInt(sale.target_atoms);
  const over = target > 0n && raised > target;
  const amount = exactAtoms(sale.raised_atoms, sale.quote_decimals)!;
  const goal = exactAtoms(sale.target_atoms, sale.quote_decimals)!;
  let digits = Math.min(sale.quote_decimals, raised > 0n && raised < 10n ** BigInt(sale.quote_decimals) ? 6 : 2);
  // Reveal the difference instead of printing identical amounts near the funding target.
  while (target > 0n && raised !== target && digits < sale.quote_decimals && groupedExact(amount, digits, "floor") === groupedExact(goal, digits, "floor")) digits++;
  if (target > 0n && target < 10n ** BigInt(sale.quote_decimals)) digits = sale.quote_decimals;
  const committed = groupedExact(amount, digits, "floor");
  const unit = ` ${sale.quote_symbol}`;
  const tiny = raised > 0n && committed === "0";
  const minimum = digits ? `0.${"0".repeat(digits - 1)}1` : "1";
  const committedAmount = tiny ? `<${minimum}` : committed;
  const targetAmount = groupedExact(goal, Math.min(sale.quote_decimals, Math.max(2, digits)), "floor");
  const percentage = fundingPercentage(raised, target);
  const funded = percentage === null ? "funding percentage unavailable" : `${percentage.replace("<", "less than ").replace(">", "more than ").replace("%", " percent")} funded`;
  return {
    committedAmount,
    targetAmount,
    targetDescription: `${groupedExact(goal, sale.quote_decimals)}${unit} target.`,
    description: `${groupedExact(amount, sale.quote_decimals)}${unit} raised of a ${groupedExact(goal, sale.quote_decimals)}${unit} target, ${funded}.`,
    committed: `${committedAmount}${unit}`,
    target: `${targetAmount}${unit}`,
    percentage,
    progress: target > 0n ? Math.min(100, Number(raised * 1_000_000n / target) / 10_000) : 0,
    over,
  };
}

export function catalogStatus(sale: SocialPresaleSummary, now: number): PresaleListStatus {
  if (sale.phase === "pending") return "upcoming";
  return sale.phase === "open" && sale.end_ms > now ? "live" : "ended";
}

/** Time left as a label and a value ("Ends in", "6h 13m"); no label when there is no countdown ("Ended"). */
export function catalogCountdown(sale: SocialPresaleSummary, now: number): Readonly<{ label: "Ends in" | "Starts in" | null; value: string }> {
  if (sale.phase !== "pending" && catalogStatus(sale, now) === "ended") return { label: null, value: "Ended" };
  const to = sale.phase === "pending" ? sale.start_ms : sale.end_ms;
  if (to <= now) return { label: null, value: sale.phase === "pending" ? (to > 0 ? "Awaiting opening" : "Start time to be announced") : "Ended" };
  const minutes = Math.ceil((to - now) / 60_000);
  const hours = Math.floor(minutes / 60);
  const remaining = hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
  return { label: sale.phase === "pending" ? "Starts in" : "Ends in", value: remaining };
}

export function catalogTime(sale: SocialPresaleSummary, now: number): string {
  const { label, value } = catalogCountdown(sale, now);
  return label ? `${label} ${value}` : value;
}

export function searchPresales(rows: readonly SocialPresaleSummary[], search: string) {
  const query = search.trim().toLocaleLowerCase("en-US");
  return rows.filter(sale => [sale.name, sale.symbol, sale.presale_id].some(value => value.toLocaleLowerCase("en-US").includes(query)));
}

/** Configuration badges only appear when the contract read established the fact. A verified team shows the pink mark after the name instead. */
export function catalogTags(sale: SocialPresaleSummary): readonly string[] {
  const aboveTarget = BigInt(sale.target_atoms) > 0n && BigInt(sale.raised_atoms) > BigInt(sale.target_atoms);
  return [
    ...(sale.allowlisted === true ? ["Allowlist"] : []),
    ...(aboveTarget ? ["Above target"] : []),
    ...(sale.audited ? ["Audited"] : []),
  ];
}

export function fundingCap(sale: Pick<SocialPresaleSummary, "target_atoms" | "quote_decimals" | "quote_symbol">): string | null {
  const target = exactAtoms(sale.target_atoms, sale.quote_decimals);
  return target === null || target.n <= 0n ? null : `${groupedExact(target, sale.quote_decimals)} ${sale.quote_symbol}`;
}
