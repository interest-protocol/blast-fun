import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { walletChallengeRateLimiter } from "@blast/core/lib/web-security/rate-limits.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { syntheticSlushSigner } from "../../../../../core/test/fixtures/modules/mission-control/wallet-challenges/testing.ts";
import { WalletChallengeService } from "@blast/server/modules/mission-control/wallet-challenges/index.ts";
import { createSocialMeRoute } from "@blast/server/modules/social/accounts/me-route.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import type { SocialMeResponse } from "@blast/core/modules/social/contracts/me.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import type { SocialWalletChallenge, SocialWalletLinked } from "@blast/core/modules/social/contracts/wallets.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createSocialWalletRoutes } from "@blast/server/modules/social/wallets/route.ts";
import { uuid } from "../../../../../core/test/kit.ts";
import { installRuntimeConfig } from "../../../../test/fixtures/config/runtime-config.ts";

/**
 * Social-feed T-017 (AC-015, AC-016, AC-126): linking an external Sui wallet
 * by signed challenge, over the migrations as the web runtime role
 * `blast_web`, with a real Privy token verifier over a fixture ES256 key,
 * the Postgres rate limiter and Mission Control's real wallet-challenge
 * service (Ed25519 fixture keypairs; their signatures never need a fullnode).
 */

// The default wallet verifier reads its node URL from the API runtime config.
installRuntimeConfig();

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-wallets-app";
const NOW = Math.floor(Date.now() / 1_000);
const PEPPER = "social-wallets-fixture-pepper-0123456789";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const verificationKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
const validator = createSocialValidator();
const POOL_SETTINGS = {
  connectionTimeoutMs: 5_000,
  idleInTransactionMs: 5_000,
  idleTimeoutMs: 1_000,
  lockTimeoutMs: 2_000,
  max: 8,
  statementTimeoutMs: 5_000,
};
const wallet = (tag: string) => `0x${tag.padStart(64, "0")}`;
const signer = (seed: number) => Ed25519Keypair.fromSecretKey(Uint8Array.from({ length: 32 }, (_, index) => (index * 7 + seed) % 256));

const KAI = { id: uuid(0xb1), did: "did:privy:wallets-kai", callsign: "wal_kai" };
const NOVA = { id: uuid(0xb2), did: "did:privy:wallets-nova", callsign: "wal_nova" };
const NOBODY_DID = "did:privy:wallets-nobody";
/** A Mission Control member who never opened the social feed (no social account row). */
const MEMBER = { profileId: uuid(0xc1), did: "did:privy:wallets-member", callsign: "wal_member" };

function token(did: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: NOW + 3_600, iat: NOW - 60, iss: "privy.io", sid: "s-1", sub: did });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

function post(path: string, did: string | null, body: unknown, ip = "203.0.113.7"): readonly [Request, ReturnType<typeof testClient>] {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": ip };
  if (did) headers.authorization = `Bearer ${token(did)}`;
  return [new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }), testClient(ip)] as const;
}

type Clock = { now: number };

type Fixture = Readonly<{
  admin: Pool;
  web: Pool;
  clock: Clock;
  routes: ReturnType<typeof createSocialWalletRoutes>;
  me: ReturnType<typeof createSocialMeRoute>;
}>;

async function withDatabase(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const { url } = database;
  const admin = createPool(url, { max: 4 });
  const web = createRuntimePool(urlAs(url, "blast_web"), POOL_SETTINGS, "social-wallets-test");
  try {
    for (const account of [KAI, NOVA]) {
      await admin.query(
        `INSERT INTO social_accounts (account_id, privy_did, callsign, onboarding_shown_at, onboarded_at)
         VALUES ($1, $2, $3, now(), now())`,
        [account.id, account.did, account.callsign],
      );
    }
    await admin.query(
      `INSERT INTO mission_control_profiles (
         profile_id, privy_did, x_subject, sui_address, provider_wallet_reference, callsign, disclosure_version, disclosure_accepted_at
       ) VALUES ($1, $2, 'x-wallets-member', $3, 'wallet-member', $4, 'fixture-v1', now())`,
      [MEMBER.profileId, MEMBER.did, wallet("9c1"), MEMBER.callsign],
    );
    const limiter = new PostgresRateLimitEnforcer({ pool: web, subjectPepper: PEPPER });
    const clock: Clock = { now: Date.now() };
    const challenges = new WalletChallengeService(web, {
      clock: () => new Date(clock.now),
      rateLimiter: walletChallengeRateLimiter(limiter),
    });
    const accounts = new PostgresSocialAccounts(() => web);
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey }),
      limiter,
      accounts,
      primary: () => web,
    });
    await run({
      admin,
      web,
      clock,
      routes: createSocialWalletRoutes({ kit, challenges: () => challenges, origin: ORIGIN }),
      me: createSocialMeRoute({ kit, accounts }),
    });
  } finally {
    await web.end();
    await admin.end();
    await database.drop();
  }
}

async function json<T>(response: Response, status: number, schema?: Parameters<typeof validator.validate>[0]): Promise<T> {
  const body: unknown = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  if (schema) assert.deepEqual(validator.validate(schema, body).errors, []);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.ok(response.headers.get("x-request-id"));
  return body as T;
}

async function refusal(response: Response, status: number, code: string): Promise<void> {
  const body = await json<{ error: { code: string } }>(response, status, "error");
  assert.equal(body.error.code, code);
}

async function challenge(routes: Fixture["routes"], did: string, address: string): Promise<SocialWalletChallenge> {
  return json<SocialWalletChallenge>(
    await routes.challenge.POST(...post("/api/social/me/wallets/challenge", did, { address })),
    201,
    "wallet-challenge-response",
  );
}

async function signed(keypair: Ed25519Keypair, issued: SocialWalletChallenge): Promise<string> {
  return (await keypair.signPersonalMessage(new TextEncoder().encode(issued.message))).signature;
}

function linkBody(issued: SocialWalletChallenge, signature: string, extra: Record<string, unknown> = {}) {
  return { challenge_id: issued.challenge_id, address: issued.address, message: issued.message, signature, ...extra };
}

/** Empties the rate-limit windows, so a test can take more steps than one account's hourly link budget. */
async function resetLimits(admin: Pool): Promise<void> {
  await admin.query("DELETE FROM mission_control_rate_limit_windows");
}

async function proven(admin: Pool): Promise<Array<{ address: string; account_id: string; kind: string }>> {
  return (await admin.query("SELECT address, account_id::text AS account_id, kind FROM social_account_wallets ORDER BY address")).rows;
}

async function meWallets(me: Fixture["me"], did: string) {
  const body = await json<SocialMeResponse>(
    await me.GET(new Request(`${ORIGIN}/api/social/me`, { headers: { authorization: `Bearer ${token(did)}` } }), testClient()),
    200,
    "me-response",
  );
  return body.account?.wallets ?? [];
}

test("T-017-AC-1 (AC-015): challenge, then a personal-message signature, links the address; me lists it", { skip }, () =>
  withDatabase(async ({ admin, routes, me }) => {
    const keypair = syntheticSlushSigner;
    const address = keypair.toSuiAddress();
    // Any accepted spelling: the challenge binds the canonical address.
    const issued = await challenge(routes, KAI.did, address.toUpperCase().replace("0X", "0x"));
    assert.equal(issued.address, address);
    assert.match(issued.message, /^BLAST\.FUN wallet verification\n/);
    assert.match(issued.message, /\nAction: link_wallet\n/);
    assert.match(issued.message, new RegExp(`\\nAddress: ${address}\\n`));
    assert.match(issued.message, new RegExp(`\\nBlast account: social:${KAI.id}\\n`));
    assert.match(issued.message, /\nOrigin: https:\/\/blast\.fun\n/);
    assert.ok(issued.expires_at_ms > Date.now() + 4 * 60_000 && issued.expires_at_ms <= Date.now() + 5 * 60_000 + 1_000);

    const before = Date.now();
    const linked = await json<SocialWalletLinked>(
      await routes.link.POST(...post("/api/social/me/wallets", KAI.did, linkBody(issued, await signed(keypair, issued)))),
      201,
      "wallet-link-response",
    );
    assert.equal(linked.wallet.address, address);
    assert.equal(linked.wallet.kind, "external");
    assert.ok(linked.wallet.linked_at_ms >= before - 1_000 && linked.wallet.linked_at_ms <= Date.now() + 1_000);
    assert.deepEqual(await meWallets(me, KAI.did), [linked.wallet]);
    assert.deepEqual(await proven(admin), [{ address, account_id: KAI.id, kind: "external" }]);

    // Linking the same address again (a new challenge) is a no-op: 200 with the same wallet.
    const again = await challenge(routes, KAI.did, address);
    const relinked = await json<SocialWalletLinked>(
      await routes.link.POST(...post("/api/social/me/wallets", KAI.did, linkBody(again, await signed(keypair, again), { wallet: "slush" }))),
      200,
      "wallet-link-response",
    );
    assert.deepEqual(relinked, linked);

    // A Slush wallet is listed as Slush.
    const slush = signer(11);
    const slushChallenge = await challenge(routes, KAI.did, slush.toSuiAddress());
    const slushLinked = await json<SocialWalletLinked>(
      await routes.link.POST(...post("/api/social/me/wallets", KAI.did, linkBody(slushChallenge, await signed(slush, slushChallenge), { wallet: "slush" }))),
      201,
      "wallet-link-response",
    );
    assert.equal(slushLinked.wallet.kind, "slush");
    assert.deepEqual((await meWallets(me, KAI.did)).map((w) => [w.address, w.kind]), [[address, "external"], [slush.toSuiAddress(), "slush"]]);
  }));

test("T-017-AC-2 (AC-016): a taken address is wallet_taken; a wrong, reused or expired signature links nothing", { skip }, () =>
  withDatabase(async ({ admin, clock, routes, me }) => {
    // Taken through each source, before anything is signed.
    const memberWallet = signer(21).toSuiAddress();
    await admin.query(
      `INSERT INTO mission_control_account_wallets (wallet_id, profile_id, wallet_kind, sui_address, provider_wallet_reference, is_primary, verified_at)
       VALUES ($1, $2, 'slush', $3, 'ref-member', true, now())`,
      [uuid(0xd1), MEMBER.profileId, memberWallet],
    );
    const embedded = signer(22).toSuiAddress();
    await admin.query("INSERT INTO presale_embedded_wallets (privy_did, address) VALUES ($1, $2)", [NOVA.did, embedded]);
    const novaProven = signer(23).toSuiAddress();
    await admin.query(
      "INSERT INTO social_account_wallets (address, account_id, kind, verified_at) VALUES ($1, $2, 'external', now())",
      [novaProven, NOVA.id],
    );
    for (const address of [memberWallet, embedded, novaProven]) {
      await refusal(await routes.challenge.POST(...post("/api/social/me/wallets/challenge", KAI.did, { address })), 409, "wallet_taken");
    }
    // Nova's own embedded wallet is hers: she may prove it (no duplicate source row is written).
    const ownEmbedded = await challenge(routes, NOVA.did, embedded);
    const ownLinked = await json<SocialWalletLinked>(
      await routes.link.POST(...post("/api/social/me/wallets", NOVA.did, linkBody(ownEmbedded, await signed(signer(22), ownEmbedded)))),
      200,
      "wallet-link-response",
    );
    assert.equal(ownLinked.wallet.kind, "embedded");

    await resetLimits(admin);
    const keypair = signer(31);
    const address = keypair.toSuiAddress();
    const rows = await proven(admin);

    // A signature by another key.
    const issued = await challenge(routes, KAI.did, address);
    await refusal(
      await routes.link.POST(...post("/api/social/me/wallets", KAI.did, linkBody(issued, await signed(signer(32), issued)))),
      400,
      "invalid_signature",
    );
    // A tampered message (the stored hash differs), and the right signature over a different message.
    const tampered = { ...issued, message: issued.message.replace("Action: link_wallet", "Action: link_wallet ") };
    await refusal(
      await routes.link.POST(...post("/api/social/me/wallets", KAI.did, linkBody(tampered, await signed(keypair, tampered)))),
      400,
      "invalid_signature",
    );
    // Another account cannot redeem Kai's challenge (it binds his account).
    await refusal(
      await routes.link.POST(...post("/api/social/me/wallets", NOVA.did, linkBody(issued, await signed(keypair, issued)))),
      400,
      "invalid_signature",
    );
    // Expired: the service's clock passes the five minutes.
    const late = await challenge(routes, KAI.did, address);
    clock.now += 5 * 60_000;
    await refusal(
      await routes.link.POST(...post("/api/social/me/wallets", KAI.did, linkBody(late, await signed(keypair, late)))),
      400,
      "invalid_signature",
    );
    clock.now = Date.now();
    assert.deepEqual(await proven(admin), rows);
    assert.deepEqual(await meWallets(me, KAI.did), []);

    await resetLimits(admin);
    // A good signature links once; the same signature again is invalid (the challenge is consumed).
    const good = await challenge(routes, KAI.did, address);
    const signature = await signed(keypair, good);
    await json(await routes.link.POST(...post("/api/social/me/wallets", KAI.did, linkBody(good, signature))), 201, "wallet-link-response");
    await refusal(await routes.link.POST(...post("/api/social/me/wallets", KAI.did, linkBody(good, signature))), 400, "invalid_signature");

    await resetLimits(admin);
    // Taken between challenge and link: Nova proves the address first; Kai's valid signature is wallet_taken.
    const contested = signer(41);
    const kaiFirst = await challenge(routes, KAI.did, contested.toSuiAddress());
    const novaSecond = await challenge(routes, NOVA.did, contested.toSuiAddress());
    await json(
      await routes.link.POST(...post("/api/social/me/wallets", NOVA.did, linkBody(novaSecond, await signed(contested, novaSecond)))),
      201,
      "wallet-link-response",
    );
    await refusal(
      await routes.link.POST(...post("/api/social/me/wallets", KAI.did, linkBody(kaiFirst, await signed(contested, kaiFirst)))),
      409,
      "wallet_taken",
    );
    assert.deepEqual(
      (await proven(admin)).filter((row) => row.address === contested.toSuiAddress()),
      [{ address: contested.toSuiAddress(), account_id: NOVA.id, kind: "external" }],
    );

    await resetLimits(admin);
    // Two accounts racing to link one address: exactly one wins.
    const raced = signer(51);
    const [a, b] = await Promise.all([challenge(routes, KAI.did, raced.toSuiAddress()), challenge(routes, NOVA.did, raced.toSuiAddress())]);
    const [first, second] = await Promise.all([
      routes.link.POST(...post("/api/social/me/wallets", KAI.did, linkBody(a, await signed(raced, a)))),
      routes.link.POST(...post("/api/social/me/wallets", NOVA.did, linkBody(b, await signed(raced, b)))),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [201, 409]);
    assert.equal((await proven(admin)).filter((row) => row.address === raced.toSuiAddress()).length, 1);
  }));

test("T-017-AC-3 (AC-126): social_wallet_link allows 10 per hour per account; the 11th is rate_limited", { skip }, () =>
  withDatabase(async ({ admin, routes }) => {
    const address = signer(61).toSuiAddress();
    for (let n = 1; n <= 10; n += 1) {
      const response = await routes.challenge.POST(...post("/api/social/me/wallets/challenge", KAI.did, { address }, `198.51.100.${n}`));
      assert.equal(response.status, 201, `request ${n}`);
    }
    const limited = await routes.link.POST(...post("/api/social/me/wallets", KAI.did, { challenge_id: uuid(1), address, message: "m", signature: "s" }));
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    await refusal(limited, 429, "rate_limited");
    assert.deepEqual(await proven(admin), []);
    // Per account: Nova is not limited.
    assert.equal((await routes.challenge.POST(...post("/api/social/me/wallets/challenge", NOVA.did, { address }))).status, 201);
  }));

test("T-017: closed bodies, sign-in and an account are required", { skip }, () =>
  withDatabase(async ({ admin, routes }) => {
    const path = "/api/social/me/wallets/challenge";
    await refusal(await routes.challenge.POST(...post(path, null, { address: wallet("1") })), 401, "unauthorized");
    await refusal(await routes.challenge.POST(...post(path, NOBODY_DID, { address: wallet("1") })), 409, "account_required");
    for (const body of [{}, { address: "1" }, { address: `0x${"g".repeat(64)}` }, { address: `0x${"1".repeat(65)}` }, { address: wallet("1"), kind: "slush" }, [wallet("1")]]) {
      await refusal(await routes.challenge.POST(...post(path, KAI.did, body)), 400, "invalid_request");
    }
    // Refusals count in the bucket too; start the link checks with a fresh window.
    await resetLimits(admin);
    const link = "/api/social/me/wallets";
    const base = { challenge_id: uuid(1), address: wallet("1"), message: "m", signature: "s" };
    for (const body of [
      { ...base, wallet: "phantom" },
      { ...base, challenge_id: "not-a-uuid" },
      { ...base, message: "" },
      { ...base, extra: true },
      { challenge_id: base.challenge_id, address: base.address, signature: "s" },
    ]) {
      await refusal(await routes.link.POST(...post(link, KAI.did, body)), 400, "invalid_request");
    }
    // A well-formed link whose challenge does not exist is an invalid signature.
    await refusal(await routes.link.POST(...post(link, KAI.did, base)), 400, "invalid_signature");
    assert.deepEqual(await proven(admin), []);
  }));
