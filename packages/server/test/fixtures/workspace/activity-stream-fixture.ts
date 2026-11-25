import { generateKeyPairSync, sign } from "node:crypto";
import {
  createPool,
  createRuntimePool,
} from "@blast/core/modules/database/pool.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { SOCIAL_CONFIG_DEFAULTS } from "@blast/core/modules/social/contracts/config.ts";
import {
  seedChainRead,
  type ChainActivityRow,
  type ChainPresaleRow,
} from "../../../../core/test/fixtures/modules/database/chain-read-rows.ts";
import { urlAs } from "../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { createSocialHomeRoutes } from "@blast/server/modules/social/home/route.ts";
import { createSocialFeedRoute } from "@blast/server/modules/social/feed/route.ts";
import { createSocialPresaleRoutes } from "@blast/server/modules/social/presales/route.ts";
import { createSocialBuyAlertRoutes } from "@blast/server/modules/social/buy-alerts/route.ts";
import { createReadCache } from "@blast/server/modules/social/read-cache.ts";
import type { HomeActivityStreamPage } from "@blast/core/modules/social/contracts/home.ts";
export const activityOrigin = "http://127.0.0.1:42916";
export const activityParameters = {
  version: 1,
  ties: 24,
  maximum_rows_per_table: 1000,
};
export const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
export const activityAssets = {
  sale: hex(11),
  coin: `${hex(11)}::coin::ORBIT`,
  standalone: `${hex(12)}::coin::SOLO`,
  quote: `${hex(2)}::sui::SUI`,
};
export const activityWallets = {
  public: hex(101),
  private: hex(102),
  late: hex(103),
  anonymous: hex(104),
};
export const accountId = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export function activityRow(
  now: number,
  n: number,
  patch: Partial<ChainActivityRow> = {},
): ChainActivityRow {
  return {
    checkpoint: 100 + n,
    tx_slot: 0,
    event_slot: 0,
    part: 0,
    timestamp_ms: now - 120_000,
    digest: `Activity${n}`.padEnd(44, "3"),
    kind: "trade_buy",
    product: "market",
    actor: activityWallets.anonymous,
    tx_sender: activityWallets.anonymous,
    presale_id: null,
    coin_type: activityAssets.standalone,
    quote_type: activityAssets.quote,
    quote_amount: "9007199254740993123",
    coin_amount: "1234567891",
    quote_refund: null,
    usd_value: null,
    usd_price_as_of_ms: null,
    venue: "cetus",
    participants_after: null,
    total_commitments_after: null,
    ...patch,
  };
}
/** Only the owned disposable runner's chain views; never shared6544. */
export async function createActivityStreamFixture(
  databaseUrl: string,
  now: number,
  prepare = true,
) {
  const target = new URL(databaseUrl);
  if (
    target.hostname !== "127.0.0.1" ||
    target.port === "6544" ||
    target.pathname !== "/mission_control_test"
  )
    throw new Error("Activity requires an owned disposable PostgreSQL fixture");
  const admin = createPool(databaseUrl, { max: 1 });
  if (prepare) {
    await migrateDatabase(admin);
    const presale: ChainPresaleRow = {
      presale_id: activityAssets.sale,
      sale_token: activityAssets.coin,
      quote_type: activityAssets.quote,
      sale_symbol: "ORBIT",
      sale_name: "Orbit",
      sale_icon_url: "",
      sale_decimals: 9,
      quote_symbol: "SUI",
      quote_decimals: 9,
      lifecycle: "open",
      start_ms: now - 3_600_000,
      end_ms: now + 3_600_000,
      raise_target: "1000000000000",
      min_commitment: "1",
      wallet_cap: null,
      total_commitments: "123450000000",
      participants: 2,
      venue: "cetus",
      pool_id: null,
      updated_checkpoint: 100,
    };
    await seedChainRead(admin, {
      presales: [
        presale,
        {
          ...presale,
          presale_id: hex(13),
          sale_token: `${hex(13)}::coin::HIDDEN`,
          sale_decimals: null,
          sale_symbol: null,
          sale_name: null,
          sale_icon_url: null,
        },
      ],
      activity: [
        ...Array.from({ length: activityParameters.ties }, (_, n) =>
          activityRow(now, n, {
            checkpoint: 150,
            tx_slot: Math.floor(n / 8),
            event_slot: Math.floor(n / 2) % 4,
            part: n % 2,
            kind: n % 3 === 0 ? "trade_sell" : "trade_buy",
            actor:
              n === 23
                ? activityWallets.public
                : n === 22
                  ? activityWallets.private
                  : n === 21
                    ? activityWallets.late
                    : activityWallets.anonymous,
          }),
        ),
        activityRow(now, 1, {
          kind: "presale_commit",
          product: "presale",
          actor: activityWallets.public,
          presale_id: activityAssets.sale,
          coin_type: activityAssets.coin,
          timestamp_ms: now - 60_000,
          quote_amount: "12345000123",
          coin_amount: null,
          usd_value: "25.12345",
        }),
        activityRow(now, 2, {
          kind: "presale_claim",
          product: "presale",
          presale_id: activityAssets.sale,
          coin_type: activityAssets.coin,
        }),
        activityRow(now, 3, { kind: "launch_buy", product: "launchpad" }),
        activityRow(now, 4, {
          coin_type: `${hex(13)}::coin::HIDDEN`,
          presale_id: hex(13),
        }),
        activityRow(now, 5, {
          coin_type: `${hex(14)}::coin::EXCLUDED`,
          presale_id: hex(14),
        }),
        activityRow(now, 6, { timestamp_ms: now - 86_400_001 }),
        activityRow(now, 7, { timestamp_ms: now + 1 }),
        activityRow(now, 1001, { timestamp_ms: now - 1 }),
      ],
    });
    await admin.query(
      `INSERT INTO blast_infra_fixture.coin_metadata (coin_type,name,symbol,icon_url,decimals)
       VALUES ($1,'Solo','SOLO','',9),($2,'Sui','SUI','',9)`,
      [activityAssets.standalone, activityAssets.quote],
    );
    await admin.query(
      `INSERT INTO blast_infra_fixture.vaults
         (vault_id,origin_kind,origin_id,meme_type,quote_type,venue_type,venue,pool_id,created_checkpoint)
       VALUES ($1,'launch',$2,$3,$4,'0x1::cetus::Venue','cetus',$5,1)`,
      [hex(201), hex(203), activityAssets.standalone, activityAssets.quote, hex(202)],
    );
    const before = new Date(now - 86_400_000).toISOString();
    for (const [n, name, privacy, sharing, wallet] of [
      [1, "maya", "public", before, activityWallets.public],
      [2, "private", "private", null, activityWallets.private],
      [
        3,
        "late",
        "public",
        new Date(now - 1_000).toISOString(),
        activityWallets.late,
      ],
      [4, "solo", "public", before, hex(105)],
    ] as const) {
      await admin.query(
        `INSERT INTO social_accounts (account_id,privy_did,callsign,display_name,x_subject,x_handle,privacy,sharing_since,onboarded_at) VALUES ($1,$2,$3,$3,$3,$3,$4,$5,$6)`,
        [
          accountId(n),
          `did:privy:activity-${name}`,
          name,
          privacy,
          sharing,
          before,
        ],
      );
      await admin.query(
        "INSERT INTO social_account_wallets(address,account_id,verified_at) VALUES ($1,$2,$3)",
        [wallet, accountId(n), before],
      );
    }
    await admin.query(
      "INSERT INTO social_follows (follower_account_id,target_kind,target_id,source) VALUES ($1,'account',$2,'user')",
      [accountId(1), accountId(3)],
    );
    await admin.query(
      "UPDATE watermarks SET checkpoint_hi_inclusive=1000,timestamp_ms_hi_inclusive=$1 WHERE pipeline IN ('market','presale')",
      [now],
    );
  }
  const options = {
    max: 1,
    connectionTimeoutMs: 5000,
    idleInTransactionMs: 5000,
    idleTimeoutMs: 1000,
    lockTimeoutMs: 2000,
    statementTimeoutMs: 10000,
  };
  const replica = createRuntimePool(
    urlAs(databaseUrl, "blast_replica"),
    options,
    "t011-activity-replica",
  );
  const web = createRuntimePool(
    urlAs(databaseUrl, "blast_web"),
    options,
    "t011-activity-web",
  );
  const accounts = new PostgresSocialAccounts(() => web);
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const appId = "activity-fixture";
  const kitWith = (trading: boolean) => createSocialRouteKit({
    tradingVisible: () => trading,
    expectedOrigin: activityOrigin,
    verifyAccessToken: createPrivyTokenVerifier({
      appId,
      verificationKey: keys.publicKey
        .export({ format: "pem", type: "spki" })
        .toString(),
    }),
    limiter: new PostgresRateLimitEnforcer({
      pool: web,
      subjectPepper: "t011-activity-public-read-pepper-0123456789",
    }),
    accounts,
    primary: () => web,
  });
  const cache = createReadCache<HomeActivityStreamPage>(10_000, 64, () => now);
  // Trades shown by default; `routes(false)` hides them, as for an outsider while trading is off.
  const kits = { shown: kitWith(true), hidden: kitWith(false) };
  const common = {
    kit: kits.shown,
    database: () => autocommitReader(replica, "social"),
    ledgerDatabase: () => autocommitReader(web, "social"),
    wallets: accounts,
    config: async () => SOCIAL_CONFIG_DEFAULTS,
    terms: null,
    now: () => now,
  };
  const routes = (trading = true, cached = false) =>
    createSocialHomeRoutes({
      ...common,
      kit: trading ? kits.shown : kits.hidden,
      ...(cached ? { caches: { activity: cache } } : {}),
    });
  const bearer = (name: string) => {
    const seconds = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const body = `${encode({ alg: "ES256", typ: "JWT" })}.${encode({ aud: appId, exp: seconds + 3600, iat: seconds - 60, iss: "privy.io", sid: "activity", sub: `did:privy:activity-${name}` })}`;
    return `Bearer ${body}.${sign("sha256", Buffer.from(body), { dsaEncoding: "ieee-p1363", key: keys.privateKey }).toString("base64url")}`;
  };
  const feed = createSocialFeedRoute(common);
  const presales = createSocialPresaleRoutes({
    ...common,
    terms: async () => null,
  });
  const buyAlerts = (trading = true) =>
    createSocialBuyAlertRoutes({
      kit: trading ? kits.shown : kits.hidden,
      primary: () => autocommitReader(web, "social"),
      replica: () => autocommitReader(replica, "social"),
    });
  return {
    feed,
    presales,
    buyAlerts,
    admin,
    web,
    replica,
    routes,
    bearer,
    now,
    cache,
    async close() {
      await Promise.all([admin.end(), web.end(), replica.end()]);
    },
  };
}
