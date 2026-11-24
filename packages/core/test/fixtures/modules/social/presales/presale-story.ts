import {
  seedChainRead,
  type ChainActivityRow,
  type ChainPresaleLifecycleRow,
  type ChainPresalePositionRow,
  type ChainPresaleRow,
  type ChainPriceRow,
  type ChainVestingScheduleRow,
} from "../../database/chain-read-rows.ts";
import type { PresaleTerms } from "../../../../../src/modules/presale/terms/index.ts";
import { USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";

/**
 * The canonical UI's sample presales (Meridian, Tidal, Sable, Ondine, Cobalt,
 * Kestrel, Lumen, Halcyon) and its sample people, for a disposable database:
 * tests, local development and the scale check only, never imported by
 * application code. It appends to the fixture `chain_read_v1` rows
 * (`CHAIN_FIXTURE` and the web migrations must be in place) and writes as the
 * database owner. Amounts are USDC (6 decimals) at face value; every time
 * counts back from `nowMs`. With `sui`, it adds Driftwood (R3-40), a sale
 * quoted in SUI (9 decimals): its amounts are whole SUI, valued at
 * `PRESALE_STORY_SUI_USD` a coin, with a SUI price row.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const USDC = 1_000_000;
/** A whole SUI in atoms, and the story's SUI price (USD a coin). */
const SUI = 1_000_000_000;
export const PRESALE_STORY_SUI_USD = "3.42";
export const PRESALE_STORY_SUI_TYPE = `0x${"2".padStart(64, "0")}::sui::SUI`;

function hex(tag: string): string {
  return `0x${tag.padStart(64, "0")}`;
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

export const PRESALE_STORY_PEOPLE = {
  kai: { name: "Kai Moreno", x: "kaimoreno" },
  luca: { name: "Luca Romano", x: "lucaromano" },
  mira: { name: "Mira Chen", x: "mirachen" },
  theo: { name: "Theo Park", x: "theopark" },
  ana: { name: "Ana Souza", x: "anasouza" },
  rio: { name: "Rio Nakamura", x: "rionakamura" },
  omar: { name: "Omar Haddad", x: "omarhaddad" },
  ivy: { name: "Ivy Laurent", x: "ivylaurent" },
  sam: { name: "Sam Okafor", x: null },
  nadia: { name: "Nadia Petrova", x: "nadiapetrova" },
} as const;
export type PresaleStoryPerson = keyof typeof PRESALE_STORY_PEOPLE;

/** Kai (the design's viewer) follows these. */
export const PRESALE_STORY_KAI_FOLLOWS: readonly PresaleStoryPerson[] = ["luca", "mira", "ana", "ivy", "omar", "theo", "nadia", "rio"];

export const PRESALE_STORY_ACCOUNTS = Object.fromEntries(
  (Object.keys(PRESALE_STORY_PEOPLE) as PresaleStoryPerson[]).map((key, n) => [key, uuid(0x9100 + n)]),
) as Record<PresaleStoryPerson, string>;
export const PRESALE_STORY_WALLETS = Object.fromEntries(
  (Object.keys(PRESALE_STORY_PEOPLE) as PresaleStoryPerson[]).map((key, n) => [key, hex(`9a11e7${n.toString(16).padStart(2, "0")}`)]),
) as Record<PresaleStoryPerson, string>;

type Sale = Readonly<{
  key: string;
  symbol: string;
  name: string;
  phase: "open" | "pending" | "funded" | "trading" | "cancelled";
  raised: number;
  target: number;
  min: number;
  cap: number;
  start: number;
  end: number;
  launched?: number;
  /** USD per token now, trading only. */
  now?: number;
  supply: number;
  /** Buyers' share of the supply, bps (sets the presale price: target over buyers' tokens). */
  buyersBps: number;
  venue: "cetus" | "bluefin" | "aftermath";
  /** Team vesting months from launch. */
  vestMonths: number;
  /** Months from launch before anything unlocks (the design's `vest.cliff`). */
  vestCliff: number;
  /** R3-40: the sale's quote coin; its amounts above (and its backers') are in whole coins of it. Default USDC. */
  quote?: "SUI";
}>;

function sales(nowMs: number): Sale[] {
  return [
    { key: "a1", symbol: "MRDN", name: "Meridian", phase: "open", raised: 184_221, target: 250_000, min: 10, cap: 25_000, start: nowMs - 42 * HOUR, end: nowMs + 6 * HOUR + 12 * 60_000 + 41_000, supply: 1e9, buyersBps: 4500, venue: "cetus", vestMonths: 12, vestCliff: 3 },
    { key: "a2", symbol: "TIDE", name: "Tidal", phase: "open", raised: 398_600, target: 400_000, min: 10, cap: 20_000, start: nowMs - 70 * HOUR, end: nowMs + 80_000, supply: 1e9, buyersBps: 4000, venue: "cetus", vestMonths: 12, vestCliff: 3 },
    { key: "a3", symbol: "SABL", name: "Sable", phase: "pending", raised: 0, target: 400_000, min: 25, cap: 20_000, start: Date.UTC(2026, 9, 14, 18), end: Date.UTC(2026, 9, 17, 18), supply: 1e9, buyersBps: 4000, venue: "cetus", vestMonths: 18, vestCliff: 6 },
    { key: "a4", symbol: "ONDN", name: "Ondine", phase: "pending", raised: 0, target: 180_000, min: 10, cap: 10_000, start: Date.UTC(2026, 9, 16, 15), end: Date.UTC(2026, 9, 19, 15), supply: 5e8, buyersBps: 5000, venue: "bluefin", vestMonths: 9, vestCliff: 3 },
    { key: "a5", symbol: "CBLT", name: "Cobalt", phase: "funded", raised: 311_400, target: 250_000, min: 10, cap: 25_000, start: nowMs - 5 * DAY, end: nowMs - 3 * HOUR, supply: 5e8, buyersBps: 5000, venue: "bluefin", vestMonths: 12, vestCliff: 3 },
    { key: "a6", symbol: "KSTL", name: "Kestrel", phase: "trading", raised: 225_000, target: 225_000, min: 10, cap: 25_000, start: nowMs - 12 * DAY, end: nowMs - 8 * DAY, launched: nowMs - 6 * DAY, now: 0.0021, supply: 1e9, buyersBps: 4500, venue: "cetus", vestMonths: 12, vestCliff: 3 },
    { key: "a7", symbol: "LUMN", name: "Lumen", phase: "trading", raised: 160_000, target: 160_000, min: 10, cap: 15_000, start: nowMs - 20 * DAY, end: nowMs - 16 * DAY, launched: nowMs - 14 * DAY, now: 0.0013, supply: 4e8, buyersBps: 2000, venue: "cetus", vestMonths: 6, vestCliff: 1 },
    { key: "a8", symbol: "HLCN", name: "Halcyon", phase: "cancelled", raised: 61_200, target: 300_000, min: 10, cap: 10_000, start: nowMs - 9 * DAY, end: nowMs - 6 * DAY, supply: 1e9, buyersBps: 4500, venue: "cetus", vestMonths: 24, vestCliff: 6 },
  ];
}

/** R3-40: Driftwood, quoted in SUI: 99,970 of 100,000 SUI (the floor case: never printed as its target). */
function suiSale(nowMs: number): Sale {
  return { key: "a9", symbol: "DRFT", name: "Driftwood", phase: "open", raised: 99_970, target: 100_000, min: 25, cap: 5_000, start: nowMs - 52 * HOUR, end: nowMs + 20 * HOUR + 4 * 60_000, supply: 1e9, buyersBps: 4500, venue: "cetus", vestMonths: 12, vestCliff: 3, quote: "SUI" };
}

/** Named backers per sale: [person, USD, hours before now, thesis]. */
const NAMED: Readonly<Record<string, readonly (readonly [PresaleStoryPerson, number, number, string?])[]>> = {
  MRDN: [
    ["luca", 15_000, 30, "Stablecoin FX is the next big onchain market. Team shipped every milestone on time."],
    ["mira", 2_000, 0.1, "Been using their app for months. First presale I have joined with real size."],
    ["ana", 1_200, 6, "Sensible float, real users, liquidity locked forever. Easy yes."],
    ["nadia", 750, 2.2, "Their testers are my friends. Never seen a team this responsive."],
    ["omar", 500, 0.8, "Joined their community call. Small bag, long hold."],
    ["theo", 350, 9],
    ["kai", 100, 18, "In early. They answered every question in the AMA."],
    ["ivy", 300, 26],
  ],
  TIDE: [["luca", 12_000, 40, "Savings accounts are the killer app. Oversubscribed for a reason."], ["ana", 4_000, 12], ["kai", 250, 20], ["omar", 900, 3], ["sam", 300, 1]],
  CBLT: [["mira", 800, 90], ["kai", 500, 100, "Perps liquidity that every venue can share. Obvious."], ["theo", 300, 80], ["ivy", 250, 70]],
  KSTL: [["luca", 25_000, 280, "Called it at the presale. Intents are how swaps should work."], ["kai", 300, 270], ["ana", 2_000, 260]],
  LUMN: [["ana", 1_500, 450, "Creator payouts are huge, but this one did not work out yet."], ["kai", 200, 430]],
  HLCN: [["kai", 250, 160]],
  // In SUI.
  DRFT: [["luca", 4_000, 20, "Paying in SUI and raising in SUI. No bridge, no swap, no excuses."], ["mira", 600, 4], ["kai", 125, 2, "Small SUI bag. Their testnet game was the most fun I had all year."], ["ana", 300, 9]],
};

/** A deterministic sequence in [0, 1). */
function random(seed: number): () => number {
  let x = Math.sin(seed) * 1e4;
  return () => {
    x = Math.sin(x * 9.7 + seed) * 1e4;
    return x - Math.floor(x);
  };
}

export type PresaleStory = Readonly<{
  presaleIds: Readonly<Record<string, string>>;
  saleTokens: Readonly<Record<string, string>>;
  /**
   * Each sale's terms as blast-infra's projection would answer them, by
   * presale id, for a test's `terms` source: a team wallet holding a fifth of
   * the supply (the trading sales' vesting schedule pays it) and a separate
   * treasury wallet taking 23% of the raise.
   */
  terms: Readonly<Record<string, PresaleTerms>>;
}>;

export type PresaleStoryOptions = Readonly<{
  nowMs: number;
  /** Anonymous wallets per live or ended sale (default 60). */
  crowd?: number;
  /** First checkpoint to use (default 60,000); activity takes one per row. */
  checkpoint?: number;
  /** Seed accounts, follows and theses (default true). */
  social?: boolean;
  /** R3-40: also seed Driftwood, a SUI-quoted sale, and a SUI price row (default false). */
  sui?: boolean;
}>;

/** Seeds the design's sales, their backers, prices, lifecycle and vesting, and (by default) the people and Kai's follows. */
export async function seedPresaleStory(
  admin: { query(text: string, values?: unknown[]): Promise<unknown> },
  options: PresaleStoryOptions,
): Promise<PresaleStory> {
  const { nowMs } = options;
  const crowd = options.crowd ?? 60;
  let checkpoint = options.checkpoint ?? 60_000;
  const presaleIds: Record<string, string> = {};
  const saleTokens: Record<string, string> = {};
  const presales: ChainPresaleRow[] = [];
  const lifecycle: ChainPresaleLifecycleRow[] = [];
  const positions: ChainPresalePositionRow[] = [];
  const activity: ChainActivityRow[] = [];
  const prices: ChainPriceRow[] = [{ coin_type: USDC_COIN_TYPE, usd_price: "0.9998", as_of_ms: nowMs - 5_000, source: "pyth" }];
  if (options.sui) prices.push({ coin_type: PRESALE_STORY_SUI_TYPE, usd_price: PRESALE_STORY_SUI_USD, as_of_ms: nowMs - 5_000, source: "pyth" });
  const vesting: ChainVestingScheduleRow[] = [];
  const terms: Record<string, PresaleTerms> = {};
  const whys: [string, string, string][] = [];

  function appendSale(sale: Sale): void {
    // Whole coins of the sale's quote, in its atoms; a commit's dollars at the quote's price.
    const unit = sale.quote === "SUI" ? SUI : USDC;
    const quoteType = sale.quote === "SUI" ? PRESALE_STORY_SUI_TYPE : USDC_COIN_TYPE;
    const usdPerCoin = sale.quote === "SUI" ? Number(PRESALE_STORY_SUI_USD) : 0.9998;
    const id = hex(`5a1e${sale.key}`);
    const token = `${hex(`c0${sale.key}`)}::${sale.symbol.toLowerCase()}::${sale.symbol}`;
    presaleIds[sale.symbol] = id;
    saleTokens[sale.symbol] = token;
    const rng = random(sale.symbol.charCodeAt(0) * 31 + sale.symbol.charCodeAt(1));
    const commits = storyCommits(sale, crowd, nowMs, rng);
    let raisedAtoms = 0n;
    const wallets = new Map<string, { atoms: bigint; last: number }>();
    function appendCommitActivity(): void {
      for (const commit of commits) {
        // A commit's amount is whole cents of its coin (the crowd's are rounded to cents).
        const atoms = sale.quote === "SUI" ? BigInt(Math.round(commit.usd * 100)) * BigInt(SUI / 100) : BigInt(Math.round(commit.usd * USDC));
        raisedAtoms += atoms;
        const own = wallets.get(commit.wallet) ?? { atoms: 0n, last: 0 };
        wallets.set(commit.wallet, { atoms: own.atoms + atoms, last: commit.t });
        checkpoint += 1;
        activity.push({
          checkpoint, tx_slot: 0, event_slot: 0, part: 0, timestamp_ms: commit.t, digest: `Ps${checkpoint}`.padEnd(44, "1"),
          kind: "presale_commit", product: "presale", actor: commit.wallet, tx_sender: commit.wallet, presale_id: id, coin_type: token,
          quote_type: quoteType, quote_amount: atoms.toString(), coin_amount: null, quote_refund: null,
          usd_value: (commit.usd * usdPerCoin).toFixed(2), usd_price_as_of_ms: commit.t - 1_000, venue: null,
          participants_after: wallets.size, total_commitments_after: raisedAtoms.toString(),
        });
        if (commit.why) whys.push([`a:${checkpoint}:0:0:0`, commit.wallet, commit.why]);
      }
    }
    appendCommitActivity();
    const lifecycleName: ChainPresaleRow["lifecycle"] =
      ({ open: "open", pending: "pending", funded: "funded", trading: "migrated", cancelled: "cancelled" } as const)[sale.phase];
    const decimals = 9;
    const buyersTokens = BigInt(Math.round((sale.supply * sale.buyersBps) / 10_000)) * 10n ** BigInt(decimals);
    const targetAtoms = BigInt(sale.target) * BigInt(unit);
    const fill = raisedAtoms > targetAtoms ? Number(targetAtoms) / Number(raisedAtoms) : 1;
    function position(wallet: string, own: { atoms: bigint; last: number }): ChainPresalePositionRow {
      const claimed = sale.phase === "trading" || (sale.phase === "cancelled" && wallet !== PRESALE_STORY_WALLETS.kai && rng() < 0.4);
      const tokens = sale.phase === "trading" ? (own.atoms * buyersTokens) / (raisedAtoms > targetAtoms ? raisedAtoms : targetAtoms) : 0n;
      const refund = sale.phase === "cancelled" ? own.atoms : BigInt(Math.round(Number(own.atoms) * (1 - fill)));
      return {
        presale_id: id, wallet, commitment: own.atoms.toString(), last_commit_ms: own.last,
        claim_digest: claimed ? `Pc${sale.key}${wallet.slice(-6)}`.padEnd(44, "1") : null,
        claimed_tokens: claimed ? tokens.toString() : null,
        claimed_quote_refund: claimed ? refund.toString() : null,
        claimed_ms: claimed ? (sale.launched ?? sale.end) + HOUR : null,
      };
    }
    for (const [wallet, own] of wallets) positions.push(position(wallet, own));
    presales.push({
      creator: PRESALE_STORY_WALLETS.luca, created_at_ms: sale.start - DAY,
      presale_id: id, sale_token: token, quote_type: quoteType, sale_symbol: sale.symbol, sale_name: sale.name,
      sale_icon_url: `https://i.blast.test/${sale.symbol.toLowerCase()}.png`, sale_decimals: decimals, quote_symbol: sale.quote ?? "USDC",
      quote_decimals: sale.quote === "SUI" ? 9 : 6, lifecycle: lifecycleName, start_ms: sale.start, end_ms: sale.end, raise_target: targetAtoms.toString(),
      min_commitment: (BigInt(sale.min) * BigInt(unit)).toString(), wallet_cap: (BigInt(sale.cap) * BigInt(unit)).toString(), total_commitments: raisedAtoms.toString(),
      participants: wallets.size, venue: sale.venue, pool_id: sale.phase === "trading" ? hex(`900${sale.key}`) : null,
      updated_checkpoint: checkpoint,
    });
    function appendLifecycle(): void {
      const event = (state: ChainPresaleLifecycleRow["state"], t: number) =>
        lifecycle.push({ presale_id: id, state, digest: `Pl${sale.key}${state}`.padEnd(44, "1"), timestamp_ms: t, checkpoint: ++checkpoint });
      if (sale.phase !== "pending") event("opened", sale.start);
      if (sale.phase === "funded" || sale.phase === "trading") event("funded", sale.end);
      if (sale.phase === "trading") event("migrated", sale.launched!);
      if (sale.phase === "cancelled") event("cancelled", sale.end);
    }
    appendLifecycle();
    if (sale.now) prices.push({ coin_type: token, usd_price: String(sale.now), as_of_ms: nowMs - 20_000, source: "pool" });
    const tokenAtoms = (bps: number) => (BigInt(Math.round((sale.supply * bps) / 10_000)) * 10n ** BigInt(decimals)).toString();
    const raiseAtoms = (bps: number) => ((targetAtoms * BigInt(bps)) / 10_000n).toString();
    terms[id] = {
      presaleId: id,
      raiseTarget: targetAtoms.toString(),
      supply: {
        total: tokenAtoms(10_000),
        participants: { bps: sale.buyersBps, amount: tokenAtoms(sale.buyersBps) },
        liquidity: { bps: 8_000 - sale.buyersBps, amount: tokenAtoms(8_000 - sale.buyersBps) },
        recipients: [{ address: hex(`7ea${sale.key}`), bps: 2_000, amount: tokenAtoms(2_000) }],
        protocol: { bps: 0, amount: "0" },
      },
      raise: {
        poolShare: raiseAtoms(7_500),
        recipients: [{ address: hex(`7eb${sale.key}`), bps: 2_300, amount: raiseAtoms(2_300) }],
        protocol: { bps: 200, amount: raiseAtoms(200) },
      },
      eligibility: { kind: "open" },
      burnable: false,
      hardCap: false,
      // The CLMM tier: Cetus 0.25%, Bluefin 1%; Aftermath carries none.
      poolFeePpm: sale.venue === "aftermath" ? null : sale.venue === "bluefin" ? 10_000 : 2_500,
    };
    if (sale.phase === "trading") {
      vesting.push({
        schedule_id: hex(`7e${sale.key}`), presale_id: id, beneficiary: hex(`7ea${sale.key}`), total: String(BigInt(sale.supply / 5) * 10n ** 9n),
        claimed: "0", start_ms: sale.launched!, cliff_ms: String(sale.vestCliff * 30 * DAY),
        end_ms: String(sale.launched! + sale.vestMonths * 30 * DAY),
      });
    }
  }

  for (const sale of options.sui ? [...sales(nowMs), suiSale(nowMs)] : sales(nowMs)) appendSale(sale);

  await seedChainRead(admin, { presales, presale_lifecycle: lifecycle, presale_positions: positions, activity, prices, vesting_schedules: vesting });

  if (options.social ?? true) await seedSocialStory(admin, nowMs, presaleIds, whys);
  return { presaleIds, saleTokens, terms };
}

type StoryCommit = { wallet: string; usd: number; t: number; why?: string };

function storyCommits(sale: Sale, crowd: number, nowMs: number, rng: () => number): StoryCommit[] {
  // Commits: the named ones, then a crowd that makes up the rest of the raise.
  const named = sale.phase === "pending" ? [] : (NAMED[sale.symbol] ?? []);
  const commits: StoryCommit[] = named.map(([who, usd, hours, why]) => ({
    wallet: PRESALE_STORY_WALLETS[who], usd, t: Math.min(sale.end - 1_000, nowMs - hours * HOUR), why,
  }));
  if (sale.phase !== "pending") {
    const rest = Math.max(0, sale.raised - commits.reduce((sum, commit) => sum + commit.usd, 0));
    const weights = Array.from({ length: crowd }, () => Math.exp(1.2 * (rng() - 0.5) * 3));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const span = Math.min(nowMs, sale.end) - sale.start;
    let assigned = 0;
    weights.forEach((weight, n) => {
      const usd = n === crowd - 1 ? Math.round((rest - assigned) * 100) / 100 : Math.round((rest * weight) / total * 100) / 100;
      assigned += usd;
      commits.push({ wallet: hex(`ad${sale.key}${n.toString(16).padStart(4, "0")}`), usd, t: sale.start + Math.floor(span * (1 - rng() ** 1.8)) });
    });
  }
  commits.sort((a, b) => a.t - b.t);
  return commits;
}

async function seedSocialStory(
  admin: Parameters<typeof seedPresaleStory>[0],
  nowMs: number,
  presaleIds: Readonly<Record<string, string>>,
  whys: readonly [string, string, string][],
): Promise<void> {
  const since = new Date(nowMs - 60 * DAY).toISOString();
  for (const key of Object.keys(PRESALE_STORY_PEOPLE) as PresaleStoryPerson[]) {
    const person = PRESALE_STORY_PEOPLE[key];
    const callsign = key === "kai" ? "kaimoreno" : person.name.toLowerCase().replace(/[^a-z]/g, "");
    await admin.query(
      `INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, x_handle, privacy, sharing_since, onboarded_at)
         VALUES ($1, $2, $3, $4, $5, 'public', $6, $6)`,
      [PRESALE_STORY_ACCOUNTS[key], `did:privy:presale-story-${key}`, callsign, person.name, person.x, since],
    );
    await admin.query("INSERT INTO social_account_wallets (address, account_id, kind, verified_at) VALUES ($1, $2, 'slush', $3)", [
      PRESALE_STORY_WALLETS[key], PRESALE_STORY_ACCOUNTS[key], since,
    ]);
  }
  for (const key of PRESALE_STORY_KAI_FOLLOWS) {
    await admin.query(
      "INSERT INTO social_follows (follower_account_id, target_kind, target_id, source) VALUES ($1, 'account', $2, 'user')",
      [PRESALE_STORY_ACCOUNTS.kai, PRESALE_STORY_ACCOUNTS[key]],
    );
  }
  for (const symbol of ["MRDN", "CBLT"]) {
    await admin.query(
      "INSERT INTO social_follows (follower_account_id, target_kind, target_id, source) VALUES ($1, 'presale', $2, 'user')",
      [PRESALE_STORY_ACCOUNTS.kai, presaleIds[symbol]],
    );
  }
  const owners = new Map((Object.keys(PRESALE_STORY_WALLETS) as PresaleStoryPerson[]).map((key) => [PRESALE_STORY_WALLETS[key], key]));
  for (const [n, [entryId, wallet, text]] of whys.entries()) {
    const owner = owners.get(wallet);
    if (!owner) continue;
    await admin.query("INSERT INTO social_whys (why_id, entry_id, author_account_id, text) VALUES ($1, $2, $3, $4)", [
      uuid(0x9200 + n), entryId, PRESALE_STORY_ACCOUNTS[owner], text,
    ]);
    // A few rockets each, from the people after the author.
    const fans = (Object.keys(PRESALE_STORY_ACCOUNTS) as PresaleStoryPerson[]).filter((key) => key !== owner).slice(0, 2 + (n % 5));
    for (const fan of fans) {
      await admin.query("INSERT INTO social_reactions (entry_id, account_id, reaction) VALUES ($1, $2, 'rocket')", [
        entryId, PRESALE_STORY_ACCOUNTS[fan],
      ]);
    }
  }
}
