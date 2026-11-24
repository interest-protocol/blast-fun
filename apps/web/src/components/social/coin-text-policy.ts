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
