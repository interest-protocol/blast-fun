import {
  createPool,
  createRuntimePool,
} from "@blast/core/modules/database/pool.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { SOCIAL_CONFIG_DEFAULTS } from "@blast/core/modules/social/contracts/config.ts";
import { seedChainRead } from "../../../../../packages/core/test/fixtures/modules/database/chain-read-rows.ts";
import {
  advanceWatermark,
  urlAs,
} from "../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { createSocialHomeRoutes } from "@blast/server/modules/social/home/route.ts";
import { createSocialHappeningRoute } from "@blast/server/modules/social/happening/route.ts";
import { createSocialPresaleRoutes } from "@blast/server/modules/social/presales/route.ts";

export const discoveryOrigin = "http://127.0.0.1:42886";
export const discoveryId = (n: number) =>
  `0x${n.toString(16).padStart(64, "0")}`;

/** Fresh disposable chain fixture only. No shared/live database is accepted. */
export async function createPresalesDiscoveryFixture(
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
    throw new Error(
      "Presales discovery requires its owned disposable database",
    );
  const admin = createPool(databaseUrl, { max: 1 });
  if (prepare) {
    await migrateDatabase(admin);
    const quote =
      "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
    await seedChainRead(admin, {
      presales: Array.from({ length: 7 }, (_, index) => ({
        presale_id: discoveryId(index + 10),
        sale_token: `${discoveryId(index + 10)}::coin::${index === 0 ? "KSTL" : `SALE${index}`}`,
        quote_type: quote,
        sale_symbol: index === 0 ? "KSTL" : `SALE${index}`,
        sale_name: index === 0 ? "Kestrel" : `Presale ${index}`,
        sale_icon_url: "",
        sale_decimals: 9,
        quote_symbol: "SUI",
        quote_decimals: 9,
        lifecycle:
          index === 6
            ? ("funded" as const)
            : index === 5
              ? ("pending" as const)
              : ("open" as const),
        start_ms: index === 5 ? now + 3_600_000 : now - 3_600_000,
        end_ms: now + (index + 1) * 7_200_000,
        raise_target: "10000000000000",
        min_commitment: "1000000000",
        wallet_cap: null,
        total_commitments: "123450001000",
        participants: 1,
        venue: "cetus" as const,
        pool_id: null,
        updated_checkpoint: 1,
      })),
    });
    await admin.query(advanceWatermark(100, 0, "presale"));
    await admin.query(advanceWatermark(100, 0, "market"));
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
    "t008-presales-replica",
  );
  const web = createRuntimePool(
    urlAs(databaseUrl, "blast_web"),
    options,
    "t008-presales-web",
  );
  const accounts = new PostgresSocialAccounts(() => web);
  const kit = createSocialRouteKit({
    tradingVisible: () => true,
    expectedOrigin: discoveryOrigin,
    verifyAccessToken: async () => {
      throw new Error("No provider in public discovery fixture");
    },
    limiter: new PostgresRateLimitEnforcer({
      pool: web,
      subjectPepper: "t008-public-presales-fixture-pepper-0123456789",
    }),
    accounts,
    primary: () => web,
  });
  const database = () => autocommitReader(replica, "social");
  const common = {
    kit,
    database,
    config: async () => SOCIAL_CONFIG_DEFAULTS,
    now: () => now,
  };
  const home = createSocialHomeRoutes({
    ...common,
    ledgerDatabase: () => autocommitReader(web, "social"),
    wallets: accounts,
    terms: null,
  });
  const happening = createSocialHappeningRoute(common);
  const presales = createSocialPresaleRoutes({
    ...common,
    terms: async () => null,
  });
  return {
    admin,
    replica,
    web,
    home,
    happening,
    presales,
    async close() {
      await Promise.all([admin.end(), replica.end(), web.end()]);
    },
  };
}
