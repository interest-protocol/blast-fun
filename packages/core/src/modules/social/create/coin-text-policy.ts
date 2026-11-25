const BLOCKED_COIN_TERMS = new Set([
  "gook",
  "kike",
  "nigga",
  "nigger",
  "raghead",
  "sandnigger",
  "spic",
  "spick",
  "towelhead",
  "wetback",
  "zipperhead",
]);

const COIN_TEXT_FIELDS = [
  ["name", "name"],
  ["symbol", "ticker"],
  ["description", "description"],
  ["tagline", "short description"],
] as const;

type CoinTextField = (typeof COIN_TEXT_FIELDS)[number][0];
type CoinText = Readonly<{ name: string; symbol: string; description?: string; tagline: string }>;

export function coinTextIssues(text: CoinText): { path: CoinTextField; message: string }[] {
  return COIN_TEXT_FIELDS.flatMap(([path, label]) => {
    const value = normalizeCoinText(text[path] ?? "");
    if (!hasBlockedWord(value) && !hasBlockedWord(value.replace(/[.*_·-]/gu, ""))) {
      return [];
    }
    return [{ path, message: `Remove the slur from the ${label}.` }];
  });
}

/**
 * Coins about the founder, Adeniyi Abiodun (@EmanAbio), may launch but are never auto-highlighted.
 * A word starting with one of these prefixes, or the full name anywhere ("TheAdeniyi", "eman abio").
 */
const HIGHLIGHT_HIDDEN_PREFIXES = ["aden", "eman", "abio"];
const HIGHLIGHT_HIDDEN_NAMES = ["adeniyi", "emanabio", "abiodun"];

/** Whether the auto-picked Home and Bonding highlight may show this coin: no slur and no founder name. */
export function isHighlightable(coin: Readonly<{ name: string | null; symbol: string | null }>): boolean {
  return [coin.name, coin.symbol].every((field) => {
    const value = normalizeCoinText(field ?? "");
    return !isHiddenFromHighlight(value) && !isHiddenFromHighlight(value.replace(/[.*_·-]/gu, ""));
  });
}

function isHiddenFromHighlight(text: string): boolean {
  if (hasBlockedWord(text)) return true;
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  const joined = words.join("");
  return words.some((word) => HIGHLIGHT_HIDDEN_PREFIXES.some((prefix) => word.startsWith(prefix)))
    || HIGHLIGHT_HIDDEN_NAMES.some((name) => joined.includes(name));
}

function hasBlockedWord(text: string): boolean {
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.some((word) => BLOCKED_COIN_TERMS.has(word.replace(/s$/u, "")));
}

function normalizeCoinText(text: string): string {
  return text.normalize("NFKD").toLowerCase()
    .replace(/[\p{M}\p{Cf}]/gu, "")
    .replaceAll("1", "i")
    .replaceAll("3", "e")
    .replaceAll("4", "a");
}
