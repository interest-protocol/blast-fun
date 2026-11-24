import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import type {
  RateLimitPort,
} from "@blast/core/lib/web-security/rate-limits.ts";
import type {
  ChainRewardPayoutRow,
} from "../../../../../core/test/fixtures/modules/database/chain-read-rows.ts";
import {
  createPool,
  createRuntimePool,
} from "@blast/core/modules/database/pool.ts";
import {
  FIXTURE_NETWORK,
  urlAs,
} from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import type { SocialRewardsPage } from "@blast/core/modules/social/contracts/rewards.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import {
  FEED_STORY_ACCOUNTS,
  FEED_STORY_PRESALES,
  FEED_STORY_WALLETS,
  seedFeedStory,
} from "../../../../../core/test/fixtures/modules/social/feed/feed-story.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import type { RewardsWaitingReader, WaitingAllocation } from "@blast/server/modules/social/rewards/read.ts";
import { createSocialRewardsRoute } from "@blast/server/modules/social/rewards/route.ts";
import { hex } from "../../../../../core/test/kit.ts";

/**
 * OA-45: `GET /api/social/me/rewards` over a disposable database (the
 * fixture `chain_read_v1` with blast-infra's `vault_reward_payouts` view
 * mirrored, the web migrations and the feed story), as `blast_web` on the
 * primary. Kai holds two wallets; payouts come from the view, the published
 * round count from native publications, and what waits from the reward
 * relay's reader (`waitingRewardsFor`, feat/reward-delivery), stubbed here in
 * its result shape.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl
  ? false
  : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-rewards-app";
const PEPPER = "social-rewards-fixture-pepper-0123456789abcdef";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();
const POOL = {
  connectionTimeoutMs: 5_000,
  idleInTransactionMs: 5_000,
  idleTimeoutMs: 1_000,
  lockTimeoutMs: 2_000,
  max: 6,
  statementTimeoutMs: 5_000,
};
const NOW = Date.now();
const HOUR = 3_600_000;
const PRIVATE = "private, no-store";
const W = FEED_STORY_WALLETS;
const MIGR = FEED_STORY_PRESALES.migratedRecently;
const AGED = FEED_STORY_PRESALES.migratedLongAgo;
const KAI2 = hex("ca12");
const RELAYER = hex("2e1a7");
const digest = (seed: string) => seed.padEnd(44, "1");

function bearer(did: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({
    aud: APP_ID,
    exp: now + 3_600,
    iat: now - 60,
    iss: "privy.io",
    sid: "s-1",
    sub: did,
  });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
    dsaEncoding: "ieee-p1363",
    key: keys.privateKey,
  });
  return `Bearer ${header}.${payload}.${signature.toString("base64url")}`;
}
const KAI = bearer("did:privy:feed-story-kai");
const NOVA = bearer("did:privy:feed-story-nova");
const STRANGER = bearer("did:privy:nobody-here");

/** Native indexed publications; an abandoned local plan has no publication fact. */
type Round = Readonly<{
  presale: string;
  number: number;
  roundId: string;
  state?: "published" | "abandoned";
  network?: string;
  deadlineMs?: number;
}>;

const ROUND = {
  migrExpired: hex("40e0"),
  migr1: hex("40e1"),
  migr2: hex("40e2"),
  migr3: hex("40e3"),
  migrAbandoned: hex("40ea"),
  aged0: hex("a6e0"),
  aged1: hex("a6e1"),
  testnet: hex("7e57"),
};

const ROUNDS: readonly Round[] = [
  // Its deadline passed unpaid: counted as a published round, never owed.
  {
    presale: MIGR,
    number: 0,
    roundId: ROUND.migrExpired,
    deadlineMs: NOW - HOUR,
  },
  {
    presale: MIGR,
    number: 1,
    roundId: ROUND.migr1,
  },
  {
    presale: MIGR,
    number: 2,
    roundId: ROUND.migr2,
  },
  // The open round: Kai's share is owed, to be relayed.
  {
    presale: MIGR,
    number: 3,
    roundId: ROUND.migr3,
  },
  // Abandoned before it published: never owed, never counted.
  {
    presale: MIGR,
    number: 4,
    roundId: ROUND.migrAbandoned,
    state: "abandoned",
  },
  {
    presale: AGED,
    number: 0,
    roundId: ROUND.aged0,
  },
  // Positive small shares enter automatic delivery.
  {
    presale: AGED,
    number: 1,
    roundId: ROUND.aged1,
  },
  // Another network's round is not this deployment's.
  {
    presale: AGED,
    number: 2,
    roundId: ROUND.testnet,
    network: "testnet",
  },
];

const payout = (
  row: Partial<ChainRewardPayoutRow> &
    Pick<
      ChainRewardPayoutRow,
      | "presale_id"
      | "round_id"
      | "round_number"
      | "index"
      | "beneficiary"
      | "checkpoint"
    >,
): ChainRewardPayoutRow => ({
  meme_amount: "1",
  quote_amount: "1",
  digest: digest(`Rw${row.checkpoint}x${row.index}`.replace(/0/g, "z")),
  timestamp_ms: NOW - HOUR,
  relayed_by: RELAYER,
  tx_slot: 0,
  event_slot: 0,
  ...row,
});

const PAYOUTS = {
  migr1: payout({
    presale_id: MIGR,
    round_id: ROUND.migr1,
    round_number: 1,
    index: "3",
    beneficiary: W.kai,
    meme_amount: "1254000000000",
    quote_amount: "2100000",
    checkpoint: 100,
    timestamp_ms: NOW - 30 * HOUR,
  }),
  // Kai's second wallet claimed its own share.
  migr2: payout({
    presale_id: MIGR,
    round_id: ROUND.migr2,
    round_number: 2,
    index: "1",
    beneficiary: KAI2,
    meme_amount: "1561000000000",
    quote_amount: "2200000",
    checkpoint: 200,
    tx_slot: 1,
    event_slot: 0,
    timestamp_ms: NOW - 18 * HOUR,
    relayed_by: KAI2,
  }),
  // The same transaction's next event: AGED's first round.
  aged0: payout({
    presale_id: AGED,
    round_id: ROUND.aged0,
    round_number: 0,
    index: "5",
    beneficiary: W.kai,
    meme_amount: "257000000000",
    quote_amount: "350000",
    checkpoint: 200,
    tx_slot: 1,
    event_slot: 1,
    timestamp_ms: NOW - 18 * HOUR,
  }),
  // Nova's: never Kai's.
  nova: payout({
    presale_id: MIGR,
    round_id: ROUND.migr1,
    round_number: 1,
    index: "4",
    beneficiary: W.nova,
    checkpoint: 300,
  }),
};

/** The relay's waiting leaves, as `waitingRewardsFor` answers them (by beneficiary; the reader filters by the wallets asked). */
type Leaf = Readonly<{
  presale: string;
  roundId: string;
  leafIndex: number;
  beneficiary: string;
  meme: string;
  quote: string;
  reason: "next" | "unpayable";
  deadlineMs?: number;
}>;
const LEAVES: readonly Leaf[] = [
  // Paid already (the view shows round 1's leaf 3): the relay drops it on its next read, the route at once.
  {
    presale: MIGR,
    roundId: ROUND.migr1,
    leafIndex: 3,
    beneficiary: W.kai,
    meme: "1254000000000",
    quote: "2100000",
    reason: "next",
  },
  // Past its claim deadline: anyone may close the round.
  {
    presale: MIGR,
    roundId: ROUND.migrExpired,
    leafIndex: 0,
    beneficiary: W.kai,
    meme: "70000000000",
    quote: "100000",
    reason: "next",
    deadlineMs: NOW - HOUR,
  },
  // The open round: Kai's share goes out on the next pass.
  {
    presale: MIGR,
    roundId: ROUND.migr3,
    leafIndex: 0,
    beneficiary: W.kai,
    meme: "410000000000",
    quote: "1020000",
    reason: "next",
  },
  {
    presale: MIGR,
    roundId: ROUND.migr3,
    leafIndex: 2,
    beneficiary: W.nova,
    meme: "5",
    quote: "5",
    reason: "next",
  },
  // Positive shares from both wallets are queued; one failed-delivery leaf is set aside.
  {
    presale: AGED,
    roundId: ROUND.aged1,
    leafIndex: 6,
    beneficiary: W.kai,
    meme: "94000000000",
    quote: "140000",
    reason: "next",
  },
  {
    presale: AGED,
    roundId: ROUND.aged1,
    leafIndex: 7,
    beneficiary: KAI2,
    meme: "1000000000",
    quote: "0",
    reason: "next",
  },
  {
    presale: AGED,
    roundId: ROUND.aged1,
    leafIndex: 8,
    beneficiary: W.kai,
    meme: "5",
    quote: "5",
    reason: "unpayable",
  },
  // A shown sale with nothing paid yet, only waiting.
  {
    presale: FEED_STORY_PRESALES.open,
    roundId: hex("0be40"),
    leafIndex: 0,
    beneficiary: W.kai,
    meme: "7000000000",
    quote: "7",
    reason: "next",
  },
  // A sale the web does not show.
  {
    presale: hex("dead5a1e"),
    roundId: hex("dead40f"),
    leafIndex: 1,
    beneficiary: W.kai,
    meme: "9",
    quote: "9",
    reason: "next",
  },
];

function relayReader(state: {
  failing: boolean;
  calls: string[][];
}): RewardsWaitingReader {
  return async (wallets) => {
    state.calls.push([...wallets]);
    if (state.failing) throw new Error("Daily waiting reader is unavailable");
    const byPresale = new Map<string, WaitingAllocation[]>();
    for (const leaf of LEAVES.filter((row) =>
      wallets.includes(row.beneficiary),
    )) {
      const list = byPresale.get(leaf.presale) ?? [];
      list.push({
        roundId: leaf.roundId,
        leafIndex: leaf.leafIndex,
        memeAmount: leaf.meme,
        quoteAmount: leaf.quote,
        reason: leaf.reason,
        claimDeadlineMs: leaf.deadlineMs ?? NOW + 7 * 24 * HOUR,
      });
      byPresale.set(leaf.presale, list);
    }
    return [...byPresale].map(([presaleId, allocations]) => ({
      presaleId,
      allocations,
    }));
  };
}

const VAULT_IDS = new Map([
  [MIGR, hex("a101")],
  [AGED, hex("a102")],
  [FEED_STORY_PRESALES.open, hex("a103")],
]);

async function seedPayout(admin: Pool, vaultId: string, row: ChainRewardPayoutRow): Promise<void> {
  await admin.query(
    `INSERT INTO blast_infra_fixture.vault_reward_payouts
      (round_id,index,vault_id,beneficiary,meme_amount,quote_amount,checkpoint,tx_slot,event_slot,timestamp_ms,tx_digest,relayed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [row.round_id,row.index,vaultId,row.beneficiary,row.meme_amount,row.quote_amount,row.checkpoint,
      row.tx_slot,row.event_slot,row.timestamp_ms,row.digest,row.relayed_by],
  );
}

async function seedRewards(admin: Pool): Promise<void> {
  await admin.query(`
    INSERT INTO blast_infra_fixture.coin_metadata (coin_type,name,symbol,icon_url,decimals)
    SELECT DISTINCT ON (sale_token) sale_token,sale_name,sale_symbol,sale_icon_url,sale_decimals
    FROM blast_infra_fixture.presales ORDER BY sale_token,presale_id
    ON CONFLICT (coin_type) DO NOTHING;
    INSERT INTO blast_infra_fixture.coin_metadata (coin_type,symbol,decimals)
    SELECT DISTINCT ON (quote_type) quote_type,quote_symbol,quote_decimals
    FROM blast_infra_fixture.presales ORDER BY quote_type,presale_id
    ON CONFLICT (coin_type) DO NOTHING;`);
  for (const [presaleId, vaultId] of VAULT_IDS) {
    await admin.query(
      `INSERT INTO blast_infra_fixture.vaults
        (vault_id,origin_kind,origin_id,meme_type,venue_type,pool_id,quote_type,created_checkpoint)
       SELECT $2,'presale',presale_id,sale_token,'cetus',$2,quote_type,1
       FROM blast_infra_fixture.presales WHERE presale_id=$1`,
      [presaleId, vaultId],
    );
  }
  for (const round of ROUNDS) {
    if (round.state === "abandoned" || (round.network && round.network !== FIXTURE_NETWORK))
      continue;
    await admin.query(
      "INSERT INTO blast_infra_fixture.vault_rounds VALUES ($1,$2,$3)",
      [round.roundId, VAULT_IDS.get(round.presale), round.number],
    );
  }
  for (const row of Object.values(PAYOUTS)) {
    const vaultId = VAULT_IDS.get(row.presale_id);
    if (vaultId) await seedPayout(admin, vaultId, row);
  }
}

type Fixture = Readonly<{
  admin: Pool;
  limiter: { full: boolean };
  relay: { failing: boolean; calls: string[][] };
  get(query?: string, authorization?: string): Promise<Response>;
}>;

async function withFixture(
  run: (fixture: Fixture) => Promise<void>,
  network: string | null = FIXTURE_NETWORK,
): Promise<void> {
  const database = await freshTestDatabase();
  const { url } = database;
  const admin = createPool(url, { max: 4 });
  await seedFeedStory(admin, { nowMs: NOW });
  await admin.query(
    "INSERT INTO social_account_wallets (address, account_id, verified_at) VALUES ($1, $2, now())",
    [KAI2, FEED_STORY_ACCOUNTS.kai],
  );
  await seedRewards(admin);
  const web = createRuntimePool(
    urlAs(url, "blast_web"),
    POOL,
    "social-rewards-web",
  );
  try {
    const real = new PostgresRateLimitEnforcer({
      pool: web,
      subjectPepper: PEPPER,
    });
    const limiter = { full: false };
    const port: RateLimitPort = {
      consume: async (bucket, subject) =>
        limiter.full
          ? { allowed: false, bucket, policyVersion: 1, retryAfterSeconds: 17 }
          : real.consume(bucket, subject),
    };
    const accounts = new PostgresSocialAccounts(() => web);
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({
        appId: APP_ID,
        verificationKey: keys.publicKey
          .export({ format: "pem", type: "spki" })
          .toString(),
      }),
      limiter: port,
      accounts,
      primary: () => web,
    });
    const primary = autocommitReader(web, "social");
    const relay = { failing: false, calls: [] as string[][] };
    const route = createSocialRewardsRoute({
      kit,
      wallets: accounts,
      database: () => primary,
      network,
      waiting: () => relayReader(relay),
      now: () => NOW,
    });
    await run({
      admin,
      limiter,
      relay,
      get: (query = "", authorization = KAI) =>
        route.GET(
          new Request(`${ORIGIN}/api/social/me/rewards${query}`, {
            headers: { "x-forwarded-for": "203.0.113.45", authorization },
          }), testClient("203.0.113.45")
        ),
    });
  } finally {
    await Promise.all([admin.end(), web.end()]);
    await database.drop();
  }
}

async function page(response: Response): Promise<SocialRewardsPage> {
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate("rewards-page", body).errors, []);
  assert.equal(response.headers.get("cache-control"), PRIVATE);
  return body as SocialRewardsPage;
}

async function refused(
  response: Response,
  status: number,
  code: string,
): Promise<void> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error.code, code);
  assert.deepEqual(validator.validate("error", body).errors, []);
  assert.equal(response.headers.get("cache-control"), PRIVATE);
}

const digestsOf = (body: SocialRewardsPage) =>
  body.payouts.map((row) => row.digest);

test(
  "OA-45: the first page — every wallet's payouts newest first by chain position, who sent each, and the per-sale summary",
  { skip },
  async () => {
    await withFixture(async ({ get }) => {
      const body = await page(await get());
      assert.deepEqual(digestsOf(body), [
        PAYOUTS.aged0.digest,
        PAYOUTS.migr2.digest,
        PAYOUTS.migr1.digest,
      ]);
      assert.deepEqual(body.payouts[1], {
        presale_id: MIGR,
        round_id: ROUND.migr2,
        round_number: "2",
        meme_amount: "1561000000000",
        quote_amount: "2200000",
        digest: PAYOUTS.migr2.digest,
        timestamp_ms: NOW - 18 * HOUR,
        relayed_by: KAI2,
        self_claimed: true,
      });
      assert.deepEqual(
        body.payouts.map((row) => row.self_claimed),
        [false, true, false],
      );
      assert.equal(body.next_cursor, null);

      assert.ok(body.coins);
      const [migr, aged, open] = [MIGR, AGED, FEED_STORY_PRESALES.open].map(
        (id) => body.coins!.find((coin) => coin.presale_id === id)!,
      );
      // MIGR and AGED paid; OPEN only waits.
      assert.deepEqual(
        body.coins.map((coin) => coin.presale_id).sort(),
        [MIGR, AGED, FEED_STORY_PRESALES.open].sort(),
      );
      assert.equal(body.coins.at(-1)!.presale_id, FEED_STORY_PRESALES.open);
      // Native publications on the selected network (closed/expired counts, abandoned and another network do not).
      assert.deepEqual(migr, {
        presale_id: MIGR,
        name: "Migr",
        symbol: "MIGR",
        icon_url: "https://i.blast.test/migr.png",
        sale_decimals: 9,
        quote_type: migr!.quote_type,
        quote_symbol: "USDC",
        quote_decimals: 6,
        rounds: 4,
        payouts: 2,
        received: { meme: "2815000000000", quote: "4300000" },
        last_payout_ms: NOW - 18 * HOUR,
        waiting: {
          next: { meme: "410000000000", quote: "1020000" },
          unpayable: null,
        },
      });
      assert.equal(aged!.rounds, 2);
      assert.equal(aged!.payouts, 1);
      assert.deepEqual(aged!.received, {
        meme: "257000000000",
        quote: "350000",
      });
      assert.deepEqual(aged!.waiting, {
        next: { meme: "95000000000", quote: "140000" },
        unpayable: { meme: "5", quote: "5" },
      });
      assert.deepEqual(
        [
          open!.payouts,
          open!.rounds,
          open!.last_payout_ms,
          open!.received,
          open!.waiting,
        ],
        [
          0,
          null,
          null,
          { meme: "0", quote: "0" },
          { next: { meme: "7000000000", quote: "7" }, unpayable: null },
        ],
      );
    });
  },
);

test(
  "OA-45: keyset pages, a sale's own payouts, and no summary past the first page",
  { skip },
  async () => {
    await withFixture(async ({ get }) => {
      const first = await page(await get("?limit=2"));
      assert.deepEqual(digestsOf(first), [
        PAYOUTS.aged0.digest,
        PAYOUTS.migr2.digest,
      ]);
      assert.ok(first.next_cursor);
      assert.ok(first.coins);
      const second = await page(
        await get(`?limit=2&cursor=${first.next_cursor}`),
      );
      assert.deepEqual(digestsOf(second), [PAYOUTS.migr1.digest]);
      assert.equal(second.next_cursor, null);
      assert.equal(second.coins, null);

      const sale = await page(await get(`?presale=${MIGR}&limit=1`));
      assert.deepEqual(digestsOf(sale), [PAYOUTS.migr2.digest]);
      assert.equal(sale.coins, null);
      const saleNext = await page(
        await get(`?presale=${MIGR}&limit=1&cursor=${sale.next_cursor}`),
      );
      assert.deepEqual(digestsOf(saleNext), [PAYOUTS.migr1.digest]);
      assert.equal(saleNext.next_cursor, null);
    });
  },
);

test(
  "OA-45: a payout the view shows for a waiting leaf takes it out of the waiting share",
  { skip },
  async () => {
    await withFixture(async ({ admin, get }) => {
      await seedPayout(admin, VAULT_IDS.get(MIGR)!, payout({
        presale_id: MIGR,
        round_id: ROUND.migr3,
        round_number: 3,
        index: "0",
        beneficiary: W.kai,
        meme_amount: "410000000000",
        quote_amount: "1020000",
        checkpoint: 400,
      }));
      const body = await page(await get());
      const migr = body.coins!.find((coin) => coin.presale_id === MIGR)!;
      assert.equal(migr.waiting, null);
      assert.equal(migr.payouts, 3);
      assert.equal(body.payouts[0]!.round_id, ROUND.migr3);
    });
  },
);

test(
  "OA-45: another account sees only its own; nothing is empty, not an error",
  { skip },
  async () => {
    await withFixture(async ({ get }) => {
      const nova = await page(await get("", NOVA));
      assert.deepEqual(digestsOf(nova), [PAYOUTS.nova.digest]);
      // Nova's waiting leaf in the open round (its paid leaf in round 1 is a payout).
      assert.deepEqual(
        nova.coins!.map((coin) => [
          coin.presale_id,
          coin.payouts,
          coin.waiting,
        ]),
        [[MIGR, 1, { next: { meme: "5", quote: "5" }, unpayable: null }]],
      );
    });
  },
);

test(
  "OA-45: the relay's record unreadable, or no network: no waiting line, the rest as ever; the reader is asked only on a summary page",
  { skip },
  async () => {
    await withFixture(async ({ get, relay }) => {
      const first = await page(await get());
      assert.equal(relay.calls.length, 1);
      assert.deepEqual([...relay.calls[0]!].sort(), [W.kai, KAI2].sort());
      await page(await get(`?presale=${MIGR}`));
      assert.equal(relay.calls.length, 1);
      relay.failing = true;
      const failed = await page(await get());
      assert.deepEqual(
        failed.coins!.map((coin) => coin.waiting),
        [null, null],
      );
      assert.deepEqual(digestsOf(failed), digestsOf(first));
    });
    await withFixture(async ({ get, relay }) => {
      const body = await page(await get());
      assert.equal(relay.calls.length, 0);
      assert.deepEqual(
        body.coins!.map((coin) => [coin.rounds, coin.waiting]),
        [
          [null, null],
          [null, null],
        ],
      );
    }, null);
  },
);

test(
  "OA-45: refusals — no token, no account, a malformed parameter, the rate limit",
  { skip },
  async () => {
    await withFixture(async ({ get, limiter }) => {
      await refused(await get("", ""), 401, "unauthorized");
      await refused(await get("", STRANGER), 409, "account_required");
      await refused(await get("?limit=0"), 400, "invalid_parameter");
      await refused(await get("?presale=nope"), 400, "invalid_parameter");
      await refused(await get("?cursor=%%%"), 400, "invalid_parameter");
      limiter.full = true;
      const limited = await get();
      await refused(limited, 429, "rate_limited");
    });
  },
);


test("standalone vault rewards stay isolated by vault id", { skip }, async () => {
  await withFixture(async ({ admin, get }) => {
    const a = hex("c101"), b = hex("c102");
    const memeType = `${hex("c100")}::m::M`;
    const quoteType = `${hex("d".repeat(64))}::usdc::USDC`;
    await admin.query(
      `INSERT INTO blast_infra_fixture.coin_metadata (coin_type,name,symbol,decimals)
       VALUES ($1,'Standalone','SOLO',9),($2,'USD Coin','USDC',6) ON CONFLICT DO NOTHING`,
      [memeType, quoteType],
    );
    for (const [id, amount, slot] of [[a,"700",10],[b,"900",11]] as const) {
      await admin.query(
        `INSERT INTO blast_infra_fixture.vaults
          (vault_id,origin_id,meme_type,venue_type,pool_id,quote_type,created_checkpoint)
         VALUES ($1,$1,$2,'cetus',$1,$3,1)`,
        [id, memeType, quoteType],
      );
      await admin.query("INSERT INTO blast_infra_fixture.vault_rounds VALUES ($1,$1,0)", [id]);
      await seedPayout(admin, id, {
        ...payout({ presale_id: hex("0"), round_id: id, round_number: 0, index: "0", beneficiary: KAI2, checkpoint: 99_999 }),
        meme_amount: "0",
        quote_amount: amount,
        digest: PAYOUTS.migr2.digest,
        timestamp_ms: NOW,
        relayed_by: KAI2,
        event_slot: slot,
      });
    }
    const summary = await page(await get());
    const standalone = summary.coins!.filter((coin)=>coin.presale_id===null);
    assert.deepEqual(standalone.map((coin)=>[coin.vault_id,coin.received.quote]).sort(),[[a,"700"],[b,"900"]]);
    assert.ok(standalone.every((coin)=>coin.source_id===coin.vault_id));
    const selected = await page(await get(`?vault=${a}&limit=1`));
    assert.equal(selected.coins,null);
    assert.equal(selected.next_cursor,null);
    assert.deepEqual(selected.payouts.map((payout)=>[payout.vault_id,payout.presale_id,payout.quote_amount]),[[a,null,"700"]]);
    await refused(await get(`?vault=${a}&presale=${MIGR}`),400,"invalid_parameter");
  });
});
