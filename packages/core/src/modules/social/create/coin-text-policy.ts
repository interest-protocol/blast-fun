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

/** A whole word, or its plural. Short or common words go here so "Essex", "Grape", "Milford" and "Peacock" stay highlightable. */
const HIGHLIGHT_HIDDEN_WORDS = new Set([
  "anal", "anus", "arse", "ass", "asscoin", "boner", "boob", "boobie", "booby", "busty", "clit", "cock", "coom",
  "coomer", "cuck", "cuckold", "cum", "cummy", "cunt", "dick", "dilf", "ecchi", "fap", "fck", "femdom", "fisting",
  "fucc", "fuk", "fuker", "fukin", "futa", "gilf", "hoe", "horny", "kink", "loli", "milf", "naked", "nude", "orgie",
  "orgy", "pedo", "pegging", "pron", "puta", "rape", "raped", "raping", "rapist", "schlong", "sex", "sexi", "sexo",
  "shota", "smut", "sperm", "thot", "tiddie", "tiddy", "tit", "twat", "upskirt", "verga", "wank", "wanker", "xxx", "yiff",
]);

/** Anywhere, even across words: the founder's names ("TheAdeniyi", "eman abio"). */
const HIGHLIGHT_HIDDEN_JOINED = ["adeniyi", "emanabio", "abiodun", "theaden", "theeman"];

/** Two words that make one term ("Blow Job", "Only Fans"); the pair must match whole, so "Jerk Official" stays. */
const HIGHLIGHT_HIDDEN_PAIRS = new Set([
  "blowjob", "buttplug", "camgirl", "creampie", "cumshot", "deepthroat", "footjob", "gangbang", "gloryhole", "handjob",
  "jerkoff", "onlyfan", "rimjob", "sextape", "sextoy", "threesome", "titjob",
]);

/** Inside any word ("PornCoin", "SexCoin") or across spelled-out letters ("p o r n"). Only fragments no ordinary word contains. */
const HIGHLIGHT_HIDDEN_FRAGMENTS = [
  "ahegao", "arsehole", "asshole", "bdsm", "bestiality", "bigdick", "blowjob", "brazzers", "bukkake", "bussy",
  "buttplug", "camgirl", "cameltoe", "chaturbate", "clitor", "cocksuck", "creampie", "cumcoin", "cummies", "cumrocket",
  "cumshot", "cunnilingus", "deepthroat", "dickbutt", "dildo", "ejaculat", "erection", "erotic", "fansly", "fellatio",
  "fetish", "fleshlight", "footjob", "fuck", "futanari", "fvck", "gangbang", "gloryhole", "handjob", "hentai", "incest",
  "jailbait", "jizz", "kinky", "lewd", "lolicon", "masturbat", "molest", "nipple", "nsfw", "nudity", "nympho",
  "onlyfan", "orgasm", "paedophil", "pedofil", "pedophil", "penis", "pervert", "phuck", "porn", "prostitut", "pussie",
  "pussy", "rimjob", "seggs", "sexbot", "sexcoin", "sexdoll", "sexting", "sextape", "sextoy", "sexx", "sexy", "shemale",
  "shotacon", "slut", "stripper", "threesome", "titcoin", "titjob", "tittie", "titty", "vagina", "whore", "xhamster",
  "xvideos", "zoophil",
];

/** Whether the auto-picked Home and Bonding highlight may show this coin: no slur, no founder name, nothing sexual. */
export function isHighlightable(coin: Readonly<{ name: string | null; symbol: string | null }>): boolean {
  return [coin.name, coin.symbol].every((field) => {
    const value = normalizeCoinText(field ?? "").replaceAll("5", "s").replaceAll("7", "t");
    // Dropping separators glues real words ("Tamil-Finance"), so that pass skips the inside-a-word check.
    return !isHiddenFromHighlight(value, true) && !isHiddenFromHighlight(value.replace(/[.*_·-]/gu, ""), false);
  });
}

function isHiddenFromHighlight(text: string, checkFragments: boolean): boolean {
  if (hasBlockedWord(text)) return true;
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  const joined = words.join("");
  // Runs of single letters joined ("p o r n" → "porn"), so a fragment never spans two real words ("Tamil Finance").
  const spelled = words.map((word) => (word.length === 1 ? word : " ")).join("").split(" ");
  const pairs = words.slice(1).map((word, index) => words[index] + word);
  return HIGHLIGHT_HIDDEN_JOINED.some((term) => joined.includes(term))
    || pairs.some((pair) => pluralForms(pair).some((form) => HIGHLIGHT_HIDDEN_PAIRS.has(form)))
    || [...words, ...spelled].some((word) =>
      (checkFragments && HIGHLIGHT_HIDDEN_FRAGMENTS.some((fragment) => word.includes(fragment)))
      || pluralForms(word).some((form) => HIGHLIGHT_HIDDEN_WORDS.has(form))
      || HIGHLIGHT_HIDDEN_PREFIXES.some((prefix) => word.startsWith(prefix)));
}

/** The word, and the word without an English plural ending ("dicks", "hoes", "orgies"). */
function pluralForms(word: string): string[] {
  return [word, word.replace(/s$/u, ""), word.replace(/es$/u, ""), word.replace(/ies$/u, "y")];
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
