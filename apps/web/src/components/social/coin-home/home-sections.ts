/**
 * Home's sections (coins, bonding curves, posts and traders, the Main board's
 * order): each movable
 * and hideable from the Sections menu. The order and the hidden sections are **per device**, in
 * one cookie, `blast.home`, so the server lays the page out in the saved
 * order and reads nothing for a hidden section (its query never runs in the
 * browser either). The value is the order as the keys joined by `.`, a
 * hidden section marked with a leading `-`: `traders.coins.-posts`.
 * Anything malformed reads as the default: every section showing, coins
 * first. This file is pure except for the store at its end, so every rule is
 * unit-tested without a browser.
 */

export const HOME_SECTIONS = ["coins", "bonding", "posts", "traders"] as const;

export type HomeSectionKey = (typeof HOME_SECTIONS)[number];

export const HOME_SECTION_TITLES: Readonly<Record<HomeSectionKey, string>> = {
  coins: "Coins",
  bonding: "Bonding Curves",
  traders: "PnL leaderboard",
  posts: "Posts",
};

export const HOME_SECTIONS_COOKIE = "blast.home";

/** A year: the cookie outlives a session, as the shell's other device choices do. */
export const HOME_SECTIONS_COOKIE_MAX_AGE_S = 365 * 24 * 3_600;

export type HomeSectionPrefs = Readonly<{
  /** Every section, in the device's order (hidden ones keep their place). */
  order: readonly HomeSectionKey[];
  hidden: readonly HomeSectionKey[];
}>;

export const HOME_SECTIONS_DEFAULT: HomeSectionPrefs = Object.freeze({ order: HOME_SECTIONS, hidden: Object.freeze([]) });

const isKey = (value: string): value is HomeSectionKey => (HOME_SECTIONS as readonly string[]).includes(value);

/**
 * The cookie's value as the preferences: known keys only, de-duplicated,
 * and missing sections filled in. The retired Presales section (`presales`,
 * now part of Trending) is dropped; an older order without Bonding Curves
 * gains it where Presales stood, or at the end.
 */
export function parseHomeSections(value: string | null | undefined): HomeSectionPrefs {
  if (!value) return HOME_SECTIONS_DEFAULT;
  const seen = new Set<HomeSectionKey>();
  const order: HomeSectionKey[] = [];
  const hidden: HomeSectionKey[] = [];
  let presalesAt: number | null = null;
  for (const part of value.split(".")) {
    const key = part.startsWith("-") ? part.slice(1) : part;
    if (key === "presales") presalesAt ??= order.length;
    if (!isKey(key) || seen.has(key)) continue;
    order.push(key);
    seen.add(key);
    if (part.startsWith("-")) hidden.push(key);
  }
  if (!seen.has("bonding")) order.splice(presalesAt ?? order.length, 0, "bonding");
  for (const key of HOME_SECTIONS) if (!seen.has(key) && key !== "bonding") order.push(key);
  return normalize({ order, hidden });
}

/** The preferences as the cookie's value; empty for the default (the cookie is then dropped). */
export function serializeHomeSections(prefs: HomeSectionPrefs): string {
  if (isDefaultHomeSections(prefs)) return "";
  const hidden = new Set(prefs.hidden);
  return prefs.order.map((key) => (hidden.has(key) ? `-${key}` : key)).join(".");
}

export function isDefaultHomeSections(prefs: HomeSectionPrefs): boolean {
  return prefs.hidden.length === 0 && prefs.order.length === HOME_SECTIONS.length &&
    prefs.order.every((key, index) => key === HOME_SECTIONS[index]);
}

function normalize(prefs: HomeSectionPrefs): HomeSectionPrefs {
  const hidden = new Set(prefs.hidden);
  const frozen: HomeSectionPrefs = { order: Object.freeze([...prefs.order]), hidden: Object.freeze(HOME_SECTIONS.filter((key) => hidden.has(key))) };
  return isDefaultHomeSections(frozen) ? HOME_SECTIONS_DEFAULT : Object.freeze(frozen);
}

/** The sections showing, in order. */
export function shownHomeSections(prefs: HomeSectionPrefs): readonly HomeSectionKey[] {
  return prefs.order.filter((key) => isHomeSectionShown(prefs, key));
}

export function isHomeSectionShown(prefs: HomeSectionPrefs, key: HomeSectionKey): boolean {
  return !prefs.hidden.includes(key);
}

/**
 * `key` one slot up (`-1`) or down (`+1`) among the sections showing, the
 * hidden ones keeping their place. At either end nothing moves and the same
 * object comes back (so nothing is announced or written).
 */
export function moveHomeSection(prefs: HomeSectionPrefs, key: HomeSectionKey, delta: -1 | 1): HomeSectionPrefs {
  const shown = shownHomeSections(prefs);
  const from = shown.indexOf(key);
  return placeHomeSection(prefs, key, from + delta);
}

/** `key` placed at `to` among the sections showing; `to` is clamped. */
export function placeHomeSection(prefs: HomeSectionPrefs, key: HomeSectionKey, to: number): HomeSectionPrefs {
  const shown = shownHomeSections(prefs);
  const from = shown.indexOf(key);
  if (from < 0) return prefs;
  const target = Math.max(0, Math.min(shown.length - 1, to));
  if (target === from) return prefs;
  const moved = [...shown];
  moved.splice(from, 1);
  moved.splice(target, 0, key);
  return normalize({ order: mergeHidden(moved, prefs.order), hidden: prefs.hidden });
}

/** A new shown order, with every section it does not name put back at its old index. */
function mergeHidden(shown: readonly HomeSectionKey[], previous: readonly HomeSectionKey[]): readonly HomeSectionKey[] {
  const order = [...shown];
  const known = new Set(shown);
  previous.forEach((key, index) => {
    if (!known.has(key)) {
      order.splice(Math.min(index, order.length), 0, key);
      known.add(key);
    }
  });
  return order;
}

/** `key` hidden or shown; the same object when nothing changes. */
export function setHomeSectionShown(prefs: HomeSectionPrefs, key: HomeSectionKey, shown: boolean): HomeSectionPrefs {
  if (isHomeSectionShown(prefs, key) === shown) return prefs;
  return normalize({ order: prefs.order, hidden: shown ? prefs.hidden.filter((other) => other !== key) : [...prefs.hidden, key] });
}

/** The cookie's value out of a `document.cookie` string (null when absent). */
export function homeSectionsCookieValue(cookieHeader: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${HOME_SECTIONS_COOKIE}=`)) return trimmed.slice(HOME_SECTIONS_COOKIE.length + 1);
  }
  return null;
}

/** The `Set-Cookie` line the browser writes: a year on the whole site, same-site, secure where the page is. */
export function homeSectionsCookieLine(prefs: HomeSectionPrefs, secure: boolean): string {
  const value = serializeHomeSections(prefs);
  const flags = `; Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;
  return value === "" ? `${HOME_SECTIONS_COOKIE}=; Max-Age=0${flags}` : `${HOME_SECTIONS_COOKIE}=${value}; Max-Age=${HOME_SECTIONS_COOKIE_MAX_AGE_S}${flags}`;
}
