import { FIXTURE_PHOTOS } from "../sign-in/fixture-photos.ts";
import type { FeedItem } from "../../../src/modules/social/contracts/items.ts";
import type {
  PresaleMomentumWindow,
  SocialPresaleBacker,
  SocialPresaleDetail,
  SocialPresaleListPage,
  SocialPresaleMomentum,
  SocialPresalePerson,
  SocialPresaleSummary,
  SocialPresaleViewerEntry,
  SocialPresaleViewerResponse,
} from "@blast/core/modules/social/contracts/presales.ts";

import { PRESALE_FIXTURE_PHOTOS } from "./fixture-photos.ts";

/**
 * The canonical UI's sample sales as route payloads, for the development
 * fixture (`/dev/social/presales`) and the pixel comparison only; never
 * imported by application code. Ported from the prototype: its `PRESALES`,
 * named backers, generated crowd (`genBackers` with its seeded random
 * sequence), terms, the viewer Kai's follows and positions, all at a frozen
 * `FIXTURE_NOW`.
 */

export const FIXTURE_NOW = Date.UTC(2026, 9, 3, 18, 0, 0);
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = FIXTURE_NOW;

type Phase = "open" | "pending" | "funded" | "trading" | "cancelled";
type Sale = Readonly<{
  id: string; sym: string; name: string; life: Phase; raised: number; target: number; people: number; interested: number;
  start?: number; end?: number; opens?: number; launched?: number; now?: number; min: number; cap: number;
  supply: number; split: Readonly<{ buyers: number; pool: number; team: number; treasury: number }>;
  raiseSplit: Readonly<{ pool: number; team: number; blast: number }>; vest: Readonly<{ cliff: number; months: number }>; venue: string;
  /** The prototype's trust flags (R3-23), for the dev pages only. */
  verified?: boolean; audited?: boolean;
  /**
   * R3-40: the coin the sale raises (the gate's `quote`; USDC when absent).
   * Every figure of a SUI sale — raised, target, limits, backers, positions —
   * is in SUI; its dollars are at `FIXTURE_SUI_USD`.
   */
  quote?: "SUI";
  /** USD a SUI for this sale's dollars (default `FIXTURE_SUI_USD`); the gate-parity view uses 1 (see `asSuiQuoted`). */
  suiUsd?: number;  /**
   * R3-90: whether the sale stops at its target (the sale-level
   * `hard_cap`, contracts ADR 0110); false when absent, as the gate's
   * `hardCap: null` ("None"). Null: unread, the page's `–` (Tidal and
   * Ondine: the gate's caps, 520k and 240k, sit above their targets, which
   * no sale on chain can have).
   */
  hardCap?: boolean | null;
}>;

/** R3-40: the dev fixtures' SUI price (the gate's `COINS.sui.px`), dated a minute before the frozen clock. */
export const FIXTURE_SUI_USD = 3.42;
export const FIXTURE_SUI_PRICE = { usd_price: "3.42", as_of_ms: Date.UTC(2026, 9, 3, 17, 59) } as const;

const DUTC = (m: number, d: number, h: number, mi = 0) => Date.UTC(2026, m - 1, d, h, mi);

const SALES: readonly Sale[] = [
  { id: "mrdn", sym: "MRDN", name: "Meridian", life: "open", raised: 184221, target: 250000, people: 1012, interested: 3410, start: NOW - 42 * HOUR, end: NOW + 6 * HOUR + 12 * MIN + 41e3, min: 10, cap: 25000, supply: 1e9, split: { buyers: 4500, pool: 3000, team: 2000, treasury: 500 }, raiseSplit: { pool: 7500, team: 2300, blast: 200 }, vest: { cliff: 3, months: 12 }, venue: "cetus", verified: true, audited: true },
  { id: "tide", sym: "TIDE", name: "Tidal", life: "open", raised: 398600, target: 400000, people: 2216, interested: 4020, start: NOW - 70 * HOUR, end: NOW + 80e3, min: 10, cap: 20000, supply: 1e9, split: { buyers: 4000, pool: 3500, team: 2000, treasury: 500 }, raiseSplit: { pool: 8000, team: 1800, blast: 200 }, vest: { cliff: 3, months: 12 }, venue: "cetus", verified: true, hardCap: null },
  { id: "sabl", sym: "SABL", name: "Sable", life: "pending", raised: 0, target: 400000, people: 0, interested: 1840, opens: DUTC(10, 14, 18), min: 25, cap: 20000, supply: 1e9, split: { buyers: 4000, pool: 3500, team: 2000, treasury: 500 }, raiseSplit: { pool: 8000, team: 2000, blast: 0 }, vest: { cliff: 6, months: 18 }, venue: "cetus", verified: true, audited: true },
  { id: "ondn", sym: "ONDN", name: "Ondine", life: "pending", raised: 0, target: 180000, people: 0, interested: 960, opens: DUTC(10, 16, 15), min: 10, cap: 10000, supply: 5e8, split: { buyers: 5000, pool: 3000, team: 1500, treasury: 500 }, raiseSplit: { pool: 7500, team: 2500, blast: 0 }, vest: { cliff: 3, months: 9 }, venue: "bluefin", hardCap: null },
  { id: "cblt", sym: "CBLT", name: "Cobalt", life: "funded", raised: 311400, target: 250000, people: 2140, interested: 5100, start: NOW - 5 * DAY, end: NOW - 3 * HOUR, min: 10, cap: 25000, supply: 5e8, split: { buyers: 5000, pool: 2500, team: 2000, treasury: 500 }, raiseSplit: { pool: 7000, team: 2800, blast: 200 }, vest: { cliff: 3, months: 12 }, venue: "bluefin", verified: true, audited: true },
  { id: "kstl", sym: "KSTL", name: "Kestrel", life: "trading", raised: 225000, target: 225000, people: 1876, interested: 4400, start: NOW - 12 * DAY, end: NOW - 8 * DAY, launched: NOW - 6 * DAY, now: 0.0021, min: 10, cap: 25000, supply: 1e9, split: { buyers: 4500, pool: 3000, team: 2000, treasury: 500 }, raiseSplit: { pool: 7500, team: 2300, blast: 200 }, vest: { cliff: 3, months: 12 }, venue: "cetus", verified: true, audited: true },
  { id: "lumn", sym: "LUMN", name: "Lumen", life: "trading", raised: 160000, target: 160000, people: 1320, interested: 2900, start: NOW - 20 * DAY, end: NOW - 16 * DAY, launched: NOW - 14 * DAY, now: 0.0013, min: 10, cap: 15000, supply: 4e8, split: { buyers: 2000, pool: 3000, team: 3000, treasury: 2000 }, raiseSplit: { pool: 7000, team: 3000, blast: 0 }, vest: { cliff: 1, months: 6 }, venue: "cetus" },
  { id: "hlcn", sym: "HLCN", name: "Halcyon", life: "cancelled", raised: 61200, target: 300000, people: 410, interested: 1300, start: NOW - 9 * DAY, end: NOW - 6 * DAY, min: 10, cap: 10000, supply: 1e9, split: { buyers: 4500, pool: 3000, team: 2500, treasury: 0 }, raiseSplit: { pool: 7500, team: 2500, blast: 0 }, vest: { cliff: 6, months: 24 }, venue: "cetus" },
];

/**
 * R3-40 (dev only; the gate seeds no SUI sale): Driftwood raises SUI and sits
 * at 99.97% of its target, so the floor rule shows in SUI. It joins the lists
 * only when asked (`{ sui: true }`, the dev pages' `?quote=sui`), so the
 * gate's own sample lists, and every pixel comparison against them, are
 * unchanged; its sale page is `?page=sale&sale=drft`.
 */
const SUI_SALE: Sale = { id: "drft", sym: "DRFT", name: "Driftwood", life: "open", raised: 99970, target: 100000, people: 640, interested: 1210, start: NOW - 30 * HOUR, end: NOW + 20 * HOUR + 4 * MIN, min: 25, cap: 5000, supply: 1e9, split: { buyers: 4500, pool: 3000, team: 2000, treasury: 500 }, raiseSplit: { pool: 7500, team: 2300, blast: 200 }, vest: { cliff: 3, months: 12 }, venue: "cetus", verified: true, quote: "SUI" };

/** Every fixture sale, the gate's and the dev SUI sale, by key. */
const ALL_SALES: readonly Sale[] = [...SALES, SUI_SALE];
const saleOf = (key: string) => ALL_SALES.find((sale) => sale.id === key)!;

/**
 * R3-42/R3-41 pixel parity (dev only): a gate sale quoted in SUI exactly as the
 * gate draws one when its `quote` is `SUI` — the same numbers read as SUI, and
 * its people's dollars the same numbers too (the gate keeps `x.usd` beside
 * them), so every string the product draws can be set beside the gate's.
 * `?as=sui` on the dev pages.
 */
export type FixtureSaleOptions = Readonly<{ asSui?: boolean }>;
const variantOf = (key: string, options: FixtureSaleOptions = {}): Sale =>
  options.asSui && saleOf(key).quote === undefined ? { ...saleOf(key), quote: "SUI", suiUsd: 1 } : saleOf(key);

/** Whether the dev lists include the SUI sale. */
export type FixtureQuoteOptions = Readonly<{ sui?: boolean }>;
const listed = (options: FixtureQuoteOptions = {}) => (options.sui ? ALL_SALES : SALES);

/** The prototype's mark colours and shapes, as SVG data URLs. */
const MARK: Readonly<Record<string, readonly [string, string, string]>> = {
  mrdn: ["#ff8fc2", "#c0125e", '<circle cx="24" cy="24" r="12" fill="none" stroke="#fff" stroke-width="2.4"/><ellipse cx="24" cy="24" rx="5.5" ry="12" fill="none" stroke="#fff" stroke-width="2.4"/><path d="M12 24h24" stroke="#fff" stroke-width="2.4"/>'],
  tide: ["#45d0ff", "#1d5fd6", '<path d="M10 20c3-3 6-3 9 0s6 3 9 0 6-3 10 0M10 28c3-3 6-3 9 0s6 3 9 0 6-3 10 0" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>'],
  sabl: ["#5c5b6e", "#141319", '<path d="M24 10 36 21 24 38 12 21z" fill="none" stroke="#fff" stroke-width="2.4" stroke-linejoin="round"/><path d="M12 21h24M19 21l5-11 5 11-5 17z" fill="none" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" opacity=".75"/>'],
  ondn: ["#38e0c2", "#0b7d78", '<path d="M24 10s9 9.5 9 16a9 9 0 0 1-18 0c0-6.5 9-16 9-16z" fill="none" stroke="#fff" stroke-width="2.4"/><circle cx="24" cy="27" r="3.4" fill="#fff"/>'],
  cblt: ["#6b95ff", "#1f3db8", '<path d="M24 10 36 17v14l-12 7-12-7V17z" fill="none" stroke="#fff" stroke-width="2.4" stroke-linejoin="round"/><path d="M12 17l12 7 12-7M24 24v14" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round" opacity=".8"/>'],
  kstl: ["#ffbd5c", "#e0561b", '<path d="M9 30c7-1 11-5 15-12 4 7 8 11 15 12-6 2-10 1-15-3-5 4-9 5-15 3z" fill="#fff"/>'],
  lumn: ["#ffe066", "#f08c00", '<circle cx="24" cy="24" r="6" fill="#fff"/><path d="M24 11v4M24 33v4M11 24h4M33 24h4M14.8 14.8l2.8 2.8M30.4 30.4l2.8 2.8M14.8 33.2l2.8-2.8M30.4 17.6l2.8-2.8" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>'],
  drft: ["#7dd3fc", "#0b5fa5", '<path d="M10 30c4-2 7-2 10 0s6 2 9 0 6-2 9 0" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><path d="M15 23 33 17" stroke="#fff" stroke-width="3" stroke-linecap="round"/>'],
  hlcn: ["#9b7bff", "#3d2a9a", '<path d="M27 11a13 13 0 1 0 10 21 11 11 0 0 1-10-21z" fill="#fff"/><path d="m33 14 1 2.2 2.2 1-2.2 1-1 2.2-1-2.2-2.2-1 2.2-1z" fill="#fff"/>'],
};

/** The design's banner art of a sale: its colours and its shape, white, as an SVG data URL. */
export function fixtureArt(key: string): Readonly<{ colors: readonly [string, string]; shape: string }> {
  const [a, b, shape] = MARK[key];
  return { colors: [a, b], shape: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">${shape}</svg>`)}` };
}

export function fixtureMark(key: string): string {
  const [a, b, shape] = MARK[key];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="48" height="48" fill="url(#g)"/>${shape}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** A design key as a presale id: its bytes in hex, left-padded. */
export function fixtureId(key: string): string {
  return `0x${Buffer.from(key).toString("hex").padStart(64, "0")}`;
}

const PEOPLE: Readonly<Record<string, Readonly<{ name: string; handle: string; verified: boolean }>>> = {
  kai: { name: "Kai Moreno", handle: "kaimoreno", verified: true },
  luca: { name: "Luca Romano", handle: "lucaromano", verified: true },
  mira: { name: "Mira Chen", handle: "mirachen", verified: true },
  theo: { name: "Theo Park", handle: "theopark", verified: false },
  ana: { name: "Ana Souza", handle: "anasouza", verified: true },
  rio: { name: "Rio Nakamura", handle: "rionakamura", verified: false },
  omar: { name: "Omar Haddad", handle: "omarhaddad", verified: false },
  ivy: { name: "Ivy Laurent", handle: "ivylaurent", verified: true },
  sam: { name: "Sam Okafor", handle: "samokafor", verified: false },
  nadia: { name: "Nadia Petrova", handle: "nadiapetrova", verified: false },
};
const PHOTOS: Readonly<Record<string, string>> = { ...FIXTURE_PHOTOS, ...PRESALE_FIXTURE_PHOTOS };

function person(key: string): SocialPresalePerson {
  const who = PEOPLE[key];
  return { callsign: who.handle, display_name: who.name, avatar_url: PHOTOS[key] ?? null, verified: who.verified };
}

/** Kai follows these (the prototype's `state.follows`, people only). */
const FOLLOWS = new Set(["luca", "mira", "ana", "ivy", "omar", "theo", "nadia", "rio"]);

const NAMED: Readonly<Record<string, readonly (readonly [string, number, number, string?])[]>> = {
  mrdn: [["luca", 15000, 30, "Stablecoin FX is the next big onchain market. Team shipped every milestone on time."], ["mira", 2000, 0.1, "Been using their app for months. First presale I have joined with real size."], ["ana", 1200, 6, "Sensible float, real users, liquidity locked forever. Easy yes."], ["nadia", 750, 2.2, "Their testers are my friends. Never seen a team this responsive."], ["omar", 500, 0.8, "Joined their community call. Small bag, long hold."], ["theo", 350, 9], ["kai", 100, 18, "In early. They answered every question in the AMA."], ["ivy", 300, 26]],
  tide: [["luca", 12000, 40, "Savings accounts are the killer app. Oversubscribed for a reason."], ["ana", 4000, 12], ["kai", 250, 20], ["omar", 900, 3], ["sam", 300, 1]],
  // In SUI: Driftwood raises SUI.
  drft: [["luca", 4000, 20, "Paid in SUI, kept in SUI. The pool pairs with SUI too."], ["mira", 600, 3], ["kai", 125, 6, "Small bag in SUI."], ["ana", 300, 11]],
  cblt: [["mira", 800, 90], ["kai", 500, 100, "Perps liquidity that every venue can share. Obvious."], ["theo", 300, 80], ["ivy", 250, 70]],
  kstl: [["luca", 25000, 280, "Called it at the presale. Intents are how swaps should work."], ["kai", 300, 270], ["ana", 2000, 260]],
  lumn: [["ana", 1500, 450, "Creator payouts are huge, but this one did not work out yet."], ["kai", 200, 430]],
};
const KNOWN: Readonly<Record<string, readonly (readonly [string, number, number])[]>> = { mrdn: [["0x1a2b…9f0e", 12400, 38 * MIN]] };

function rng(seed: number): () => number {
  let x = Math.sin(seed) * 1e4;
  return () => (x = Math.sin(x * 9.7 + seed) * 1e4) - Math.floor(x);
}

type Backer = { who?: string; addr?: string; usd: number; t: number; why?: string; rockets?: number; fixed?: boolean };

/** The prototype's `genBackers`, step for step (the same seeded sequence gives the same crowd). */
function genBackers(s: Sale): Backer[] {
  if (!s.start || !s.end) return [];
  const r = rng(s.id.charCodeAt(0) * 31 + s.id.charCodeAt(1));
  const end = Math.min(NOW, s.end);
  const span = end - s.start;
  const hx = () => Math.floor(r() * 65536).toString(16).padStart(4, "0");
  const named: Backer[] = (NAMED[s.id] ?? []).map(([h, a, hrs, why]) => ({ who: h, usd: a, t: Math.min(end, NOW - hrs * HOUR), why, rockets: Math.round(a / 40 + r() * 30) }));
  const known: Backer[] = (KNOWN[s.id] ?? []).map(([addr, a, agoMs]) => ({ addr, usd: a, t: Math.min(end, NOW - agoMs), fixed: true }));
  const n = Math.min(260, s.people, Math.max(120, Math.round(s.people * 0.2)));
  const whales = Math.max(0, (s.raised >= 150000 ? 2 : 1) - known.length);
  const size = Math.min(1, s.raised / 200000);
  const list = known.slice();
  for (let i = 0; i < n; i++) {
    const z = Math.sqrt(-2 * Math.log(1 - r() * 0.999)) * Math.cos(2 * Math.PI * r());
    const whale = i < whales;
    const addr = `0x${hx()}…${hx()}`;
    const usd = whale ? (4000 + r() * 6000) * size : Math.exp(Math.log(150) + 0.9 * z);
    const t = s.start + span * (1 - Math.pow(r(), 1.8));
    list.push({ addr, usd, t, fixed: whale });
  }
  const sum = (items: Backer[]) => items.reduce((total, item) => total + item.usd, 0);
  const fixedSum = sum(named) + sum(list.filter((item) => item.fixed));
  const k = Math.max(0.05, (s.raised - fixedSum) / Math.max(1, sum(list.filter((item) => !item.fixed))));
  for (const item of list) {
    item.usd = Math.round(item.fixed ? item.usd : Math.max(s.min || 10, item.usd * k));
    delete item.fixed;
  }
  return named.concat(list).sort((x, y) => x.t - y.t);
}

/** `0x1a2b…9f0e` as a full address whose short form is the same. */
function walletOf(short: string): string {
  const [head, tail] = short.slice(2).split("…");
  return `0x${head}${"0".repeat(64 - head.length - tail.length)}${tail}`;
}
function walletFor(backer: Backer): string {
  return backer.addr ? walletOf(backer.addr) : `0x${Buffer.from(backer.who!).toString("hex").padStart(64, "f")}`;
}

const BACK: Readonly<Record<string, Backer[]>> = Object.fromEntries(ALL_SALES.map((s) => [s.id, genBackers(s)]));

function terms(s: Sale) {
  const buyersTok = (s.supply * s.split.buyers) / 1e4;
  const poolTok = (s.supply * s.split.pool) / 1e4;
  const price = s.target / buyersTok;
  const launch = ((s.target * s.raiseSplit.pool) / 1e4) / poolTok;
  return { buyersTok, poolTok, price, launch };
}

const PHASE: Readonly<Record<Phase, SocialPresaleSummary["phase"]>> = { open: "open", pending: "pending", funded: "funded", trading: "trading", cancelled: "cancelled" };

/** R3-40: a sale's quote coin as the view names it. */
const quoteOfSale = (s: Sale) => (s.quote === "SUI" ? { quote_symbol: "SUI", quote_decimals: 9 } : { quote_symbol: "USDC", quote_decimals: 6 });

/** An amount in the sale's own coin (cents at most) as quote atoms, exactly. */
function atomsIn(s: Sale, amount: number): string {
  return (BigInt(Math.round(amount * 100)) * 10n ** BigInt(quoteOfSale(s).quote_decimals - 2)).toString();
}

/** USD a whole coin of the sale's quote: 1 for USDC, the fixture SUI price (or the sale's own) for SUI. */
const rateOf = (s: Sale) => (s.quote === "SUI" ? (s.suiUsd ?? FIXTURE_SUI_USD) : 1);

/** An amount in the sale's own coin as dollars: face value for USDC, at the fixture SUI price for SUI. */
function usdIn(s: Sale, amount: number): string {
  return (amount * rateOf(s)).toFixed(2);
}

/** A price per token in the sale's coin, in dollars. */
function priceUsd(s: Sale, price: number): string {
  return String(s.quote === "SUI" ? Number((price * rateOf(s)).toPrecision(12)) : price);
}

export function fixtureSummary(s: Sale): SocialPresaleSummary {
  const t = terms(s);
  const start = s.start ?? s.opens!;
  const end = s.end ?? start + 3 * DAY;
  return {
    presale_id: fixtureId(s.id),
    name: s.name,
    symbol: s.sym,
    icon_url: fixtureMark(s.id),
    phase: PHASE[s.life],
    venue: s.venue,
    start_ms: start,
    end_ms: end,
    ended_ms: s.life === "funded" || s.life === "cancelled" ? end : null,
    launched_ms: s.launched ?? null,
    target_usd: usdIn(s, s.target),
    raised_usd: usdIn(s, s.raised),
    quote_type: s.quote === "SUI" ? "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI" : "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
    ...quoteOfSale(s),
    target_atoms: atomsIn(s, s.target),
    raised_atoms: atomsIn(s, s.raised),
    fill_bps: Math.floor((s.raised / s.target) * 10_000),
    participants: s.people,
    interested: s.interested,
    presale_price_usd: priceUsd(s, t.price),
    presale_price_quote: String(t.price),
    price_usd: s.now ? String(s.now) : null,
    multiple: s.now ? String(s.now / Number(priceUsd(s, t.price))) : null,
    verified_team: s.verified === true,
    audited: s.audited === true,
    metadata: null,
  };
}

const SUMMARIES = Object.fromEntries(ALL_SALES.map((s) => [s.id, fixtureSummary(s)]));
const AS_OF = { checkpoint: 326_274_009, timestamp_ms: NOW - 1_000, lag_ms: 1_000 };

/** Every sample sale's list summary, in the design's order (search and watchlist fixtures, UI-12). */
export function fixtureSummaries(options: FixtureQuoteOptions = {}): SocialPresaleSummary[] {
  return listed(options).map((s) => SUMMARIES[s.id]);
}

export function fixtureList(status: "live" | "upcoming" | "ended", sort: string, options: FixtureQuoteOptions = {}): SocialPresaleListPage {
  let rows = listed(options).filter((s) => (status === "live" ? s.life === "open" : status === "upcoming" ? s.life === "pending" : ["funded", "trading", "cancelled"].includes(s.life)));
  const velocity = (s: Sale) => (BACK[s.id] ?? []).filter((x) => NOW - x.t < 6 * HOUR).reduce((a, x) => a + x.usd, 0) / s.target;
  const result = (s: Sale) => (s.life === "trading" ? (s.now ?? 0) / terms(s).price : s.life === "funded" ? 0.5 : 0);
  const by: Record<string, (a: Sale, b: Sale) => number> = {
    ending: (a, b) => (a.end ?? 0) - (b.end ?? 0), fastest: (a, b) => velocity(b) - velocity(a), backed: (a, b) => b.people - a.people,
    opening: (a, b) => (a.opens ?? 0) - (b.opens ?? 0), interest: (a, b) => b.interested - a.interested,
    recent: (a, b) => (b.end ?? 0) - (a.end ?? 0), best: (a, b) => result(b) - result(a),
  };
  rows = [...rows].sort(by[sort] ?? by.ending);
  return { presales: rows.map((s) => SUMMARIES[s.id]), next_cursor: null, as_of: AS_OF };
}

/** "Backed by people you follow": the tab's sales Kai's follows backed, most first. */
export function fixtureFollowing(status: "live" | "ended", options: FixtureQuoteOptions = {}): SocialPresaleSummary[] {
  const followsIn = (id: string) => (NAMED[id] ?? []).filter(([h]) => FOLLOWS.has(h)).length;
  const keyOf = (presaleId: string) => ALL_SALES.find((s) => fixtureId(s.id) === presaleId)?.id ?? "";
  return fixtureList(status, status === "live" ? "ending" : "recent", options).presales
    .filter((sale) => followsIn(keyOf(sale.presale_id)) > 0)
    .sort((a, b) => followsIn(keyOf(b.presale_id)) - followsIn(keyOf(a.presale_id)));
}

function momentum(s: Sale, win: number): SocialPresaleMomentum {
  const now = s.life === "open" ? NOW : (s.end ?? NOW);
  const list = (BACK[s.id] ?? []).filter((x) => x.t <= now && now - x.t <= win);
  const total = list.reduce((a, x) => a + x.usd, 0);
  const big = list.filter((x) => x.usd >= 1000).reduce((a, x) => a + x.usd, 0);
  const values = list.map((x) => x.usd).sort((a, b) => a - b);
  const med = values.length ? (values.length % 2 ? values[(values.length - 1) / 2] : (values[values.length / 2 - 1] + values[values.length / 2]) / 2) : 0;
  return {
    commits: list.length,
    total_usd: usdIn(s, total),
    total_atoms: atomsIn(s, total),
    backers: new Set(list.map((x) => x.who ?? x.addr)).size,
    average_usd: list.length ? (s.quote === "SUI" ? usdIn(s, total / list.length) : (total / list.length).toFixed(4)) : null,
    median_usd: list.length ? usdIn(s, med) : null,
    average_atoms: list.length ? atomsIn(s, total / list.length) : null,
    median_atoms: list.length ? atomsIn(s, med) : null,
    big_bps: total ? Math.round((big / total) * 10_000) : 0,
  };
}

/** Kai's positions; `usd` is in the sale's own coin (Driftwood's 125 is SUI). */
const POSITIONS: Readonly<Record<string, Readonly<{ usd: number; claimed: boolean }>>> = {
  mrdn: { usd: 100, claimed: false }, tide: { usd: 250, claimed: false }, cblt: { usd: 500, claimed: false },
  hlcn: { usd: 250, claimed: false }, kstl: { usd: 300, claimed: true }, lumn: { usd: 200, claimed: true },
  drft: { usd: 125, claimed: false },
};

/** Kai's view of a sale: the accounts he follows that backed it and his own position. */
export function fixtureViewerEntry(key: string, options: FixtureSaleOptions = {}): SocialPresaleViewerEntry {
  const s = variantOf(key, options);
  const byWho = new Map<string, { usd: number; t: number; why: string | null; commits: [number, string, string][] }>();
  for (const backer of BACK[key] ?? []) {
    if (!backer.who || backer.who === "kai" || !FOLLOWS.has(backer.who)) continue;
    const own = byWho.get(backer.who) ?? { usd: 0, t: 0, why: null, commits: [] };
    own.usd += backer.usd;
    own.t = Math.max(own.t, backer.t);
    own.why = own.why ?? backer.why ?? null;
    own.commits.push([backer.t, usdIn(s, backer.usd), atomsIn(s, backer.usd)]);
    byWho.set(backer.who, own);
  }
  const following = [...byWho].sort((a, b) => b[1].usd - a[1].usd).map(([who, own]) => ({
    account: person(who), commitment_usd: usdIn(s, own.usd), commitment_atoms: atomsIn(s, own.usd), last_commit_ms: own.t, why: own.why, commits: own.commits,
  }));
  const position = POSITIONS[key];
  const mine = (BACK[key] ?? []).filter((x) => x.who === "kai");
  return {
    following,
    following_total_usd: following.reduce((a, row) => a + Number(row.commitment_usd), 0).toFixed(2),
    following_total_atoms: following.reduce((a, row) => a + BigInt(row.commitment_atoms), 0n).toString(),
    mine: position
      ? {
        commitment_usd: usdIn(s, position.usd),
        commitment_atoms: atomsIn(s, position.usd),
        commits: mine.map((x) => [x.t, usdIn(s, x.usd), atomsIn(s, x.usd)] as const),
        claimed: position.claimed,
        refund_usd: "0.00",
        refund_atoms: "0",
      }
      : null,
  };
}

export function fixtureViewer(): Readonly<Record<string, SocialPresaleViewerEntry>> {
  return Object.fromEntries(ALL_SALES.map((s) => [fixtureId(s.id), fixtureViewerEntry(s.id)]));
}

/** "Your presales": Kai's positions in the prototype's order (Driftwood's 125 SUI after Tidal, when asked). */
export function fixtureMine(options: FixtureQuoteOptions = {}): SocialPresaleViewerResponse {
  const order = options.sui ? ["mrdn", "tide", "drft", "cblt", "hlcn", "kstl", "lumn"] : ["mrdn", "tide", "cblt", "hlcn", "kstl", "lumn"];
  return {
    presales: Object.fromEntries(order.map((key) => [fixtureId(key), fixtureViewerEntry(key)])),
    rows: order.map((key) => SUMMARIES[key]),
  };
}

function actItem(key: string, partial: Partial<FeedItem> & Pick<FeedItem, "entry_id" | "kind" | "occurred_at_ms">): FeedItem {
  const s = saleOf(key);
  return {
    presale: {
      presale_id: fixtureId(key), symbol: s.sym, name: s.name, icon_url: fixtureMark(key), lifecycle: s.life, decimals: 9,
      venue: s.venue, start_ms: s.start ?? s.opens ?? NOW, end_ms: s.end ?? (s.opens ?? NOW) + 3 * DAY,
      raise_target: atomsIn(s, s.target), raised: atomsIn(s, s.raised), participants: s.people,
      ...quoteOfSale(s), quote_usd: s.quote === "SUI" ? FIXTURE_SUI_PRICE.usd_price : "1", market: null,
    },
    actor: null, amounts: null, digest: null, milestone_value: null, presale_post: false, big: false, why: null,
    reactions: { rocket: 0 }, through: { people: 0, volume_usd: "0.00" }, do_the_same: null, call: false, backers: null,
    ...partial,
  };
}

function account(key: string) {
  const who = PEOPLE[key];
  return { type: "account" as const, callsign: who.handle, display_name: who.name, avatar_url: PHOTOS[key] ?? null, x_handle: who.handle, verified: true, path: `/@${who.handle}` };
}

const amounts = (usd: number, key = "mrdn") => {
  const s = saleOf(key);
  return { quote: atomsIn(s, usd), ...quoteOfSale(s), usd: usdIn(s, usd), tokens: null, quote_refund: null };
};

/** The sale's posts in the prototype's Activity tab (Meridian, Kestrel and Cobalt have some). */
const ACTIVITY: Readonly<Record<string, readonly FeedItem[]>> = {
  mrdn: [
    actItem("mrdn", { entry_id: "a:1:0:0:0", kind: "presale_commit", occurred_at_ms: NOW - 6 * MIN, actor: account("mira"), amounts: amounts(2000), why: { why_id: "w1", text: NAMED.mrdn[1][3]! } }),
    actItem("mrdn", { entry_id: `m:${fixtureId("mrdn")}:participants:1000`, kind: "milestone_participants", occurred_at_ms: NOW - 14 * MIN, milestone_value: "1000", presale_post: true }),
    actItem("mrdn", { entry_id: "a:2:0:0:0", kind: "presale_commit", occurred_at_ms: NOW - 38 * MIN, actor: { type: "address", address: walletOf("0x1a2b…9f0e"), short: "0x1a2b…9f0e" }, amounts: amounts(12400), presale_post: true, big: true }),
    actItem("mrdn", { entry_id: "a:3:0:0:0", kind: "presale_commit", occurred_at_ms: NOW - 48 * MIN, actor: account("omar"), amounts: amounts(500), why: { why_id: "w2", text: NAMED.mrdn[4][3]! } }),
  ],
  cblt: [
    actItem("cblt", { entry_id: `l:${fixtureId("cblt")}:funded`, kind: "presale_funded", occurred_at_ms: NOW - 3 * HOUR - 5 * MIN, presale_post: true }),
    actItem("cblt", { entry_id: "a:4:0:0:0", kind: "presale_commit", occurred_at_ms: NOW - 100 * HOUR, actor: account("kai"), amounts: amounts(500), why: { why_id: "w3", text: NAMED.cblt[1][3]! } }),
  ],
  drft: [
    actItem("drft", { entry_id: "a:5:0:0:0", kind: "presale_commit", occurred_at_ms: NOW - 20 * HOUR, actor: account("luca"), amounts: amounts(4000, "drft"), why: { why_id: "w4", text: NAMED.drft[0][3]! } }),
    actItem("drft", { entry_id: "a:6:0:0:0", kind: "presale_commit", occurred_at_ms: NOW - 6 * HOUR, actor: account("kai"), amounts: amounts(125, "drft"), why: { why_id: "w5", text: NAMED.drft[2][3]! } }),
  ],
};

/** The design's team vesting as a chain schedule: from launch (or the sale's expected launch), after its cliff, over its months. */
function fixtureVesting(s: Sale) {
  if (!s.vest.months || s.life === "pending" || s.life === "cancelled") return null;
  const start = s.launched ?? (s.end ?? NOW) + 2 * DAY;
  return { start_ms: start, cliff_end_ms: start + s.vest.cliff * 30 * DAY, end_ms: start + s.vest.months * 30 * DAY };
}

export function fixtureDetail(key: string, options: FixtureSaleOptions = {}): SocialPresaleDetail {
  const s = variantOf(key, options);
  const summary = s === saleOf(key) ? SUMMARIES[key] : fixtureSummary(s);
  const t = terms(s);
  const back = BACK[key] ?? [];
  const sorted = [...back].sort((a, b) => b.usd - a.usd);
  const top: SocialPresaleBacker[] = sorted.slice(0, 25).map((x) => ({
    wallet: walletFor(x),
    account: x.who ? person(x.who) : null,
    commitment_usd: usdIn(s, x.usd),
    commitment_atoms: atomsIn(s, x.usd),
    share_bps: Math.round((x.usd / Math.max(1, s.raised)) * 10_000),
    last_commit_ms: x.t,
    why: x.why ?? null,
  }));
  const top10 = (sorted.slice(0, 10).reduce((a, x) => a + x.usd, 0) / Math.max(1, s.raised)) * 10_000;
  let cumulative = 0;
  const points = back.map((x) => {
    cumulative += x.usd;
    return [x.t, usdIn(s, cumulative), atomsIn(s, cumulative)] as const;
  });
  const windows: Record<PresaleMomentumWindow, number> = { "5m": 5 * MIN, "1h": HOUR, "4h": 4 * HOUR, "1d": DAY };
  const supply = (bps: number) => String(BigInt(Math.round((s.supply * bps) / 1e4)) * 10n ** 9n);
  const team = `0x${"7ea".padStart(64, "0")}`;
  const treasury = `0x${"7eb".padStart(64, "0")}`;
  return {
    creator: { wallet: team, account: person("luca") },
    presale: {
      ...summary,
      sale_token: `0x${"7a3f".padEnd(60, "0")}c91e::${s.sym.toLowerCase()}::${s.sym}`,
      sale_decimals: 9,
      allowlisted: false,
      min_commitment_usd: usdIn(s, s.min),
      wallet_cap_usd: usdIn(s, s.cap),
      min_commitment_atoms: atomsIn(s, s.min),
      wallet_cap_atoms: atomsIn(s, s.cap),
      opened_ms: s.start ?? null,
    },
    quote_price: s.quote === "SUI" ? { ...FIXTURE_SUI_PRICE, usd_price: String(rateOf(s)) } : null,
    momentum: Object.fromEntries(Object.entries(windows).map(([name, ms]) => [name, momentum(s, ms)])) as Record<PresaleMomentumWindow, SocialPresaleMomentum>,
    backers: { top, top10_bps: Math.round(top10) },
    theses: back.filter((x) => x.why && x.who).sort((a, b) => b.usd - a.usd || (b.rockets ?? 0) - (a.rockets ?? 0)).map((x, index) => ({
      why_id: `fixture-why-${index}`, entry_id: `a:${index}:0:0:0`, account: person(x.who!), text: x.why!, commit_usd: usdIn(s, x.usd), commit_atoms: atomsIn(s, x.usd), rockets: x.rockets ?? 0, occurred_at_ms: x.t,
    })),
    activity: ACTIVITY[key] ?? [],
    raise: {
      points,
      markers: back.filter((x) => x.usd >= 5000 || (x.why && x.who)).map((x) => ({
        t: x.t, raised_usd: "0.00", commit_usd: usdIn(s, x.usd), raised_atoms: "0", commit_atoms: atomsIn(s, x.usd), wallet: walletFor(x), account: x.who ? person(x.who) : null, why: x.why ?? null,
      })),
    },
    vesting: fixtureVesting(s),
    team_vesting: fixtureVesting(s),
    terms: {
      supply: {
        total: String(BigInt(s.supply) * 10n ** 9n),
        participants: { bps: s.split.buyers, amount: supply(s.split.buyers) },
        liquidity: { bps: s.split.pool, amount: supply(s.split.pool) },
        recipients: [
          { address: team, bps: s.split.team, amount: supply(s.split.team), vesting: fixtureVesting(s) },
          ...(s.split.treasury ? [{ address: treasury, bps: s.split.treasury, amount: supply(s.split.treasury), vesting: null }] : []),
        ],
        protocol: { bps: 0, amount: "0" },
      },
      raise: {
        pool_bps: s.raiseSplit.pool,
        // The gate's raise share for the team vests (its `Vests` note, R3-90), on the team's schedule.
        recipients: [{ address: team, bps: s.raiseSplit.team, amount: atomsIn(s, Math.round(s.target * s.raiseSplit.team / 1e4)), vesting: fixtureVesting(s) }],
        protocol: { bps: s.raiseSplit.blast, amount: atomsIn(s, Math.round(s.target * s.raiseSplit.blast / 1e4)) },
      },
      eligibility: { kind: "open" },
      presale_price_usd: priceUsd(s, t.price),
      launch_price_usd: priceUsd(s, t.launch),
      presale_price_quote: String(t.price),
      launch_price_quote: String(t.launch),
      burnable: false,
      hard_cap: s.hardCap === undefined ? false : s.hardCap,
    },
    as_of: AS_OF,
  };
}

export const FIXTURE_SALE_KEYS = ALL_SALES.map((s) => s.id);
export const FIXTURE_ME = { avatar_url: PHOTOS.kai ?? null };
