import { CREATE_MAX_WALLETS } from "@blast/core/web/contracts/create.ts";

const U64_MAX = (1n << 64n) - 1n;
export const ALLOWLIST_FILE_MAX_BYTES = 4 * 1_024 * 1_024;
const MAX_ERRORS = 100;

export type AllowlistRow = Readonly<{ line: number; wallet: string; amount: string; cap: string; sourceAddress: string; sourceAmount: string }>;
export type AllowlistErrorCategory = "address" | "duplicate" | "number" | "zero" | "precision" | "maximum" | "columns" | "header" | "limit" | "empty" | "other";
export type AllowlistRowError = Readonly<{
  line: number;
  field: "Address" | "Amount" | "Row" | "File";
  value: string;
  reason: string;
  category: AllowlistErrorCategory;
}>;
type RowIssue = Omit<AllowlistRowError, "line">;
export type ParsedAllowlist = Readonly<{
  n: number;
  rowCount: number;
  affectedRowCount: number;
  errorCategories: Readonly<Partial<Record<AllowlistErrorCategory, number>>>;
  decimals: number;
  min: number;
  max: number;
  minAmount: string;
  maxAmount: string;
  entries: readonly AllowlistRow[];
  errors: readonly AllowlistRowError[];
  errorCount: number;
  /** Empty when any row is invalid; otherwise caps are exact quote atoms. */
  csv: string;
}>;

function amountCap(amount: string, decimals: number): bigint | Pick<RowIssue, "reason" | "category"> {
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(amount)) return { category: "number", reason: "Invalid number" };
  const [whole, fraction = ""] = amount.split(".");
  if (fraction.length > decimals) return { category: "precision", reason: `Maximum ${decimals} decimal places` };
  const digits = `${whole}${fraction.padEnd(decimals, "0")}`.replace(/^0+/, "") || "0";
  if (digits.length > 20) return { category: "maximum", reason: "Exceeds supported maximum" };
  const cap = BigInt(digits);
  if (cap === 0n) return { category: "zero", reason: "Must be greater than zero" };
  return cap > U64_MAX ? { category: "maximum", reason: "Exceeds supported maximum" } : cap;
}

function readRow(fields: string[], source: string, line: number, decimals: number, seen: Map<string, number>): AllowlistRow | RowIssue {
  if (fields.length !== 2) return { field: "Row", value: source, category: "columns", reason: "Expected two columns: address,amount" };
  const [address, amount] = fields;
  const [sourceAddress, sourceAmount] = source.split(/[,;\t]/);
  const hex = address.match(/^0x([0-9a-f]{1,64})$/i)?.[1];
  if (!hex) return { field: "Address", value: sourceAddress, category: "address", reason: "Invalid Sui address" };
  const wallet = `0x${hex.toLowerCase().padStart(64, "0")}`;
  const duplicate = seen.get(wallet);
  if (duplicate !== undefined) return { field: "Address", value: sourceAddress, category: "duplicate", reason: `Duplicate wallet; first on line ${duplicate}` };
  seen.set(wallet, line);
  const cap = amountCap(amount, decimals);
  return typeof cap !== "bigint" ? { field: "Amount", value: sourceAmount, ...cap } : { line, wallet, amount, cap: cap.toString(), sourceAddress, sourceAmount };
}

/** One address and whole-coin amount per line. Formatting is cleaned; no wallet or amount is discarded. */
export function parseAllowlist(text: string, decimals = 6, symbol = "USDC"): ParsedAllowlist {
  const entries: AllowlistRow[] = [];
  const errors: AllowlistRowError[] = [];
  const errorCategories: Partial<Record<AllowlistErrorCategory, number>> = {};
  const affectedLines = new Set<number>();
  const seen = new Map<string, number>();
  let errorCount = 0;
  let count = 0;
  let first = true;
  let min: AllowlistRow | undefined;
  let max: AllowlistRow | undefined;
  const fail = (line: number, issue: RowIssue, dataRow = true) => {
    errorCount += 1;
    errorCategories[issue.category] = (errorCategories[issue.category] ?? 0) + 1;
    if (dataRow) affectedLines.add(line);
    if (errors.length < MAX_ERRORS) errors.push({ line, ...issue });
  };
  text.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/).forEach((line, index) => {
    if (!line.trim()) return;
    const fields = line.split(/[,;\t]/).map((part) => part.trim().replace(/^"([^"\r\n]*)"$/, "$1").trim());
    const [address = "", amount = ""] = fields;
    const header = first && fields.length === 2 && /^(address|wallet)$/i.test(address);
    first = false;
    if (header) {
      if (amount.toLowerCase() !== "amount" && amount.toUpperCase() !== symbol) fail(index + 1, { field: "File", value: line, category: "header", reason: `Use the header address,amount. Amounts are in ${symbol}.` }, false);
      return;
    }
    count += 1;
    if (count > CREATE_MAX_WALLETS) return fail(index + 1, { field: "Row", value: line, category: "limit", reason: `Maximum ${CREATE_MAX_WALLETS.toLocaleString("en-US")} wallets` });
    const entry = readRow(fields, line, index + 1, decimals, seen);
    if (!("wallet" in entry)) return fail(index + 1, entry);
    entries.push(entry);
    if (!min || BigInt(entry.cap) < BigInt(min.cap)) min = entry;
    if (!max || BigInt(entry.cap) > BigInt(max.cap)) max = entry;
  });
  if (count === 0 && errorCount === 0) fail(1, { field: "File", value: "", category: "empty", reason: "Add at least one wallet and its contribution limit" }, false);
  return {
    n: entries.length, rowCount: count, affectedRowCount: affectedLines.size, errorCategories, decimals,
    min: Number(min?.amount ?? 0), max: Number(max?.amount ?? 0),
    minAmount: min?.amount ?? "0", maxAmount: max?.amount ?? "0", entries, errors, errorCount,
    csv: errorCount ? "" : `wallet,cap\n${entries.map((entry) => `${entry.wallet},${entry.cap}`).join("\n")}\n`,
  };
}
