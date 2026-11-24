import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { PostgresSocialAccounts } from "./repository.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const wallet = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

/** Count actual PostgreSQL client statements, rather than calls to repository methods. */
function statements(pool: Pool) {
  let count = 0;
  let afterInsert: (() => Promise<void>) | undefined;
  const bound = <T extends object>(target: T, property: PropertyKey) => {
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === "function" ? value.bind(target) : value;
  };
  const observed = new Proxy(pool, {
    get(target, property) {
      if (property !== "connect") return bound(target, property);
      return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(inner, name) {
            if (name !== "query") return bound(inner, name);
            return async (config: unknown, values?: unknown[]) => {
              count += 1;
              const result = await (inner.query as (config: unknown, values?: unknown[]) => Promise<unknown>)(config, values);
              const text = typeof config === "string" ? config : (config as { text: string }).text;
              if (text.startsWith("INSERT INTO social_accounts") && afterInsert) {
                const callback = afterInsert;
                afterInsert = undefined;
                await callback();
              }
              return result;
            };
          },
        });
      };
    },
  });
  return {
    pool: observed, reset: () => { count = 0; }, count: () => count,
    afterInsert: (callback: () => Promise<void>) => { afterInsert = callback; },
  };
}

async function member(db: Pool, n: number): Promise<string> {
  const did = `did:privy:compound-member-${n}`;
  await db.query(`INSERT INTO mission_control_profiles (
    profile_id, privy_did, x_subject, x_handle, sui_address, provider_wallet_reference,
    callsign, display_name, avatar_reference, disclosure_version, disclosure_accepted_at
  ) VALUES ($1,$2,$3,'member_handle',$4,$5,$6,'Profile name','https://example.test/profile.png','fixture',now())`,
  [id(n), did, `compound-x-${n}`, wallet(1000 + n), `compound-wallet-${n}`, `member_${n}`]);
  await db.query(`INSERT INTO mission_control_account_identities (profile_id,provider,provider_subject,verified_at)
    VALUES ($1,'privy',$2,now()),($1,'x',$3,now())`, [id(n), did, `compound-x-${n}`]);
  return did;
}

async function oldPrivy(accounts: PostgresSocialAccounts, did: string) {
  const account = await accounts.resolve(did);
  return account ? { ...account, wallets: await accounts.wallets(account.account_id) } : null;
}

async function oldWallet(accounts: PostgresSocialAccounts, address: string) {
  const account = await accounts.resolveWallet(address);
  return account ? { ...account, wallets: await accounts.wallets(account.account_id) } : null;
}

test("compound Me readers preserve real PostgreSQL resolution and wallet semantics with fewer round trips", { skip }, async (t) => {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 4 });
  const web = createRuntimePool(urlAs(database.url, "blast_web"), {
    max: 12, connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000,
    lockTimeoutMs: 2_000, statementTimeoutMs: 5_000,
  }, "compound-me-test");
  const observed = statements(web);
  const accounts = new PostgresSocialAccounts(() => observed.pool);
  try {
    await admin.query(`INSERT INTO social_accounts (account_id,privy_did,callsign,display_name,x_subject,x_avatar_url,picture,picture_url)
      VALUES ($1,'did:privy:compound-new','compound_new','Own name','compound-new-x','https://example.test/x.png','upload','https://example.test/upload.png'),
             ($2,'did:privy:compound-empty','compound_empty',NULL,NULL,NULL,'none',NULL)`, [id(100), id(101)]);
    await admin.query(`INSERT INTO presale_embedded_wallets (privy_did,address,resolved_at)
      VALUES ('did:privy:compound-new',$1,'2026-01-01')`, [wallet(1)]);
    await admin.query(`INSERT INTO social_account_wallets (account_id,address,kind,verified_at)
      VALUES ($1,$2,'external','2026-01-02'),($1,$3,'slush','2026-01-01'),($1,$4,'external','2026-01-04')`,
    [id(100), wallet(1), wallet(2), wallet(3)]);
    // Same millisecond, inverse address order: preserve PostgreSQL timestamp precision.
    await admin.query(`INSERT INTO social_account_wallets (account_id,address,kind,verified_at)
      VALUES ($1,$2,'external','2026-01-05T00:00:00.000100Z'),($1,$3,'external','2026-01-05T00:00:00.000200Z')`,
    [id(100), wallet(5), wallet(4)]);

    await t.test("Privy account and ordered wallets use one statement rather than two", async () => {
      observed.reset();
      const expected = await oldPrivy(accounts, "did:privy:compound-new");
      assert.equal(observed.count(), 2);
      observed.reset();
      const actual = await accounts.resolveWithWallets("did:privy:compound-new");
      assert.equal(observed.count(), 1);
      assert.deepEqual(actual, expected);
      assert.equal(actual?.verified, true);
      assert.equal(actual?.avatar_url, "https://example.test/upload.png");
      assert.deepEqual(actual?.wallets.map((entry) => [entry.address, entry.kind]), [
        [wallet(1), "embedded"], [wallet(2), "slush"], [wallet(3), "external"],
        [wallet(5), "external"], [wallet(4), "external"],
      ]);
    });

    await t.test("no wallets remains an empty array and unknown DID remains null in one statement", async () => {
      for (const did of ["did:privy:compound-empty", "did:privy:compound-missing"]) {
        const expected = await oldPrivy(accounts, did);
        observed.reset();
        const actual = await accounts.resolveWithWallets(did);
        assert.equal(observed.count(), 1);
        assert.deepEqual(actual, expected);
      }
      assert.deepEqual((await accounts.resolveWithWallets("did:privy:compound-empty"))?.wallets, []);
    });

    await t.test("wallet caller preserves its existing projection and repeated same-owner sources", async () => {
      observed.reset();
      const expected = await oldWallet(accounts, wallet(1));
      assert.equal(observed.count(), 3);
      observed.reset();
      const actual = await accounts.resolveWalletWithWallets(wallet(1));
      assert.equal(observed.count(), 2);
      assert.deepEqual(actual, expected);
      assert.equal(actual?.verified, false);
      assert.equal(actual?.avatar_url, "https://example.test/x.png");
      observed.reset();
      assert.equal(await accounts.resolveWalletWithWallets(wallet(999)), null);
      assert.equal(observed.count(), 1);
    });

    await t.test("member precedence, own profile overrides and first-create fresh reread remain intact", async () => {
      const did = await member(admin, 200);
      await admin.query(`INSERT INTO social_accounts (account_id,privy_did,callsign) VALUES ($1,$2,'shadow_member')`, [id(201), did]);
      observed.reset();
      const created = await accounts.resolveWithWallets(did);
      assert.equal(observed.count(), 3, "first member read, conflict-safe insert, fresh compound read");
      assert.equal(created?.kind, "member");
      assert.equal(created?.callsign, "member_200");
      assert.deepEqual(created?.wallets, []);
      await admin.query(`UPDATE social_accounts SET display_name='Member override',picture='upload',picture_url='https://example.test/member.png' WHERE profile_id=$1`, [id(200)]);
      assert.deepEqual(await accounts.resolveWithWallets(did), await oldPrivy(accounts, did));
      assert.equal((await accounts.resolveWithWallets(did))?.display_name, "Member override");
    });

    await t.test("wallet member first resolution keeps a separate ownership reread", async () => {
      await member(admin, 300);
      await admin.query(`INSERT INTO mission_control_account_wallets
        (wallet_id,profile_id,wallet_kind,sui_address,provider_wallet_reference,is_primary,verified_at)
        VALUES ($1,$2,'slush',$3,'compound-member-link',true,now())`, [id(301), id(300), wallet(300)]);
      observed.reset();
      const actual = await accounts.resolveWalletWithWallets(wallet(300));
      assert.equal(observed.count(), 4);
      assert.equal(actual?.kind, "member");
      assert.deepEqual(actual, await oldWallet(accounts, wallet(300)));
    });

    await t.test("a competing wallet owner appearing during member creation is refused on the fresh ownership read", async () => {
      await member(admin, 500);
      await admin.query(`INSERT INTO mission_control_account_wallets
        (wallet_id,profile_id,wallet_kind,sui_address,provider_wallet_reference,is_primary,verified_at)
        VALUES ($1,$2,'slush',$3,'compound-raced',true,now())`, [id(501), id(500), wallet(500)]);
      observed.afterInsert(async () => {
        await admin.query(`INSERT INTO social_account_wallets (account_id,address,kind,verified_at)
          VALUES ($1,$2,'external',now())`, [id(100), wallet(500)]);
      });
      observed.reset();
      await assert.rejects(accounts.resolveWalletWithWallets(wallet(500)), { code: "wallet_ambiguous" });
      assert.equal(observed.count(), 3, "no account snapshot may follow the ambiguous ownership reread");
    });

    await t.test("ambiguous ownership is refused and omitted from a Privy account's wallet list", async () => {
      const did = await member(admin, 400);
      await accounts.resolve(did);
      await admin.query(`INSERT INTO mission_control_account_wallets
        (wallet_id,profile_id,wallet_kind,sui_address,provider_wallet_reference,is_primary,verified_at)
        VALUES ($1,$2,'slush',$3,'compound-ambiguous',true,now())`, [id(401), id(400), wallet(2)]);
      await assert.rejects(accounts.resolveWallet(wallet(2)), { code: "wallet_ambiguous" });
      observed.reset();
      await assert.rejects(accounts.resolveWalletWithWallets(wallet(2)), { code: "wallet_ambiguous" });
      assert.equal(observed.count(), 1);
      const actual = await accounts.resolveWithWallets("did:privy:compound-new");
      assert.deepEqual(actual, await oldPrivy(accounts, "did:privy:compound-new"));
      assert.equal(actual?.wallets.some((entry) => entry.address === wallet(2)), false);
    });
  } finally {
    await web.end();
    await admin.end();
    await database.drop();
  }
});
