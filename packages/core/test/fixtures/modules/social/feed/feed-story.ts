import {
  rebuildChainRead,
  seedChainRead,
  type ChainActivityRow,
  type ChainPresaleLifecycleRow,
  type ChainPresaleRow,
} from "../../database/chain-read-rows.ts";
import { advanceWatermark } from "../../database/role-fixtures.ts";
import { activityEntryId, lifecycleEntryId, milestoneEntryId } from "../../../../../src/modules/social/contracts/feed-entries.ts";

/**
 * A home-feed story for a disposable database: test and development seeding
 * only, never imported by application code. It needs the fixture
 * `chain_read_v1` (`CHAIN_FIXTURE`) and the web migrations, and it writes as
 * the database owner (`admin`). Every time counts back from `nowMs`, so the
 * story stays inside the For You window whenever it is seeded.
 *
 * Presales in each lifecycle; accounts in each naming state (sharing, a
 * default account, private, never onboarded, an unowned wallet); commits with
 * and without USD, claims with tokens and a refund and refund only, trades,
 * lifecycle and milestone posts; an active why, reactions and attributions;
 * user text with markup; items outside the window or the migrated cut-off;
 * and optional filler commits for paging.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;

function hex(tag: string): string {
  return `0x${tag.padStart(64, "0")}`;
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

export const FEED_STORY_QUOTE_TYPE = `${hex("2")}::usdc::USDC`;

export const FEED_STORY_PRESALES = {
  open: hex("5e0be5"),
  funded: hex("5ef5d"),
  pending: hex("5ebe5d"),
  migratedRecently: hex("5ea1a7"),
  migratedLongAgo: hex("5e01d"),
  cancelled: hex("5eca5c"),
} as const;

export const FEED_STORY_WALLETS = {
  kai: hex("1a2b0000000000000000000000009f0e"),
  nova: hex("50fa"),
  mallory: hex("3a11"),
  ghost: hex("9057"),
  late: hex("1a7e"),
  anon: hex("a505"),
} as const;

export const FEED_STORY_ACCOUNTS = {
  kai: uuid(0x701),
  nova: uuid(0x702),
  mallory: uuid(0x703),
  ghost: uuid(0x704),
  late: uuid(0x705),
} as const;

/** User text that must render literally: markup and a bare domain. */
export const FEED_STORY_MARKUP = "<b>x</b> see blast.fun";

export type FeedStoryOptions = Readonly<{
  nowMs: number;
  /** Extra small named commits, one per filler account, 3 h back and older, for paging. Default 0. */
  filler?: number;
  /**
   * How far behind `nowMs` both pipelines' watermark is committed. Default
   * 0. A negative age keeps a long-lived development database "fresh" for
   * that long (the fixture watermark is otherwise frozen at seeding time).
   */
  watermarkAgeMs?: number;
}>;

export type FeedStory = Readonly<{
  /** Entry ids by story name. */
  ids: Readonly<Record<StoryRowName | "openOpened" | "fundedFunded" | "migratedRecently" | "migratedLongAgo" | "cancelled" | "milestone", string>>;
  /** Filler entry ids, newest first. */
  filler: readonly string[];
}>;

function presale(id: string, symbol: string, lifecycle: ChainPresaleRow["lifecycle"], nowMs: number, endMs: number): ChainPresaleRow {
  return {
    presale_id: id, sale_token: `${id}::coin::${symbol}`, quote_type: FEED_STORY_QUOTE_TYPE, sale_symbol: symbol,
    sale_name: symbol.charAt(0) + symbol.slice(1).toLowerCase(), sale_icon_url: `https://i.blast.test/${symbol.toLowerCase()}.png`,
    sale_decimals: 9, quote_symbol: "USDC", quote_decimals: 6, lifecycle, start_ms: nowMs - 20 * DAY, end_ms: endMs,
    raise_target: "100000000000", min_commitment: "1000000", wallet_cap: null, total_commitments: "0", participants: 0,
    venue: "cetus", pool_id: null, updated_checkpoint: 20_000,
  };
}

type StoryRowName =
  | "kaiWhyCommit" | "kaiTieLow" | "kaiTieHigh" | "novaPlainCommit" | "novaNoUsdCommit" | "novaRefundOnly"
  | "kaiClaim" | "kaiBuy" | "malloryCommit" | "anonBigOpen" | "anonBigMigratedRecently" | "anonBigMigratedLongAgo"
  | "anonBigCancelled" | "anonSmallOpen" | "ghostSmallCommit" | "lateSmallCommit" | "kaiTooOld";

/** Seeds the story (replacing every fixture `chain_read_v1` row) and returns its entry ids. */
export async function seedFeedStory(
  admin: { query(text: string, values?: unknown[]): Promise<unknown> },
  options: FeedStoryOptions,
): Promise<FeedStory> {
  const { nowMs } = options;
  const P = FEED_STORY_PRESALES;
  const W = FEED_STORY_WALLETS;
  const A = FEED_STORY_ACCOUNTS;
  const ago = (minutes: number) => nowMs - minutes * MINUTE;
  let checkpoint = 30_000;
  const activity = (
    minutesAgo: number,
    kind: string,
    actor: string,
    presaleId: string,
    extra: Partial<ChainActivityRow> = {},
  ): ChainActivityRow => ({
    checkpoint: ++checkpoint, tx_slot: 0, event_slot: 0, part: 0, timestamp_ms: ago(minutesAgo),
    digest: `Fs${checkpoint}`.padEnd(44, "1"), kind, product: kind.startsWith("presale_") ? "presale" : "market",
    actor, tx_sender: actor, presale_id: presaleId, coin_type: `${presaleId}::coin::X`, quote_type: FEED_STORY_QUOTE_TYPE,
    quote_amount: "20000000", coin_amount: null, quote_refund: null, usd_value: "20", usd_price_as_of_ms: ago(minutesAgo) - 1_000,
    venue: null, participants_after: null, total_commitments_after: null, ...extra,
  });

  const tie = ago(12);
  const rows: Record<StoryRowName, ChainActivityRow> = {
    // 25 minutes old with an active why: ranks above a 10-minute-old plain item.
    kaiWhyCommit: activity(25, "presale_commit", W.kai, P.open, { usd_value: "50", quote_amount: "50000000" }),
    novaPlainCommit: activity(10, "presale_commit", W.nova, P.open),
    // Two items at the same time: the larger entry id ranks first.
    kaiTieLow: { ...activity(12, "presale_commit", W.kai, P.open), tx_slot: 1, timestamp_ms: tie },
    kaiTieHigh: { ...activity(12, "presale_commit", W.kai, P.open), tx_slot: 2, timestamp_ms: tie },
    novaNoUsdCommit: activity(30, "presale_commit", W.nova, P.funded, { usd_value: null, usd_price_as_of_ms: null }),
    novaRefundOnly: activity(35, "presale_claim", W.nova, P.cancelled, {
      quote_amount: "0", coin_amount: "0", quote_refund: "20000000", usd_value: null, usd_price_as_of_ms: null,
    }),
    kaiClaim: activity(50, "presale_claim", W.kai, P.migratedRecently, {
      quote_amount: "0", coin_amount: "250000000000", quote_refund: "5000000", usd_value: null, usd_price_as_of_ms: null,
    }),
    kaiBuy: activity(55, "trade_buy", W.kai, P.migratedRecently, { usd_value: "12.5", coin_amount: "900000000000" }),
    malloryCommit: activity(60, "presale_commit", W.mallory, P.open),
    // Presale posts by an unowned wallet: big commits and trades.
    anonBigOpen: activity(45, "presale_commit", W.anon, P.open, { usd_value: "5000", quote_amount: "5000000000" }),
    anonBigMigratedRecently: activity(70, "trade_sell", W.anon, P.migratedRecently, { usd_value: "1200", coin_amount: "40000000000" }),
    anonBigMigratedLongAgo: activity(80, "trade_buy", W.anon, P.migratedLongAgo, { usd_value: "3000" }),
    anonBigCancelled: activity(90, "presale_commit", W.anon, P.cancelled, { usd_value: "4000" }),
    // Unnamed person items: never candidates.
    anonSmallOpen: activity(15, "presale_commit", W.anon, P.open),
    ghostSmallCommit: activity(16, "presale_commit", W.ghost, P.open),
    lateSmallCommit: activity(17, "presale_commit", W.late, P.open),
    // Outside the 30-day window.
    kaiTooOld: activity(31 * 24 * 60, "presale_commit", W.kai, P.open),
  };

  const fillerCount = options.filler ?? 0;
  const fillerAccounts = Array.from({ length: fillerCount }, (_, n) => ({
    account: uuid(0x1000 + n),
    wallet: hex(`f111${n.toString(16).padStart(4, "0")}`),
    callsign: `crew_${String(n).padStart(3, "0")}`,
  }));
  const fillerRows = fillerAccounts.map((filler, n) =>
    activity(180 + n * 7, "presale_commit", filler.wallet, n % 2 ? P.funded : P.open, {
      usd_value: (25 + n).toFixed(2), quote_amount: String((25 + n) * 1_000_000),
    }));

  const lifecycle: ChainPresaleLifecycleRow[] = [
    { presale_id: P.open, state: "opened", digest: "LsOpen".padEnd(44, "1"), timestamp_ms: ago(120), checkpoint: 20_001 },
    { presale_id: P.funded, state: "funded", digest: "LsFund".padEnd(44, "1"), timestamp_ms: ago(240), checkpoint: 20_002 },
    { presale_id: P.migratedRecently, state: "migrated", digest: "LsMigR".padEnd(44, "1"), timestamp_ms: nowMs - 2 * DAY, checkpoint: 20_003 },
    { presale_id: P.migratedLongAgo, state: "migrated", digest: "LsMigO".padEnd(44, "1"), timestamp_ms: nowMs - 10 * DAY, checkpoint: 20_004 },
    { presale_id: P.cancelled, state: "cancelled", digest: "LsCanc".padEnd(44, "1"), timestamp_ms: ago(150), checkpoint: 20_005 },
  ];

  await rebuildChainRead(admin, {
    activity: [...Object.values(rows), ...fillerRows],
    presale_lifecycle: lifecycle,
    presales: [
      presale(P.open, "OPEN", "open", nowMs, nowMs + 3 * DAY),
      presale(P.funded, "FUND", "funded", nowMs, nowMs - DAY),
      presale(P.pending, "PEND", "pending", nowMs, nowMs + 10 * DAY),
      presale(P.migratedRecently, "MIGR", "migrated", nowMs, nowMs - 3 * DAY),
      presale(P.migratedLongAgo, "AGED", "migrated", nowMs, nowMs - 11 * DAY),
      presale(P.cancelled, "CANC", "cancelled", nowMs, nowMs - DAY),
    ],
  });
  const ageMs = options.watermarkAgeMs ?? 0;
  await admin.query(advanceWatermark(40_000, ageMs, "market"));
  await admin.query(advanceWatermark(40_000, ageMs, "presale"));

  const since = new Date(nowMs - 60 * DAY).toISOString();
  // [account, callsign, display name, privacy, sharing since, wallet]
  const accounts: readonly (readonly [string, string, string, "public" | "private", string | null, string])[] = [
    [A.kai, "kai", "Kai", "public", since, W.kai],
    [A.nova, "nova", "Nova", "public", since, W.nova],
    [A.mallory, "mallory", FEED_STORY_MARKUP, "public", since, W.mallory],
    [A.ghost, "ghost", "Ghost", "private", null, W.ghost],
    [A.late, "late_one", "Late", "public", null, W.late],
    ...fillerAccounts.map((filler, n) => [filler.account, filler.callsign, `Crew ${n}`, "public", since, filler.wallet] as const),
  ];
  for (const [account, callsign, displayName, privacy, sharingSince, wallet] of accounts) {
    await admin.query(
      // Each story account signed up with X, so it is verified (OA-8).
      `INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, x_subject, x_handle, privacy, sharing_since, onboarded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [account, `did:privy:feed-story-${callsign}`, callsign, displayName, `x-${callsign}`, `${callsign}_x`, privacy, sharingSince, sharingSince],
    );
    await admin.query("INSERT INTO social_account_wallets (address, account_id, verified_at) VALUES ($1, $2, $3)", [wallet, account, since]);
  }
  // Nova is a default account: her named items are candidates through the same rule as everyone's.
  await admin.query("INSERT INTO social_default_accounts (position, account_id) VALUES (1, $1)", [A.nova]);

  const id = (name: StoryRowName) => {
    const row = rows[name];
    return activityEntryId(`${row.checkpoint}:${row.tx_slot}:${row.event_slot}:${row.part}`);
  };
  const milestone = milestoneEntryId(P.open, "participants", "10");
  await admin.query(
    "INSERT INTO social_milestones (entry_id, presale_id, kind, value, timestamp_ms) VALUES ($1, $2, 'participants', 10, $3)",
    [milestone, P.open, ago(100)],
  );
  await admin.query(
    `INSERT INTO social_whys (why_id, entry_id, author_account_id, text) VALUES ($1, $2, $3, $4)`,
    [uuid(0x7a1), id("kaiWhyCommit"), A.kai, `Team shipped on time twice. ${FEED_STORY_MARKUP}`],
  );
  await admin.query(
    `INSERT INTO social_reactions (entry_id, account_id, reaction) VALUES ($1, $2, 'fire'), ($1, $3, 'fire'), ($1, $3, 'rocket')`,
    [id("kaiWhyCommit"), A.nova, A.mallory],
  );
  const attribution = `INSERT INTO social_attributions
      (tx_digest, entry_id, author_account_id, actor_account_id, action, presale_id, quote_amount, usd_value, occurred_at_ms)
    VALUES ($1, $2, $3, $4, 'commit', $5, '100000000', $6, $7)`;
  await admin.query(attribution, ["FsAttr1".padEnd(44, "1"), id("kaiWhyCommit"), A.kai, A.nova, P.open, "100", ago(20)]);
  await admin.query(attribution, ["FsAttr2".padEnd(44, "1"), id("kaiWhyCommit"), A.kai, A.mallory, P.open, "50", ago(19)]);

  return {
    ids: {
      ...(Object.fromEntries(Object.keys(rows).map((name) => [name, id(name as StoryRowName)])) as Record<StoryRowName, string>),
      openOpened: lifecycleEntryId(P.open, "opened"),
      fundedFunded: lifecycleEntryId(P.funded, "funded"),
      migratedRecently: lifecycleEntryId(P.migratedRecently, "migrated"),
      migratedLongAgo: lifecycleEntryId(P.migratedLongAgo, "migrated"),
      cancelled: lifecycleEntryId(P.cancelled, "cancelled"),
      milestone,
    },
    filler: fillerRows.map((row) => activityEntryId(`${row.checkpoint}:${row.tx_slot}:${row.event_slot}:${row.part}`)),
  };
}

/**
 * Sales the web never shows, seeded the way blast-infra hides them, for the
 * T-043 hidden-sale tests of every feed reader:
 *
 * - `excluded`: one of T-043's real-SUI test sales, whose coin's package is
 *   in `BLAST_EXCLUDED_SALE_PACKAGES`. blast-infra leaves it out of
 *   `chain_read_v1.presales` and the other presale views (so it has no
 *   `presales` or `presale_lifecycle` row here) but deliberately keeps its
 *   `chain_read_v1.activity` rows.
 * - `incomplete`: a sale whose coin metadata has not arrived: in `presales`
 *   (with a lifecycle row), but not in `SHOWN_PRESALES`.
 */
export const FEED_STORY_HIDDEN = {
  excluded: hex("5650e2"),
  /** The excluded sale's coin: the test package's `sale_tokens` module (`SALE_B`). */
  excludedCoin: `${hex("5650d58030f361f6")}::sale_tokens::SALE_B`,
  incomplete: hex("5e1c0e"),
  incompleteCoin: `${hex("5e1c0e")}::coin::INC`,
} as const;

type HiddenRowName =
  | "kaiCommit" | "kaiBigCommit" | "novaClaim" | "kaiBuy" | "kaiSellStamped" | "anonBigCommit"
  | "kaiIncompleteCommit" | "novaIncompleteBigCommit";

export type HiddenSaleStory = Readonly<{
  /** Entry ids by name: the hidden sales' activity, the incomplete sale's lifecycle post and each sale's milestone post. */
  ids: Readonly<Record<HiddenRowName | "incompleteOpened" | "excludedMilestone" | "incompleteMilestone", string>>;
  /** The activity rows, newest first. */
  rows: readonly ChainActivityRow[];
}>;

/**
 * Appends the hidden sales to a seeded feed story (`seedFeedStory` first).
 * Every row is newer than the story's newest item, so a reader that keeps
 * one shows it first, and every kind a reader could keep is there: small and
 * big named commits, a named claim, the excluded coin's trades (unstamped,
 * and stamped with the sale as T-038 does, big), a big commit by an unowned
 * wallet (a presale post), named commits to the incomplete sale, the
 * incomplete sale's lifecycle post, each sale's milestone post (as the
 * milestone step wrote them before 2026-10-05), and Kai's active why on his
 * commit to the excluded sale (as the whys route accepted it).
 */
export async function seedHiddenSales(
  admin: { query(text: string, values?: unknown[]): Promise<unknown> },
  options: Readonly<{ nowMs: number }>,
): Promise<HiddenSaleStory> {
  const { nowMs } = options;
  const H = FEED_STORY_HIDDEN;
  const W = FEED_STORY_WALLETS;
  const ago = (minutes: number) => nowMs - minutes * MINUTE;
  let checkpoint = 38_000;
  const activity = (minutesAgo: number, kind: string, actor: string, presaleId: string | null, coin: string, extra: Partial<ChainActivityRow> = {}): ChainActivityRow => ({
    checkpoint: ++checkpoint, tx_slot: 0, event_slot: 0, part: 0, timestamp_ms: ago(minutesAgo),
    digest: `Hs${checkpoint}`.padEnd(44, "1"), kind, product: kind.startsWith("presale_") ? "presale" : "market",
    actor, tx_sender: actor, presale_id: presaleId, coin_type: coin, quote_type: FEED_STORY_QUOTE_TYPE,
    quote_amount: "20000000", coin_amount: null, quote_refund: null, usd_value: "20", usd_price_as_of_ms: ago(minutesAgo) - 1_000,
    venue: null, participants_after: null, total_commitments_after: null, ...extra,
  });
  const rows: Record<HiddenRowName, ChainActivityRow> = {
    kaiCommit: activity(1, "presale_commit", W.kai, H.excluded, H.excludedCoin),
    kaiBigCommit: activity(2, "presale_commit", W.kai, H.excluded, H.excludedCoin, { usd_value: "5000", quote_amount: "5000000000" }),
    novaClaim: activity(3, "presale_claim", W.nova, H.excluded, H.excludedCoin, {
      quote_amount: "0", coin_amount: "250000000000", quote_refund: "0", usd_value: null, usd_price_as_of_ms: null,
    }),
    kaiBuy: activity(4, "trade_buy", W.kai, null, H.excludedCoin, { usd_value: "12.5", coin_amount: "900000000000" }),
    kaiSellStamped: activity(5, "trade_sell", W.kai, H.excluded, H.excludedCoin, { usd_value: "1500", coin_amount: "40000000000" }),
    anonBigCommit: activity(6, "presale_commit", W.anon, H.excluded, H.excludedCoin, { usd_value: "5000", quote_amount: "5000000000" }),
    kaiIncompleteCommit: activity(7, "presale_commit", W.kai, H.incomplete, H.incompleteCoin),
    novaIncompleteBigCommit: activity(8, "presale_commit", W.nova, H.incomplete, H.incompleteCoin, { usd_value: "4000", quote_amount: "4000000000" }),
  };
  await seedChainRead(admin, {
    activity: Object.values(rows),
    presales: [{
      ...presale(H.incomplete, "INC", "open", nowMs, nowMs + 3 * DAY),
      sale_token: H.incompleteCoin, sale_symbol: null, sale_name: null, sale_icon_url: null, sale_decimals: null,
    }],
    presale_lifecycle: [{ presale_id: H.incomplete, state: "opened", digest: "LsInc".padEnd(44, "1"), timestamp_ms: ago(9), checkpoint: 20_010 }],
  });
  const id = (name: HiddenRowName) => {
    const row = rows[name];
    return activityEntryId(`${row.checkpoint}:${row.tx_slot}:${row.event_slot}:${row.part}`);
  };
  const excludedMilestone = milestoneEntryId(H.excluded, "participants", "10");
  const incompleteMilestone = milestoneEntryId(H.incomplete, "participants", "10");
  await admin.query(
    `INSERT INTO social_milestones (entry_id, presale_id, kind, value, timestamp_ms)
     VALUES ($1, $2, 'participants', 10, $3), ($4, $5, 'participants', 10, $6)`,
    [excludedMilestone, H.excluded, ago(2), incompleteMilestone, H.incomplete, ago(7)],
  );
  await admin.query(
    "INSERT INTO social_whys (why_id, entry_id, author_account_id, text) VALUES ($1, $2, $3, 'A thesis on a test sale')",
    [uuid(0x7c1), id("kaiCommit"), FEED_STORY_ACCOUNTS.kai],
  );
  return {
    ids: {
      ...(Object.fromEntries(Object.keys(rows).map((name) => [name, id(name as HiddenRowName)])) as Record<HiddenRowName, string>),
      incompleteOpened: lifecycleEntryId(H.incomplete, "opened"),
      excludedMilestone,
      incompleteMilestone,
    },
    rows: Object.values(rows),
  };
}

/** Matches any trace of the hidden sales in a JSON body: their ids, the excluded coin's package, the incomplete sale's symbol. */
export const FEED_STORY_HIDDEN_TEXT = new RegExp(
  [FEED_STORY_HIDDEN.excluded, FEED_STORY_HIDDEN.incomplete].map((id) => id.slice(2).replace(/^0+/, "")).join("|") + "|5650d58030f361f6|SALE_B|::INC",
);
