import assert from "node:assert/strict";
import test from "node:test";
import {
  createPool,
  createRuntimePool,
} from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import {
  REWARD_PACKAGE,
  rewardAddress as addr,
  rewardCreationEvent,
} from "../../../../../core/test/fixtures/modules/presale/reward-creation.ts";
import { createAdminRewardBlacklistRoute } from "@blast/server/modules/social/rewards/blacklist-route.ts";

const source = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const ORIGIN = "https://blast.fun";
const coin = `${addr(10)}::coin::COIN`;
const sale = addr(20),
  owner = addr(30),
  outsider = addr(31),
  team = addr(40),
  vested = addr(41);

test(
  "only admin operators manage per-coin exclusions; allocation evidence is mandatory",
  {
    skip: source ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set",
  },
  async (t) => {
    const database = await freshTestDatabase();
    const admin = createPool(database.url, { max: 2 });
    // These are the published native views, over the fixture's native receipt tables.
    await admin.query(`CREATE OR REPLACE VIEW chain_read_v1.checkpoint_headers AS SELECT checkpoint,digest,timestamp_ms FROM checkpoint_journal;
    ALTER VIEW chain_read_v1.checkpoint_headers OWNER TO blast_indexer;
    GRANT SELECT ON chain_read_v1.checkpoint_headers TO blast_web;
    CREATE OR REPLACE VIEW chain_read_v1.transaction_evidence AS
    SELECT t.tx_digest AS digest,t.checkpoint,j.timestamp_ms,t.sender,t.success,
      coalesce((SELECT jsonb_agg(jsonb_build_object('eventType',e.event_type,'bcs',encode(e.bcs,'base64')) ORDER BY e.event_slot)
        FROM native_events e WHERE (e.checkpoint,e.tx_slot)=(t.checkpoint,t.tx_slot)),'[]'::jsonb) AS events
    FROM native_transactions t JOIN checkpoint_journal j ON j.checkpoint=t.checkpoint;
    UPDATE deployment_identity SET network='mainnet',deployment_fingerprint=repeat('b',64);
    DELETE FROM watermarks;
    DELETE FROM checkpoint_journal;
    INSERT INTO checkpoint_journal VALUES(1,'mainnet','creation',NULL,0,1000,1,1,'x',decode(repeat('00',32),'hex'));
    INSERT INTO watermarks VALUES('intake',0,1,1,1000,0,now(),0,NULL),('presale',0,1,1,1000,0,now(),0,NULL);`);
    await admin.query(
      `INSERT INTO blast_infra_fixture.presales
    (presale_id,sale_token,quote_type,lifecycle,start_ms,end_ms,raise_target,min_commitment,total_commitments,participants,updated_checkpoint,created_at_ms)
    VALUES($1,$2,$3,'migrated',1000,2000,1000,1,1000,2,1,1000)`,
      [sale, coin, `${addr(2)}::sui::SUI`],
    );
    await admin.query(
      "INSERT INTO native_transactions VALUES(1,1,'create',$1,$1,TRUE,0)",
      [owner],
    );
    const event = rewardCreationEvent(sale, coin, {
      recipients: [
        { destination: team, vestingTerms: null },
        { destination: vested, vestingTerms: { cliffDelayMs: 0n, periodDurationMs: 1000n, periods: 10n } },
        { destination: addr(42), vestingTerms: null },
      ],
      recipient_bps: [1000n, 500n, 0n],
      raise_recipients: [{ destination: addr(43), vestingTerms: null }],
      raise_recipient_bps: [10000n],
    });
    await admin.query("INSERT INTO native_events VALUES(1,1,0,$1,$2,$3,$4)", [
      REWARD_PACKAGE,
      event.eventType,
      owner,
      Buffer.from(event.bcs, "base64"),
    ]);
    const web = createRuntimePool(
      urlAs(database.url, "blast_web"),
      {
        max: 2,
        connectionTimeoutMs: 5000,
        idleInTransactionMs: 10000,
        idleTimeoutMs: 1000,
        lockTimeoutMs: 2000,
        statementTimeoutMs: 5000,
      },
      "reward-blacklist-test",
    );
    t.after(async () => {
      await web.end();
      await admin.end();
      await database.drop();
    });
    await admin.query(
      "UPDATE blast_infra_fixture.presales SET sale_name='Migrated Coin',sale_symbol='MIG',sale_icon_url='',sale_decimals=9",
    );
    const route = createAdminRewardBlacklistRoute({
      pool: () => web,
      scope: () => ({ network: "mainnet", originalPackageId: REWARD_PACKAGE }),
    });
    async function request(
      method: "GET" | "PUT",
      wallets?: unknown,
      options: {
        coin?: string;
        origin?: string;
        body?: unknown;
      } = {},
    ) {
      const response = await route(
        new Request(
          `${ORIGIN}/api/admin/coins/${encodeURIComponent(options.coin ?? coin)}/reward-blacklist`,
          {
            method,
            headers: {
              origin: options.origin ?? ORIGIN,
              "sec-fetch-site": "same-origin",
              "content-type": "application/json",
            },
            ...(method === "PUT"
              ? { body: JSON.stringify(options.body ?? { wallets }) }
              : {}),
          },
        ),
      );
      assert.equal(response.headers.get("cache-control"), "no-store");
      return { status: response.status, body: await response.json() };
    }
    async function browse(query = "") {
      const response = await route(
        new Request(`${ORIGIN}/api/admin/reward-coins?${query}`),
      );
      assert.equal(response.headers.get("cache-control"), "no-store");
      return { status: response.status, body: await response.json() };
    }
    await admin.query(
      "UPDATE blast_infra_fixture.presales SET sale_name=NULL,sale_symbol=NULL,sale_icon_url=NULL,sale_decimals=NULL",
    );
    assert.deepEqual(
      (await browse(new URLSearchParams({ q: coin }).toString())).body.coins,
      [{ coin_type: coin, name: "Unnamed coin", symbol: "?" }],
    );
    await admin.query(
      "UPDATE blast_infra_fixture.presales SET sale_name='Migrated Coin',sale_symbol='MIG',sale_icon_url='',sale_decimals=9",
    );
    assert.equal((await browse("after=invalid")).status, 400);
    assert.deepEqual((await browse("q=migrated")).body, {
      coins: [{ coin_type: coin, name: "Migrated Coin", symbol: "MIG" }],
      next_cursor: null,
    });
    assert.deepEqual((await browse("q=nonexistent")).body.coins, []);
    await admin.query(
      `INSERT INTO blast_infra_fixture.presales
      (presale_id,sale_token,sale_name,sale_symbol,sale_icon_url,sale_decimals,quote_type,lifecycle,start_ms,end_ms,raise_target,min_commitment,total_commitments,participants,updated_checkpoint,created_at_ms)
      SELECT '0x'||lpad(to_hex(2000+n),64,'0'), '0x'||lpad(to_hex(1000+n),64,'0')||'::coin::PAGE',
      'Browse'||n,'PAGE','',9,$1,'migrated',1000,2000,1000,1,1000,2,1,1000 FROM generate_series(1,101) n`,
      [`${addr(2)}::sui::SUI`],
    );
    const first = (await browse()).body;
    assert.equal(first.coins.length, 100);
    assert.ok(first.next_cursor);
    const second = (
      await browse(new URLSearchParams({ after: first.next_cursor }).toString())
    ).body;
    assert.equal(second.coins.length, 2);
    assert.equal(second.next_cursor, null);
    assert.equal(
      new Set([...first.coins, ...second.coins].map((row) => row.coin_type))
        .size,
      102,
    );
    assert.equal((await browse("q=Browse101")).body.coins.length, 1);
    await admin.query(
      "DELETE FROM blast_infra_fixture.presales WHERE sale_symbol='PAGE'",
    );
    assert.deepEqual(await request("GET"), {
      status: 200,
      body: { coin_type: coin, wallets: [], team_wallets: [team, vested] },
    });
    assert.equal((await request("PUT", ["0x1"])).status, 400);
    assert.equal(
      (
        await request(
          "PUT",
          Array.from({ length: 51 }, () => team),
        )
      ).status,
      400,
    );
    assert.equal(
      (await request("PUT", [], { body: { wallets: [], team_wallets: [] } }))
        .status,
      400,
    );
    assert.equal(
      (await request("GET", undefined, { coin: "0x1::coin::COIN" })).status,
      400,
    );
    assert.equal(
      (await request("GET", undefined, { coin: `${addr(99)}::coin::OTHER` }))
        .status,
      404,
    );
    assert.equal(
      (
        await request("PUT", [outsider], {
          body: { wallets: [outsider], expected_wallets: [team] },
        })
      ).status,
      409,
      "a stale nonempty expectation must not create an absent policy row",
    );
    assert.equal(
      (
        await request("PUT", [outsider], {
          body: { wallets: [outsider], expected_wallets: [] },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("PUT", [team], {
          body: { wallets: [team], expected_wallets: [] },
        })
      ).status,
      409,
    );
    assert.deepEqual(
      (await request("GET")).body.wallets,
      [outsider],
      "stale edits never replace the saved list",
    );
    const full = Array.from({ length: 50 }, (_, i) => addr(100 + i));
    assert.equal(
      (
        await request("PUT", full, {
          body: { wallets: full, expected_wallets: [outsider] },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request("PUT", full.slice(1), {
          body: { wallets: full.slice(1), expected_wallets: full },
        })
      ).status,
      200,
      "maximum-sized guarded updates fit the bounded body",
    );
    await request("PUT", []);
    const concurrent = await Promise.all(
      [outsider, team].map((wallet) =>
        request("PUT", [wallet], {
          body: { wallets: [wallet], expected_wallets: [] },
        }),
      ),
    );
    assert.equal(
      concurrent.filter((result) => result.status === 200).length,
      1,
    );
    assert.ok(
      concurrent.every((result) => [200, 409, 503].includes(result.status)),
    );
    assert.deepEqual(
      (await request("GET")).body.wallets,
      concurrent.find((result) => result.status === 200)!.body.wallets,
      "concurrent edits cannot both succeed or overwrite the winning list",
    );
    assert.deepEqual(
      (await request("PUT", [outsider, team, outsider])).body.wallets,
      [outsider, team],
    );
    assert.deepEqual((await request("GET")).body.wallets, [outsider, team]);
    assert.deepEqual((await request("PUT", [outsider])).body.wallets, [
      outsider,
    ]);
    assert.deepEqual((await request("PUT", [])).body, {
      coin_type: coin,
      wallets: [],
      team_wallets: [team, vested],
    });
    assert.deepEqual(
      (
        await admin.query(
          "SELECT network,coin_type,wallets,updated_by::text FROM presale_reward_blacklists",
        )
      ).rows,
      [
        {
          network: "mainnet",
          coin_type: coin,
          wallets: [],
          updated_by: "admin-api",
        },
      ],
    );
    await admin.query(
      "INSERT INTO presale_reward_blacklists VALUES('localnet',$1,$2,$3,now())",
      [coin, [addr(90)], "admin-api"],
    );
    assert.deepEqual((await request("GET")).body.wallets, []);

    await request("PUT", [outsider]);
    await admin.query("UPDATE native_transactions SET success=FALSE");
    assert.equal(
      (await request("PUT", [])).status,
      503,
      "failed receipts cannot prove allocations",
    );
    await admin.query("UPDATE native_transactions SET success=TRUE");
    assert.deepEqual(
      (await request("GET")).body.wallets,
      [outsider],
      "failed updates are atomic",
    );
    await admin.query(
      "INSERT INTO native_events SELECT checkpoint,tx_slot,1,package,event_type,sender,bcs FROM native_events",
    );
    assert.equal(
      (await request("GET")).status,
      503,
      "ambiguous creation evidence blocks policy changes",
    );
    await admin.query("DELETE FROM native_events WHERE event_slot=1");
    for (const mismatched of [
      {
        ...event,
        eventType: event.eventType.replace(REWARD_PACKAGE, addr(999)),
      },
      {
        ...event,
        eventType: event.eventType.replace(coin, `${addr(11)}::coin::OTHER`),
      },
      rewardCreationEvent(addr(999), coin),
      rewardCreationEvent(sale, coin, {
        recipients: [{ destination: team, vestingTerms: null }],
        recipient_bps: [],
      }),
    ]) {
      await admin.query("UPDATE native_events SET event_type=$1,bcs=$2", [
        mismatched.eventType,
        Buffer.from(mismatched.bcs, "base64"),
      ]);
      assert.equal(
        (await request("GET")).status,
        503,
        "creation terms must match the deployment, coin, sale and allocation shape",
      );
    }
    await admin.query("UPDATE native_events SET event_type=$1,bcs=$2", [
      event.eventType,
      Buffer.from(event.bcs, "base64"),
    ]);
    await admin.query(
      `INSERT INTO blast_infra_fixture.presales SELECT $1,creator,created_at_ms,sale_token,quote_type,sale_symbol,sale_name,sale_icon_url,sale_decimals,
      quote_symbol,quote_decimals,lifecycle,start_ms,liquidity_deadline_ms,pool_creation_id,end_ms,raise_target,min_commitment,wallet_cap,total_commitments,
      participants,venue,pool_id,updated_checkpoint FROM blast_infra_fixture.presales WHERE presale_id=$2`,
      [addr(999), sale],
    );
    assert.equal(
      (await request("PUT", [])).status,
      503,
      "ambiguous presale binding blocks creation evidence",
    );
    assert.deepEqual(
      (await browse(new URLSearchParams({ q: coin }).toString())).body.coins,
      [],
      "ambiguous coin bindings are not offered",
    );
    await admin.query(
      "DELETE FROM blast_infra_fixture.presales WHERE presale_id=$1",
      [addr(999)],
    );
    await admin.query("UPDATE native_events SET bcs='x'");
    assert.equal(
      (await request("GET")).status,
      503,
      "malformed evidence never defaults to an empty team list",
    );
  },
);
