import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResultRow } from "pg";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  createActivityStreamFixture,
  activityOrigin,
  activityAssets,
  activityWallets,
  activityRow,
  accountId,
} from "../../../../test/fixtures/workspace/activity-stream-fixture.ts";
import { seedChainRead } from "../../../../../core/test/fixtures/modules/database/chain-read-rows.ts";
import type { HomeActivityStreamPage } from "@blast/core/modules/social/contracts/home.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { encodeCursor } from "./codec.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import {
  autocommitReader,
  type ReadableDatabase,
} from "@blast/core/modules/database/transaction.ts";
import { SOCIAL_CONFIG_DEFAULTS } from "@blast/core/modules/social/contracts/config.ts";
import { createSocialHomeRoutes } from "./route.ts";
import { readHomeActivityStream } from "./activity-stream.ts";
const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const validator = createSocialValidator();

test(
  "public indexed Activity preserves bounded public traversal and existing Home contracts",
  { skip: !databaseUrl },
  async (t) => {
    const evidence = process.env.T011_EVIDENCE_DIR;
    if (evidence) {
      const container = execFileSync(
        "docker",
        [
          "ps",
          "--filter",
          `publish=${new URL(databaseUrl!).port}`,
          "--format",
          "{{.ID}}",
        ],
        { encoding: "utf8" },
      ).trim();
      assert.ok(container && !container.includes("\n"));
      writeFileSync(
        `${evidence}/db-before-use-${process.pid}.json`,
        execFileSync("docker", ["inspect", container]),
      );
      const inspected = JSON.parse(
        execFileSync("docker", ["inspect", container], { encoding: "utf8" }),
      )[0];
      writeFileSync(
        `${evidence}/db-image-before-use-${process.pid}.json`,
        execFileSync("docker", ["image", "inspect", inspected.Image]),
      );
    }
    const fixture = await createActivityStreamFixture(databaseUrl!, Date.now());
    const { now, admin } = fixture;
    const get = (
      query = "",
      authorization?: string,
      trading = true,
      cached = false,
    ) =>
      fixture.routes(trading, cached).ACTIVITY_STREAM(
        new Request(
          activityOrigin + "/api/social/home/activity-stream" + query,
          {
            headers: {
              "x-forwarded-for": "203.0.113.11",
              ...(authorization ? { authorization } : {}),
            },
          },
        ), testClient("203.0.113.11")
      );
    const ok = async (response: Response) => {
      const body = (await response.json()) as HomeActivityStreamPage;
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(
        response.headers.get("cache-control"),
        "public, s-maxage=10, stale-while-revalidate=20",
      );
      assert.ok(response.headers.get("x-request-id"));
      assert.deepEqual(
        validator.validate("home-activity-stream-page", body).errors,
        [],
      );
      return body;
    };
    const invalid = async (query: string) => {
      const response = await get(query);
      assert.equal(response.status, 400, query);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.json();
      assert.equal(body.error.code, "invalid_parameter");
      assert.deepEqual(validator.validate("error", body).errors, []);
    };
    try {
      await t.test(
        "guests and differently followed authenticated accounts receive identical actions and exact fields",
        async () => {
          const first = await ok(await get("", undefined, true, true));
          assert.equal(first.events.length, 20);
          assert.equal(first.events[0].kind, "presale_commit");
          assert.equal(first.events[0].actor.type, "account");
          assert.equal(first.events[0].quote!.atoms, "12345000123");
          assert.equal(first.events[0].quote!.usd, "25.12");
          assert.equal(first.events[0].coin.presale_id, activityAssets.sale);
          assert.equal(first.events[1].coin.presale_id, null);
          assert.equal(
            first.events[1].coin.coin_type,
            activityAssets.standalone,
          );
          assert.equal(first.events[1].coin.network, "mainnet");
          assert.equal(first.events[1].coin.decimals, 9);
          assert.equal(first.events[1].quote!.atoms, "9007199254740993123");
          assert.equal(first.events[1].quote!.usd, null);
          assert.equal(first.events[2].actor.type, "address");
          assert.equal(first.events[3].actor.type, "address");
          for (const name of ["maya", "solo"])
            assert.deepEqual(
              await ok(await get("", fixture.bearer(name), true, true)),
              first,
            );
          assert.doesNotMatch(
            JSON.stringify(first),
            /"(account_id|viewer|relation|followed|following)"\s*:/,
          );
        },
      );
      await t.test(
        "timestamp ties paginate without duplicates while newer indexed events wait for a fresh traversal",
        async () => {
          const first = await ok(await get("?limit=5"));
          assert.equal(first.events[1].activity_id, "150:2:3:1");
          assert.equal(first.events[2].activity_id, "150:2:3:0");
          await seedChainRead(admin, {
            activity: [activityRow(now, 1500, { timestamp_ms: now - 30_000 })],
          });
          await admin.query(
            "UPDATE watermarks SET checkpoint_hi_inclusive=2000 WHERE pipeline IN ('market','presale')",
          );
          const events = [...first.events];
          let cursor = first.next_cursor;
          while (cursor) {
            const page = await ok(
              await get(`?limit=5&cursor=${encodeURIComponent(cursor)}`),
            );
            assert.equal(page.clock_ms, first.clock_ms);
            assert.equal(page.as_of.checkpoint, first.as_of.checkpoint);
            assert.equal(page.as_of.timestamp_ms, first.as_of.timestamp_ms);
            events.push(...page.events);
            cursor = page.next_cursor;
            assert.ok(events.length <= 25);
          }
          assert.equal(events.length, 25);
          assert.equal(
            new Set(events.map((event) => event.activity_id)).size,
            25,
          );
          assert.ok(
            events.every((event) =>
              ["trade_buy", "trade_sell", "presale_commit"].includes(
                event.kind,
              ),
            ),
          );
          const fresh = await ok(await get("?limit=50"));
          assert.equal(fresh.events.length, 27);
          assert.equal(fresh.next_cursor, null);
          assert.ok(
            fresh.events.some((event) => event.activity_id === "1600:0:0:0"),
          );
          await admin.query(
            "UPDATE watermarks SET checkpoint_hi_inclusive=1000 WHERE pipeline IN ('market','presale')",
          );
        },
      );
      await t.test(
        "a committed watermark advance after the first observation cannot invalidate its emitted cursor",
        async () => {
          await admin.query(
            "UPDATE watermarks SET checkpoint_hi_inclusive=1000,timestamp_ms_hi_inclusive=$1 WHERE pipeline='market'",
            [now - 2000],
          );
          await admin.query(
            "UPDATE watermarks SET checkpoint_hi_inclusive=900,timestamp_ms_hi_inclusive=$1 WHERE pipeline='presale'",
            [now - 1000],
          );
          const actual = autocommitReader(fixture.replica, "social");
          let observations = 0;
          let committed!: () => void;
          const advanced = new Promise<void>((resolve) => {
            committed = resolve;
          });
          const advancing: ReadableDatabase = {
            async read<Row extends QueryResultRow>(
              sql: string,
              params?: readonly unknown[],
            ) {
              const watermark = sql.includes("FROM chain_read_v1.watermark");
              const observation = watermark ? ++observations : 0;
              if (observation > 1) await advanced;
              const result = await actual.read<Row>(sql, params);
              if (observation === 1) {
                await admin.query(
                  "UPDATE watermarks SET checkpoint_hi_inclusive=2000,timestamp_ms_hi_inclusive=$1 WHERE pipeline IN ('market','presale')",
                  [now],
                );
                committed();
              }
              return result;
            },
          };
          try {
            const first = await readHomeActivityStream(
              advancing,
              { window: "24h", limit: 5, cursor: null },
              { nowMs: now, hiddenKinds: [] },
            );
            assert.ok(first.next_cursor);
            const next = await readHomeActivityStream(
              advancing,
              { window: "24h", limit: 5, cursor: first.next_cursor },
              { nowMs: now + 1, hiddenKinds: [] },
            );
            assert.equal(first.clock_ms, now - 1000);
            assert.equal(first.as_of.checkpoint, 1000);
            assert.equal(first.as_of.timestamp_ms, now - 2000);
            assert.equal(next.clock_ms, first.clock_ms);
            assert.equal(next.as_of.checkpoint, first.as_of.checkpoint);
            assert.equal(next.as_of.timestamp_ms, first.as_of.timestamp_ms);
            assert.equal(
              new Set(
                [...first.events, ...next.events].map(
                  (event) => event.entry_id,
                ),
              ).size,
              10,
            );
          } finally {
            committed();
            await admin.query(
              "UPDATE watermarks SET checkpoint_hi_inclusive=1000,timestamp_ms_hi_inclusive=$1 WHERE pipeline IN ('market','presale')",
              [now],
            );
          }
        },
      );
      await t.test(
        "current privacy and hidden-kind configuration apply before every page limit and cache key",
        async () => {
          const first = await ok(await get("?limit=5"));
          await admin.query(
            "UPDATE social_accounts SET privacy='private',sharing_since=NULL WHERE account_id=$1",
            [accountId(1)],
          );
          const privatePage = await ok(await get("?limit=5"));
          assert.deepEqual(privatePage.events[0].actor, {
            type: "address",
            address: activityWallets.public,
            short: "0x0000…0065",
          });
          await admin.query(
            "UPDATE social_accounts SET privacy='public',sharing_since=$2 WHERE account_id=$1",
            [accountId(1), new Date(now - 86_400_000).toISOString()],
          );
          const all = await ok(await get("?limit=5", undefined, true, true));
          const commits = await ok(
            await get("?limit=5", undefined, false, true),
          );
          assert.equal(all.events.length, 5);
          assert.equal(commits.events.length, 1);
          assert.equal(commits.events[0].kind, "presale_commit");
          const none = await readHomeActivityStream(
            autocommitReader(fixture.replica, "social"),
            { window: "24h", limit: 5, cursor: null },
            { nowMs: now, hiddenKinds: ["trade_buy", "trade_sell", "presale_commit"] },
          );
          assert.equal(none.events.length, 0);
          assert.equal(none.next_cursor, null);
          assert.ok(first.next_cursor);
        },
      );
      await t.test(
        "invalid input, foreign cursors and edited bounds fail as invalid_parameter",
        async () => {
          for (const query of [
            "?window=7d",
            "?limit=0",
            "?limit=51",
            "?limit=1.1",
            "?limit=x",
            "?window=1h&window=24h",
            "?cursor=",
            "?cursor=bad",
            "?account=maya",
            "?actor=wallet",
            "?following=true",
          ])
            await invalid(query);
          const page = await ok(await get("?limit=5"));
          await invalid(`?window=1h&cursor=${page.next_cursor}`);
          await invalid(
            `?cursor=${encodeCursor("thread", [1, now, "w:" + activityWallets.public])}`,
          );
          const valid = [
            1,
            "24h",
            now,
            now,
            1000,
            1000,
            1000,
            now,
            now - 120_000,
            150,
            2,
            2,
            1,
          ];
          for (const [index, value] of [
            [2, now + 1],
            [3, now + 1],
            [4, 1001],
            [5, 1001],
            [6, 1001],
            [7, now + 1],
            [8, now - 86_400_000],
            [9, -1],
            [10, 1.5],
            [11, Number.MAX_SAFE_INTEGER + 1],
            [12, "1"],
          ] as const) {
            const edited = [...valid];
            edited[index] = value;
            await invalid(`?cursor=${encodeCursor("activity-stream", edited)}`);
          }
          const expired = [...valid];
          expired[2] = now - 86_400_001;
          expired[3] = now - 86_400_001;
          expired[7] = now - 86_400_001;
          expired[8] = now - 86_520_001;
          await invalid(`?cursor=${encodeCursor("activity-stream", expired)}`);
        },
      );
      await t.test(
        "missing watermark is unavailable, delayed bounds remain successful and grouped/private routes keep their policy",
        async () => {
          await admin.query(
            "UPDATE watermarks SET reader_lo=2001 WHERE pipeline='market'",
          );
          const unavailable = await get();
          assert.equal(unavailable.status, 503);
          assert.equal(unavailable.headers.get("cache-control"), "no-store");
          assert.equal(
            (await unavailable.json()).error.code,
            "service_unavailable",
          );
          await admin.query(
            "UPDATE watermarks SET reader_lo=0,timestamp_ms_hi_inclusive=$1 WHERE pipeline IN ('market','presale')",
            [now - 120_000],
          );
          const delayed = await ok(await get());
          assert.ok(delayed.as_of.lag_ms > 60_000);
          assert.equal(delayed.clock_ms, now - 120_000);
          await admin.query(
            "UPDATE watermarks SET timestamp_ms_hi_inclusive=$1 WHERE pipeline IN ('market','presale')",
            [now],
          );
          const thread = await fixture
            .routes()
            .ACTIVITY(
              new Request(
                activityOrigin +
                  `/api/social/home/activity?presale=${activityAssets.sale}`,
              ), testClient()
            );
          assert.equal(thread.status, 200);
          assert.deepEqual(
            validator.validate("home-thread-page", await thread.json()).errors,
            [],
          );
          const request = (token?: string) =>
            new Request(activityOrigin + "/api/social/me/home/following", {
              method: "POST",
              headers: {
                origin: activityOrigin,
                "content-type": "application/json",
                ...(token ? { authorization: token } : {}),
              },
              body: JSON.stringify({ mode: "coins", window: "24h" }),
            });
          assert.equal(
            (await fixture.routes().FOLLOWING(request(), testClient())).status,
            401,
          );
          for (const name of ["maya", "solo"]) {
            const followed = await fixture
              .routes()
              .FOLLOWING(request(fixture.bearer(name)), testClient());
            assert.equal(followed.status, 200);
            assert.equal(
              followed.headers.get("cache-control"),
              "private, no-store",
            );
          }
        },
      );
      await t.test(
        "public cached reads enforce one real IP social_read budget across token variants",
        async () => {
          const accounts = new PostgresSocialAccounts(() => fixture.web);
          const kit = createSocialRouteKit({
            tradingVisible: () => true,
            expectedOrigin: activityOrigin,
            verifyAccessToken: async () => {
              throw new Error("Public Activity must not verify caller tokens");
            },
            limiter: new PostgresRateLimitEnforcer({
              pool: fixture.web,
              subjectPepper: "t011-rate-proof-0123456789-0123456789",
              clock: () => new Date(now),
            }),
            accounts,
            primary: () => fixture.web,
          });
          const routes = createSocialHomeRoutes({
            kit,
            database: () => autocommitReader(fixture.replica, "social"),
            ledgerDatabase: () => autocommitReader(fixture.web, "social"),
            wallets: accounts,
            config: async () => SOCIAL_CONFIG_DEFAULTS,
            terms: null,
            now: () => now,
            caches: { activity: fixture.cache },
          });
          const request = (ip: string, token?: string) => [
            new Request(
              activityOrigin + "/api/social/home/activity-stream?limit=5",
              {
                headers: {
                  "x-forwarded-for": ip,
                  ...(token ? { authorization: token } : {}),
                },
              },
            ),
            testClient(ip),
          ] as const;
          for (let index = 0; index < 600; index++) {
            const response = await routes.ACTIVITY_STREAM(
              ...request(
                "198.51.100.88",
                index % 2 ? fixture.bearer("maya") : undefined,
              ),
            );
            assert.equal(response.status, 200, String(index));
            assert.equal(
              response.headers.get("cache-control"),
              "public, s-maxage=10, stale-while-revalidate=20",
            );
            await response.arrayBuffer();
          }
          const refused = await routes.ACTIVITY_STREAM(
            ...request("198.51.100.88", fixture.bearer("solo")),
          );
          assert.equal(refused.status, 429);
          assert.equal(refused.headers.get("cache-control"), "no-store");
          assert.ok(Number(refused.headers.get("retry-after")) > 0);
          const body = await refused.json();
          assert.equal(body.error.code, "rate_limited");
          assert.deepEqual(validator.validate("error", body).errors, []);
          assert.equal(
            (await routes.ACTIVITY_STREAM(...request("198.51.100.89"))).status,
            200,
          );
        },
      );
      if (evidence) {
        const pages: HomeActivityStreamPage[] = [];
        let cursor: string | null = null;
        do {
          const page: HomeActivityStreamPage = await ok(
            await get(
              `?limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
            ),
          );
          pages.push(page);
          cursor = page.next_cursor;
        } while (cursor);
        const feed = await fixture.feed.GET(
          new Request(activityOrigin + "/api/social/feed?tab=for_you&limit=5", {
            headers: { "x-forwarded-for": "203.0.113.22" },
          }), testClient("203.0.113.22")
        );
        assert.equal(feed.status, 200);
        const presale = await fixture.presales.presale.GET(
          new Request(
            activityOrigin + `/api/social/presales/${activityAssets.sale}`,
            { headers: { "x-forwarded-for": "203.0.113.22" } },
          ), testClient("203.0.113.22")
        );
        assert.equal(presale.status, 200);
        const home = await fixture
          .routes()
          .DISCOVER(
            new Request(
              activityOrigin + "/api/social/home?sort=newest&limit=50",
              { headers: { "x-forwarded-for": "203.0.113.22" } },
            ), testClient("203.0.113.22")
          );
        assert.equal(home.status, 200);
        const homeBody = await home.json();
        writeFileSync(
          `${evidence}/public-route-proof.json`,
          JSON.stringify(
            {
              now,
              pages,
              home: homeBody,
              feed_seed: await feed.json(),
              presale: await presale.json(),
              source:
                "actual route outputs on isolated migrated PostgreSQL; browser replays these bytes",
            },
            null,
            2,
          ),
        );
        const counts = [];
        for (const row of (
          await admin.query(
            "SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema IN ('public','blast_infra_fixture') AND table_type='BASE TABLE' ORDER BY table_schema,table_name",
          )
        ).rows) {
          const count = (
            await admin.query(
              `SELECT count(*)::int AS count FROM ${row.table_schema}.${row.table_name}`,
            )
          ).rows[0].count;
          assert.ok(count <= 1000, row.table_name);
          counts.push({ ...row, count });
        }
        writeFileSync(
          `${evidence}/integration-fixture-identity.json`,
          JSON.stringify(
            {
              now,
              counts,
              major: (await admin.query("SHOW server_version")).rows,
              migrations: (
                await admin.query(
                  "SELECT name,checksum FROM mission_control_schema_migrations ORDER BY name",
                )
              ).rows,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      await fixture.close();
    }
  },
);
