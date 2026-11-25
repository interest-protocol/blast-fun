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

/*
 * Coins that may launch and trade but are never auto-highlighted on Home and Bonding:
 * coins about the founder, Adeniyi Abiodun (@EmanAbio), and sexual coins.
 */

/** A word starting with one of these. */
const HIGHLIGHT_HIDDEN_PREFIXES = ["aden", "eman", "abio"];

/** A whole word, or its plural. Short or common words go here so "Essex", "grape" and "peacock" stay highlightable. */
const HIGHLIGHT_HIDDEN_WORDS = new Set([
  "anal", "anus", "ass", "bdsm", "boob", "boobie", "booby", "busty", "cock", "cum", "cunt", "dick", "dik",
  "erection", "fap", "fetish", "fuk", "hoe", "horny", "hooker", "jizz", "kinky", "loli", "naked", "nip", "nipple",
  "nude", "nudity", "orgy", "pedo", "penis", "pervert", "rape", "rapist", "seggs", "semen", "sex", "sexy", "slut",
  "sperm", "stripper", "thot", "tit", "titty", "tittie", "twat", "vagina", "wank", "wanker", "whore", "xxx",
]);

/** Anywhere, even across words ("TheAdeniyi", "eman abio", "Jerk Off"). */
const HIGHLIGHT_HIDDEN_JOINED = ["adeniyi", "emanabio", "abiodun", "theaden", "theeman", "jerkoff"];

/** Inside any word ("PornCoin") or across spelled-out letters ("p o r n"). Only fragments no ordinary word contains. */
const HIGHLIGHT_HIDDEN_FRAGMENTS = [
  "porn", "hentai", "nsfw", "onlyfans", "blowjob", "handjob", "rimjob", "titjob", "footjob", "deepthroat",
  "cumshot", "creampie", "gangbang", "bukkake", "threesome", "dildo", "orgasm", "masturbat", "pussy",
  "fuck", "milf", "pedophil", "lolicon", "incest", "sexting", "camgirl", "bussy", "boobies", "titties", "pussie", "sexx",
];

/** Whether the auto-picked Home and Bonding highlight may show this coin: no slur, no founder name, nothing sexual. */
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
  // Runs of single letters joined ("p o r n" → "porn"), so a fragment never spans two real words ("Tamil Finance").
  const spelled = words.map((word) => (word.length === 1 ? word : " ")).join("").split(" ");
  return HIGHLIGHT_HIDDEN_JOINED.some((term) => joined.includes(term))
    || [...words, ...spelled].some((word) =>
      HIGHLIGHT_HIDDEN_FRAGMENTS.some((fragment) => word.includes(fragment))
      || [word, word.replace(/s$/u, ""), word.replace(/es$/u, "")].some((form) => HIGHLIGHT_HIDDEN_WORDS.has(form))
      || HIGHLIGHT_HIDDEN_PREFIXES.some((prefix) => word.startsWith(prefix)));
}

function hasBlockedWord(text: string): boolean {
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.some((word) => BLOCKED_COIN_TERMS.has(word.replace(/s$/u, "")));
}

function normalizeCoinText(text: string): string {
  return text.normalize("NFKD").toLowerCase()
    .replace(/[\p{M}\p{Cf}]/gu, "")
    .replaceAll("0", "o")
    .replaceAll("1", "i")
    .replaceAll("3", "e")
    .replaceAll("4", "a");
}
