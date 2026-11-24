import assert from "node:assert/strict";
import test from "node:test";
import {
  createPool,
  createRuntimePool,
} from "@blast/core/modules/database/pool.ts";
import {
  autocommitReader,
  withTransaction,
} from "@blast/core/modules/database/transaction.ts";
import { urlAs } from "../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../packages/core/test/fixtures/modules/database/template.ts";
import {
  seedPresaleStory,
  PRESALE_STORY_ACCOUNTS,
  PRESALE_STORY_WALLETS,
} from "../../../../../packages/core/test/fixtures/modules/social/presales/presale-story.ts";
import { CREATOR_EARNINGS_SQL, CREATOR_RECEIVED_SQL, CREATOR_VESTINGS_SQL } from "@blast/server/modules/social/creator-earnings/read.ts";
import { creatorClaimStep } from "#workers/modules/social/claims/creator.ts";
import { claimIdempotencyKey } from "@blast/core/modules/social/claims/identity.ts";
import { vaultEventBcs } from "@interest-protocol/blast-sdk/vault";

const url = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const config = {
  max: 1,
  connectionTimeoutMs: 5000,
  idleInTransactionMs: 5000,
  idleTimeoutMs: 1000,
  lockTimeoutMs: 2000,
  statementTimeoutMs: 5000,
};
const id = (n: string) => `0x${n.repeat(64)}`;

test(
  "published creator queries and recovery work under runtime database roles",
  { skip: url ? false : "disposable database required" },
  async () => {
    const database = await freshTestDatabase();
    const admin = createPool(database.url, { max: 1 });
    const web = createRuntimePool(urlAs(database.url, "blast_web"), config, "creator-earnings-read-test");
    const watcher = createRuntimePool(
      urlAs(database.url, "blast_watcher"),
      config,
      "creator-earnings-worker-test",
    );
    try {
      const now = Date.now();
      const story = await seedPresaleStory(admin, { nowMs: now, crowd: 2 });
      const sale = story.presaleIds.KSTL!,
        vault = id("a"),
        owner = PRESALE_STORY_WALLETS.kai;
      await admin.query(`
        CREATE TABLE blast_infra_fixture.vault_fee_collections(
          vault_id TEXT REFERENCES blast_infra_fixture.vaults,
          fee_split JSONB NOT NULL, route_meme_amounts NUMERIC[] NOT NULL, route_quote_amounts NUMERIC[] NOT NULL);
        CREATE VIEW chain_read_v1.vault_fee_collections AS SELECT * FROM blast_infra_fixture.vault_fee_collections;
        GRANT SELECT ON blast_infra_fixture.vault_fee_collections TO blast_indexer;
        ALTER VIEW chain_read_v1.vault_fee_collections OWNER TO blast_indexer;
        GRANT SELECT ON chain_read_v1.vault_fee_collections TO blast_web,blast_watcher;`);
      const split = JSON.stringify({ routes: [
        { destination: { kind: "address", address: id("b") }, bps: 3000 },
        { destination: { kind: "address", address: owner }, bps: 7000 },
      ] });
      await admin.query(
        `INSERT INTO blast_infra_fixture.vaults
          (vault_id,origin_kind,origin_id,meme_type,venue_type,pool_id,quote_type,created_checkpoint,fee_split)
         VALUES($1,'presale',$2,$3,'cetus',$4,'0x2::sui::SUI',1,$5::jsonb)`,
        [vault, sale, story.saleTokens.KSTL, id("c"), split],
      );
      await admin.query(
        `INSERT INTO blast_infra_fixture.vault_fee_collections
         VALUES($1,$2::jsonb,ARRAY[3,7],ARRAY[6,14]),($1,$2::jsonb,ARRAY[30,70],ARRAY[60,140])`,
        [vault, split],
      );
      const db = autocommitReader(web, "social");
      assert.equal(
        (await db.read(CREATOR_EARNINGS_SQL, [owner, [], null])).rows[0]!.vault_id,
        vault,
      );
      assert.equal((await db.read(CREATOR_EARNINGS_SQL, [id("d"), [], null])).rows.length, 0);
      assert.equal(
        (await db.read(CREATOR_EARNINGS_SQL, [id("d"), [sale], null])).rows.length,
        1,
        "cap ownership discovers owner balances independently of fee membership",
      );
      assert.deepEqual((await db.read(CREATOR_RECEIVED_SQL, [vault, owner])).rows, [
        { meme: "77", quote: "154" },
      ]);
      await admin.query(
        `INSERT INTO blast_infra_fixture.vesting_schedules(schedule_id,presale_id,beneficiary,total,claimed,start_ms,cliff_ms,end_ms,share,asset)
      VALUES($1,$4,$5,1000,0,$6,0,$7,'token','sale_token'),($2,$4,$5,1000,100,$6,0,$7,'raise','quote'),($3,$4,$5,1000,0,$6,0,$7,'participant','sale_token')`,
        [id("7"), id("8"), id("9"), sale, owner, now - 1000, now + 1000],
      );
      const allocations = await db.read<{ schedule_id: string }>(CREATOR_VESTINGS_SQL, [owner]);
      assert.deepEqual(
        allocations.rows.map((row) => row.schedule_id),
        [id("7"), id("8")],
        "creator allocations include token and raise shares, excluding participant vestings",
      );
      await admin.query(
        `INSERT INTO checkpoint_journal(checkpoint,network,digest,epoch,timestamp_ms,total_transactions,format_version,payload,payload_hash)
      VALUES(20,'mainnet','creator-checkpoint-20',0,$1,0,1,''::bytea,decode(repeat('00',32),'hex')),
        (21,'mainnet','creator-checkpoint-21',0,$1,0,1,''::bytea,decode(repeat('00',32),'hex'))`,
        [now],
      );
      const original = id("e"),
        request = "00000000-0000-4000-8000-000000000001",
        digest = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
      const key = claimIdempotencyKey("claim_residuals", request, null, vault);
      await admin.query(
        `INSERT INTO social_transactions(tx_id,account_id,kind,state,digest,presale_id,idempotency_key,created_at_ms) VALUES($1,$2,'claim_residuals','submitted',$3,$4,$5,$6)`,
        [request, PRESALE_STORY_ACCOUNTS.kai, digest, sale, key, now - 10000],
      );
      const event = {
        eventType: `${original}::blast_vault_events::OwnerBalancesClaimed<${story.saleTokens.KSTL},0x2::sui::SUI>`,
        bcs: Buffer.from(
          vaultEventBcs.OwnerBalancesClaimed.serialize({
            vault_id: vault,
            meme_amount: 20n,
            quote_amount: 10n,
          }).toBytes(),
        ).toString("base64"),
      };
      await admin.query(
        `INSERT INTO blast_infra_fixture.transaction_evidence(digest,checkpoint,timestamp_ms,sender,success,events) VALUES($1,20,$2,$3,true,$4::jsonb)`,
        [digest, now, owner, JSON.stringify([event])],
      );
      const step = creatorClaimStep({ batchSize: 16, originalPackageId: original });
      const run = () =>
        withTransaction(watcher, (tx) =>
          step.run(
            tx.forModule("social"),
            { pipeline: "presale", checkpoint: 20, timestampMs: now },
            { now: () => now },
          ),
        );
      const report = await run();
      assert.equal(report.claims_confirmed, 1);
      assert.equal(
        (await admin.query("SELECT state FROM social_transactions WHERE tx_id=$1", [request]))
          .rows[0]!.state,
        "confirmed",
      );
      assert.equal((await run()).claims_confirmed, 0, "recovery is idempotent");
      const cases = [
        {
          n: 2,
          event: {
            ...event,
            bcs: Buffer.from(
              vaultEventBcs.OwnerBalancesClaimed.serialize({
                vault_id: id("f"),
                meme_amount: 20n,
                quote_amount: 10n,
              }).toBytes(),
            ).toString("base64"),
          },
          sender: owner,
          success: true,
          checkpoint: 20,
        },
        { n: 3, event, sender: id("d"), success: true, checkpoint: 20 },
        { n: 4, event, sender: owner, success: false, checkpoint: 20 },
        { n: 5, event, sender: owner, success: true, checkpoint: 21 },
      ];
      for (const entry of cases) {
        const txId = `00000000-0000-4000-8000-00000000000${entry.n}`;
        const txDigest = String(entry.n).repeat(32);
        await admin.query(
          `INSERT INTO social_transactions(tx_id,account_id,kind,state,digest,presale_id,idempotency_key,created_at_ms) VALUES($1,$2,'claim_residuals','submitted',$3,$4,$5,$6)`,
          [
            txId,
            PRESALE_STORY_ACCOUNTS.kai,
            txDigest,
            sale,
            claimIdempotencyKey("claim_residuals", txId, null, vault),
            now - 9000,
          ],
        );
        await admin.query(
          `INSERT INTO blast_infra_fixture.transaction_evidence(digest,checkpoint,timestamp_ms,sender,success,events) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
          [
            txDigest,
            entry.checkpoint,
            now,
            entry.sender,
            entry.success,
            JSON.stringify([entry.event]),
          ],
        );
      }
      const rejected = await run();
      assert.equal(
        rejected.claims_failed,
        3,
        "wrong vault, wrong sender and failed execution cannot confirm",
      );
      assert.equal(rejected.claims_confirmed, 0, "evidence ahead of the worker cut must wait");
      // Reset the keyset cursor at the end of a sweep, then revisit the pending digest.
      await run();
      const caughtUp = await withTransaction(watcher, (tx) =>
        step.run(
          tx.forModule("social"),
          { pipeline: "presale", checkpoint: 21, timestampMs: now },
          { now: () => now },
        ),
      );
      assert.equal(caughtUp.claims_confirmed, 1);
    } finally {
      await Promise.all([web.end(), watcher.end(), admin.end()]);
      await database.drop();
    }
  },
);
