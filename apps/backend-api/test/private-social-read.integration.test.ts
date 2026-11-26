import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import { partnerVerifierFixture } from "./partner-verifier-fixture.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SignJWT, importPKCS8 } from "jose";
import { Pool } from "pg";
import { bcs } from "@mysten/sui/bcs";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { createRedisConnection } from "@blast/core/lib/redis.ts";
import {
  RedisRateLimitEnforcer,
  quotaNamespace,
} from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { walletSessionTokenHash } from "@blast/core/modules/social/wallet-sign-in/sessions.ts";
import { privateBackendRelay } from "@blast/server/private/relay.ts";
import { parseRelayConfig } from "@blast/server/private/relay-config.ts";
import { seedPresaleStory } from "../../../packages/core/test/fixtures/modules/social/presales/presale-story.ts";
import { seedChainRead } from "../../../packages/core/test/fixtures/modules/database/chain-read-rows.ts";
import { freshTestDatabase } from "../../../packages/core/test/fixtures/modules/database/template.ts";
import { capacityFixture } from "./capacity-fixture.ts";
import { freePort, waitForHealth } from "./kit.ts";
import { RUNTIME_TEST_ENVIRONMENT } from "../../../packages/server/test/fixtures/config/runtime-config.ts";

const WALLET_ADDRESS = "0x" + "a".repeat(64);

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  const closed = once(child, "exit");
  child.kill("SIGTERM");
  const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await closed;
  clearTimeout(deadline);
}

type SocialCall = (
  path: string,
  method?: string,
  body?: string,
  purpose?: "browser" | "ssr-read",
  auth?: boolean,
) => Promise<Response>;

function socialCall(
  relay: ReturnType<typeof privateBackendRelay>,
  credentials: Record<string, string>,
): SocialCall {
  return async function call(
    path: string,
    method = "GET",
    body?: string,
    purpose: "browser" | "ssr-read" = "browser",
    auth = true,
  ) {
    return relay(
      new Request("https://frontend.test/api/social/" + path, {
        method,
        headers: {
          ...(purpose === "browser"
            ? { origin: "https://frontend.test", "sec-fetch-site": "same-origin" }
            : {}),
          ...(auth ? credentials : { authorization: "Bearer deliberately-invalid" }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body }),
      }),
      purpose,
    );
  };
}

async function verifyDiscovery(call: SocialCall): Promise<void> {
  for (const path of ["activity", "happening", "search?q=pilot"]) {
    const response = await call(path, "GET", undefined, "browser", false);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("cache-control") ?? "", /^public,/);
    const head = await call(path, "HEAD", undefined, "browser", false);
    assert.equal(head.status, 200, path);
    assert.equal(await head.text(), "");
  }
  assert.equal((await call("search?q=a&q=b", "GET", undefined, "browser", false)).status, 400);
  assert.equal(
    (await call("activity?before=invalid", "GET", undefined, "browser", false)).status,
    400,
  );
  for (const method of ["GET", "HEAD"]) {
    assert.equal((await call("happening", method, undefined, "ssr-read", false)).status, 200);
  }
  for (const path of ["activity", "search"]) {
    assert.equal((await call(path, "GET", undefined, "ssr-read", false)).status, 404);
  }
}

async function verifyHome(call: SocialCall, presaleId: string): Promise<void> {
  for (const path of ["home", `home/coins?presale=${presaleId}`, "home/traders"]) {
    const response = await call(path, "GET", undefined, "ssr-read", false);
    assert.equal(
      response.status,
      200,
      path + ": " + (response.status === 200 ? "ok" : await response.text()),
    );
    const head = await call(path, "HEAD", undefined, "ssr-read", false);
    assert.equal(head.status, 200, path);
    assert.equal(await head.text(), "");
  }
  for (const path of [
    `home/activity?presale=${presaleId}`,
    `home/discussion?presale=${presaleId}`,
  ]) {
    assert.equal((await call(path, "GET", undefined, "browser", false)).status, 200, path);
    assert.equal((await call(path, "GET", undefined, "ssr-read", false)).status, 404, path);
  }
}

/** Native acquisition and outside-venue disposal after graduation, without Blast order logs. */
async function seedCurvePnl(pool: Pool, address: string): Promise<void> {
  const now = Date.now();
  const launch = "0x" + "c001".padStart(64, "0");
  const coin = `${launch}::coin::CURVE`;
  const migratedPool = "cetus:0x" + "c002".padStart(64, "0");
  const quote = "0x" + "2".padStart(64, "0") + "::usdc::USDC";
  await pool.query(
    `INSERT INTO coins (coin_type,decimals,launcher,creator,metadata,pool_key,created_checkpoint,created_at_ms)
    VALUES ($1,9,$2,$2,$3,$4,900,$5)`,
    [
      coin,
      address,
      JSON.stringify({ name: "Curve coin", symbol: "CURVE" }),
      migratedPool,
      now - 86_400_000,
    ],
  );
  for (const [key, venue, lifecycle] of [
    [`blast_curve:${launch}`, "blast_curve", "migrated"],
    [migratedPool, "cetus", "active"],
  ]) {
    await pool.query(
      `INSERT INTO pools (pool_key,venue,coin_type,quote_type,lifecycle,created_checkpoint,created_at_ms)
      VALUES ($1,$2,$3,$4,$5,900,$6)`,
      [key, venue, coin, quote, lifecycle, now - 86_400_000],
    );
  }
  await seedChainRead(pool, {
    activity: [
      { kind: "trade_buy", venue: "blast_curve", amount: "100000000000", usd: "100" },
      { kind: "trade_sell", venue: "cetus", amount: "40000000000", usd: "80" },
    ].map((row, index) => ({
      checkpoint: 90000 + index,
      tx_slot: 0,
      event_slot: 1,
      part: 0,
      timestamp_ms: now - 60000 + index,
      digest: `CurvePnl${index}`.padEnd(44, "1"),
      kind: row.kind,
      product: "market",
      actor: address,
      tx_sender: address,
      presale_id: null,
      coin_type: coin,
      quote_type: quote,
      quote_amount: "0",
      coin_amount: row.amount,
      quote_refund: null,
      usd_value: row.usd,
      usd_price_as_of_ms: now - 60000,
      venue: row.venue,
      participants_after: null,
      total_commitments_after: null,
    })),
    coin_balances: [
      { coin_type: coin, owner: address, balance: "60000000000", updated_checkpoint: 90001 },
    ],
    prices: [{ coin_type: coin, usd_price: "2", as_of_ms: now, source: "pool" }],
  });
  await pool.query(
    "INSERT INTO blast_infra_fixture.wallet_sync(owner,timestamp_ms) VALUES($1,$2)",
    [address, now],
  );
}

async function verifyPortfolio(call: SocialCall, curvePnl = false): Promise<void> {
  for (const path of ["me/portfolio", "me/portfolio/coins", "me/pnl"]) {
    const response = await call(path);
    assert.equal(
      response.status,
      200,
      path + ": " + (response.status === 200 ? "ok" : await response.text()),
    );
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    if (curvePnl && path === "me/pnl") {
      const pnl = await response.json();
      assert.equal(pnl.history_complete, true);
      assert.deepEqual(pnl.totals, {
        realized_usd: "40.00",
        unrealized_usd: "60.00",
        total_usd: "100.00",
      });
      assert.equal(pnl.assets.length, 1);
      assert.equal(pnl.assets[0].launch_id, "0x" + "c001".padStart(64, "0"));
      assert.equal(pnl.assets[0].presale_id, null);
    }
    assert.equal((await call(path, "GET", undefined, "browser", false)).status, 401, path);
    assert.equal((await call(path, "GET", undefined, "ssr-read")).status, 404, path);
  }
  for (const suffix of ["portfolio", "pnl"]) {
    const response = await call(
      `profiles/retained_pilot/${suffix}`,
      "GET",
      undefined,
      "browser",
      false,
    );
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "portfolio_private");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const followingBody = JSON.stringify({ mode: "coins", window: "24h" });
  const following = await call("me/home/following", "POST", followingBody);
  assert.equal(following.status, 200);
  assert.equal(following.headers.get("cache-control"), "private, no-store");
  assert.equal(
    (await call("me/home/following", "POST", followingBody, "browser", false)).status,
    401,
  );
  assert.equal((await call("me/home/following", "POST", " ".repeat(4097))).status, 413);
}

async function verifyPersonal(call: SocialCall, logs: readonly string[]): Promise<void> {
  for (const path of ["me/transactions", "me/rewards", "me/referrals", "me/referrals/invitees", "me/referrals?view=monthly"]) {
    const response = await call(path);
    assert.equal(
      response.status,
      200,
      JSON.stringify({ path, body: await response.clone().text(), logs }),
    );
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    if (path.endsWith("?view=monthly")) {
      assert.ok(Array.isArray((await response.json()).months));
    }
    const head = await call(path, "HEAD");
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal((await call(path, "GET", undefined, "browser", false)).status, 401);
    assert.equal((await call(path, "GET", undefined, "ssr-read")).status, 404);
  }
}

async function verifyTransfers(call: SocialCall): Promise<void> {
  const path = "me/transfers/" + randomUUID();
  const body = JSON.stringify({
    coin_type: "0x" + "0".repeat(63) + "2::sui::SUI",
    amount: "1",
    recipient: "0x" + "b".repeat(64),
  });
  const created = await call(path, "PUT", body);
  assert.equal(created.status, 201, await created.clone().text());
  const first = await created.json();
  const repeated = await call(path, "PUT", body);
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), first);
  assert.equal((await call(path, "PUT", body, "browser", false)).status, 401);
  assert.equal((await call(path, "PUT", body, "ssr-read")).status, 404);
  assert.equal((await call(path, "PUT", "x".repeat(4097))).status, 413);
}

function transactionProof(sender: string) {
  const bytes = bcs.TransactionData.serialize({
    V1: {
      kind: { ProgrammableTransaction: { inputs: [], commands: [] } },
      sender,
      gasData: { owner: sender, payment: [], price: "1000", budget: "2000000" },
      expiration: { None: true },
    },
  }).toBytes();
  return {
    tx_digest: TransactionDataBuilder.getDigestFromBytes(bytes),
    transaction_bytes: toBase64(bytes),
  };
}

async function verifyIntents(call: SocialCall, presaleId: string, first: boolean): Promise<void> {
  const intent = { action: "commit", presale_id: presaleId };
  const foreign = await call(
    "intents",
    "POST",
    JSON.stringify({ ...intent, ...transactionProof("0x" + "b".repeat(64)) }),
  );
  assert.equal(foreign.status, 400);
  const invalid = await call(
    "intents",
    "POST",
    JSON.stringify({ ...intent, ...transactionProof(WALLET_ADDRESS), transaction_bytes: "!" }),
  );
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "invalid_request");
  const body = JSON.stringify({ ...intent, ...transactionProof(WALLET_ADDRESS) });
  const response = await call("intents", "POST", body);
  assert.equal(response.status, first ? 201 : 200, await response.clone().text());
  assert.deepEqual(await response.json(), { status: first ? "recorded" : "duplicate", why: null });
  const repeated = await call("intents", "POST", body);
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), { status: "duplicate", why: null });
  assert.equal((await call("intents", "POST", body, "browser", false)).status, 401);
  assert.equal((await call("intents", "POST", body, "ssr-read")).status, 404);
}

async function verifyDeposits(call: SocialCall): Promise<void> {
  const status = await call("me/deposits");
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { available: false });
  const head = await call("me/deposits", "HEAD");
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  const refused = await call(
    "me/deposits/" + randomUUID(),
    "PUT",
    JSON.stringify({ source: "base", amount: "500000000" }),
  );
  assert.equal(refused.status, 409, await refused.clone().text());
  assert.equal((await refused.json()).error.code, "deposit_unavailable");
  assert.equal((await call("me/deposits", "GET", undefined, "browser", false)).status, 401);
  assert.equal((await call("me/deposits", "GET", undefined, "ssr-read")).status, 404);
}

async function verifyTrades(
  call: SocialCall,
  relay: ReturnType<typeof privateBackendRelay>,
  walletToken: string,
): Promise<void> {
  for (const method of ["GET", "HEAD"]) {
    const response = await call("trades/coins", method, undefined, "browser", false);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") ?? "", /^public,/);
    if (method === "HEAD") {
      assert.equal(await response.text(), "");
    }
  }
  const body = JSON.stringify({
    in_coin: "0x" + "2".padStart(64, "0") + "::sui::SUI",
    out_coin: "0x" + "999".padStart(64, "0") + "::unknown::UNKNOWN",
    side: "buy",
    amount_in: "1",
  }).padEnd(4096, " ");
  const quote = await relay(
    new Request("https://frontend.test/api/social/trades/quote", {
      method: "POST",
      headers: {
        origin: "https://frontend.test",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        cookie: `__Host-blast_wallet=${walletToken}`,
      },
      body,
    }),
  );
  assert.equal(quote.status, 200, await quote.clone().text());
  assert.equal(quote.headers.get("cache-control"), "private, no-store");
  const anonymous = await relay(
    new Request("https://frontend.test/api/social/trades/quote", {
      method: "POST",
      headers: {
        origin: "https://frontend.test",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body,
    }),
  );
  assert.equal(anonymous.status, 200);
  assert.equal((await call("trades/quote", "POST", body + " ")).status, 413);
  assert.equal((await call("trades", "POST", "{}", "browser", false)).status, 401);
  assert.equal((await call("trades", "POST", "{}")).status, 400);
  assert.equal(
    (await call("trades/00000000-0000-4000-8000-000000000099/settle", "POST")).status,
    404,
  );
  assert.equal((await call("trades/coins", "GET", undefined, "ssr-read")).status, 404);
}

async function verifySales(call: SocialCall, presaleId: string): Promise<void> {
  for (const method of ["GET", "HEAD"]) {
    const response = await call(`sales/${presaleId}/metadata`, method);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    if (method === "HEAD") {
      assert.equal(await response.text(), "");
    } else {
      assert.equal((await response.json()).editable, false);
    }
  }
  const invalid = await call(
    `sales/${presaleId}/metadata`,
    "PUT",
    JSON.stringify({ unknown: true }),
  );
  assert.equal(invalid.status, 400);
  await invalid.text();
  const unavailable = await call(`sales/${presaleId}/cover`, "POST", "not-a-file");
  assert.equal(unavailable.status, 503);
  await unavailable.text();
  const oversized = await call(`sales/${presaleId}/cover`, "POST", "x".repeat(4_016_385));
  assert.equal(oversized.status, 413);
  await oversized.text();
}

async function verifyProfileEdit(call: SocialCall): Promise<void> {
  for (const method of ["GET", "HEAD"]) {
    const response = await call("me/profile", method);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    if (method === "HEAD") {
      assert.equal(await response.text(), "");
    } else {
      assert.equal((await response.json()).upload_available, false);
    }
  }
  const invalid = await call("me/profile", "PUT", JSON.stringify({ display_name: "" }));
  assert.equal(invalid.status, 422);
  await invalid.text();
  const unavailable = await call("me/profile/picture", "PUT", "not-an-image");
  assert.equal(unavailable.status, 503);
  await unavailable.text();
  const oversized = await call("me/profile/picture", "PUT", "x".repeat(2_097_153));
  assert.equal(oversized.status, 413);
  await oversized.text();
}

async function verifyLaunchpadChallenge(
  relay: ReturnType<typeof privateBackendRelay>,
): Promise<void> {
  const path = "https://frontend.test/api/launchpad/wallet-proofs";
  const csrf = "c".repeat(43);
  const headers = {
    origin: "https://frontend.test",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    cookie: `__Host-blast_csrf=${csrf}`,
    "x-blast-csrf": csrf,
  };
  const body = JSON.stringify({ action: "social_post", address: "0x" + "1".repeat(64) });
  const response = await relay(
    new Request(path, { method: "POST", headers, body: body.padEnd(1024, " ") }),
  );
  assert.equal(response.status, 201, await response.clone().text());
  const result = (await response.json()) as {
    challenge: { challengeId: string; action: string; message: string };
  };
  assert.equal(result.challenge.action, "social_post");
  assert.ok(result.challenge.challengeId);
  assert.match(result.challenge.message, /BLAST.FUN launchpad wallet proof/);
  const missing = await relay(
    new Request(path, { method: "POST", headers: { ...headers, "x-blast-csrf": "" }, body }),
  );
  assert.equal(missing.status, 403);
  await missing.text();
  const oversized = await relay(
    new Request(path, { method: "POST", headers, body: body.padEnd(1025, " ") }),
  );
  assert.equal(oversized.status, 413);
  await oversized.text();
}

async function verifyClaims(call: SocialCall, presaleId: string): Promise<void> {
  const earnings = await call("me/creator-earnings");
  assert.equal(earnings.status, 409, await earnings.clone().text());
  assert.equal((await earnings.json()).error.code, "claim_unavailable");
  const head = await call("me/creator-earnings", "HEAD");
  assert.equal(head.status, 409);
  assert.equal(await head.text(), "");
  const claim = await call(
    "me/claims/" + randomUUID(),
    "PUT",
    JSON.stringify({ presale_id: presaleId, kind: "claim_refund" }),
  );
  assert.equal(claim.status, 409, await claim.clone().text());
  assert.equal((await claim.json()).error.code, "nothing_to_claim");
  assert.equal((await call("me/creator-earnings", "GET", undefined, "browser", false)).status, 401);
  assert.equal((await call("me/creator-earnings", "GET", undefined, "ssr-read")).status, 404);
}

async function verifyCommunityScenario(
  call: SocialCall,
  relay: ReturnType<typeof privateBackendRelay>,
  walletToken: string,
  presaleId: string,
  first: boolean,
  logs: readonly string[],
): Promise<void> {
  await verifyLaunchpadChallenge(relay);
  await verifyProfileEdit(call);
  await verifySales(call, presaleId);
  await verifyTrades(call, relay, walletToken);
  await verifyDiscovery(call);
  await verifyHome(call, presaleId);
  await verifyPortfolio(call);
  await verifyPersonal(call, logs);
  await verifyIntents(call, presaleId, first);
  if (!first) {
    await verifyTransfers(call);
    await verifyDeposits(call);
    await verifyClaims(call, presaleId);
  }
  const feedResponse = await call("feed", "GET", undefined, "ssr-read", false);
  assert.equal(
    feedResponse.status,
    200,
    JSON.stringify({ body: await feedResponse.clone().text(), logs }),
  );
  const feed = await feedResponse.json();
  assert.ok(feed.items.length > 0, "Seeded public lifecycle entries are visible");
  const entry = encodeURIComponent(feed.items[0].entry_id);
  const post = await call(`items/${entry}`, "GET", undefined, "ssr-read", false);
  assert.equal(post.status, 200);
  assert.equal((await post.json()).item.entry_id, feed.items[0].entry_id);
  for (const suffix of ["", "/items", "/calls", "/theses", "/connections", "/mutuals"]) {
    const response = await call("profiles/retained_pilot" + suffix);
    assert.equal(response.status, 200, suffix);
  }
  for (const path of [
    "feed",
    `items/${entry}`,
    "profiles/retained_pilot",
    "profiles/retained_pilot/calls",
  ]) {
    const response = await call(path, "HEAD", undefined, "ssr-read");
    assert.equal(
      response.status,
      200,
      JSON.stringify({ path, body: await response.clone().text(), logs }),
    );
    assert.equal(await response.text(), "");
  }
  assert.equal(
    (await call("profiles/retained_pilot/connections", "GET", undefined, "ssr-read")).status,
    404,
  );
  for (let repeat = 0; repeat < 2; repeat++) {
    assert.equal((await call(`items/${entry}/reactions/rocket`, "PUT", "{}")).status, 204);
  }
  const state = await call(
    "viewer-state",
    "POST",
    JSON.stringify({ entry_ids: [feed.items[0].entry_id] }),
  );
  assert.equal(state.status, 200);
  assert.deepEqual((await state.json()).reactions[feed.items[0].entry_id], ["rocket"]);
  assert.equal((await call(`items/${entry}/reactions/rocket`, "DELETE")).status, 204);
  assert.equal(
    (await call(`items/${entry}/why`, "POST", '{"text":"A useful reason"}', "ssr-read")).status,
    404,
  );
  const missingProfile = await call("profiles/nobody_here", "GET", undefined, "ssr-read");
  assert.equal(missingProfile.status, 404);
  for (const path of ["me/presales", "me/presales/created"]) {
    assert.equal((await call(path)).status, 200);
  }
}

async function verifySocialReads(t: TestContext, pnlOnly: boolean): Promise<void> {
  const server = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
  const redisUrl = process.env.BLAST_TEST_REDIS_URL;
  assert.ok(
    server && redisUrl,
    "Disposable loopback PostgreSQL and Redis are required; never skip.",
  );
  for (const value of [server, redisUrl]) {
    assert.equal(new URL(value).hostname, "127.0.0.1");
  }
  const testDatabase = await freshTestDatabase();
  const database = testDatabase.url;
  const pool = new Pool({ connectionString: database, max: 2 });
  const redis = createRedisConnection(redisUrl, "quota");
  // After-hooks run in the order they were added, so this one stops the backends itself before dropping their database.
  const children: ChildProcess[] = [];
  t.after(async () => {
    await Promise.all(children.map(stop));
    redis.close();
    await pool.end();
    await testDatabase.drop();
  });
  const story = await seedPresaleStory(pool, { nowMs: Date.now(), crowd: 1, social: false });
  const presaleId = Object.values(story.presaleIds)[0]!;
  const targetId = randomUUID();
  await pool.query(
    "INSERT INTO social_accounts(account_id, privy_did, callsign) VALUES($1,'did:privy:community-target','community_target')",
    [targetId],
  );
  const accountId = randomUUID();
  const address = WALLET_ADDRESS;
  const walletToken = "w".repeat(43);
  const expiredToken = "e".repeat(43);
  await pool.query(
    "INSERT INTO social_accounts(account_id, privy_did, callsign, display_name) VALUES($1,$2,'retained_pilot','Retained pilot')",
    [accountId, "did:privy:retained-pilot"],
  );
  await pool.query(
    "INSERT INTO social_account_wallets(address,account_id,kind,verified_at) VALUES($1,$2,'slush',now())",
    [address, accountId],
  );
  await pool.query("INSERT INTO presale_embedded_wallets(privy_did,address) VALUES($1,$2)", [
    "did:privy:retained-pilot",
    address,
  ]);
  const beforeEmbedded = (await pool.query("SELECT * FROM presale_embedded_wallets")).rows;
  await seedCurvePnl(pool, address);
  for (const [token, expired] of [
    [walletToken, false],
    [expiredToken, true],
  ] as const) {
    await pool.query(
      `INSERT INTO social_wallet_sessions(session_id,token_hash,wallet_address,challenge_id,created_at,expires_at,last_used_at)
      VALUES($1,$2,$3,$4,now()-CASE WHEN $5 THEN interval '2 days' ELSE interval '0' END,now()+CASE WHEN $5 THEN interval '-1 minute' ELSE interval '1 day' END,now()-CASE WHEN $5 THEN interval '2 hours' ELSE interval '0' END)`,
      [randomUUID(), walletSessionTokenHash(token), address, randomUUID(), expired],
    );
  }
  await pool.query(
    "UPDATE social_accounts SET onboarding_shown_at=now(), onboarded_at=now(), default_follows_applied_at=now(), launch_code_follow_applied_at=now() WHERE account_id=$1",
    [accountId],
  );
  const beforeAccount = (
    await pool.query("SELECT * FROM social_accounts WHERE account_id=$1", [accountId])
  ).rows[0];
  const beforeWallets = (
    await pool.query("SELECT * FROM social_account_wallets WHERE account_id=$1 ORDER BY address", [
      accountId,
    ])
  ).rows;
  const beforeSession = (
    await pool.query("SELECT * FROM social_wallet_sessions WHERE token_hash=$1", [
      walletSessionTokenHash(walletToken),
    ])
  ).rows[0];
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const environment = {
    ...RUNTIME_TEST_ENVIRONMENT,
    PATH: process.env.PATH,
    NODE_ENV: "test",
    TZ: "UTC",
    DATABASE_URL: database,
    PARTNER_VERIFIER_DATABASE_URL: await partnerVerifierFixture(database, t),
    // Local parity fixture shares seeded storage; this does not prove replica lag behavior.
    DATABASE_REPLICA_URL: database + "?application_name=social-read-fixture-replica",
    BLAST_QUOTA_REDIS_URL: redisUrl,
    BLAST_REDIS_NAMESPACE: `private-community:${randomUUID()}`,
    BLAST_PARTNER_CAPACITY_CONFIG: capacityFixture(["private-fixture"]),
    RATE_LIMIT_SUBJECT_PEPPER: "synthetic-private-subject-pepper-01234567890123456789",
    LAUNCHPAD_SUBJECT_PEPPER: "synthetic-launchpad-subject-pepper-01234567890123456789",
    BLAST_BACKEND_GATEWAY_SECRET: "synthetic-private-gateway-secret-01234567890123456789",
    BLAST_BACKEND_INGRESS_MODE: "direct",
    BLAST_BACKEND_LISTEN_HOST: "127.0.0.1",
    NEXT_PUBLIC_SITE_URL: "https://frontend.test",
    PRIVY_APP_ID: "retained-existing-app",
    PRIVY_JWT_VERIFICATION_KEY: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    BLAST_DEPLOYMENT_TARGET: "preview",
    BLAST_DEPLOYMENT_BRANCH: "private-local-fixture",
  };
  const namespace = quotaNamespace(
    environment.BLAST_REDIS_NAMESPACE,
    deploymentIdentity(environment),
  );
  await new RedisRateLimitEnforcer({
    redis,
    namespace,
    subjectPepper: environment.RATE_LIMIT_SUBJECT_PEPPER,
  }).consume("partner_read", { apiKeyId: randomUUID() });
  const paidKeys = (await redis.execute(["KEYS", `${namespace}:*:partner_read:*`])) as string[];
  // Keep synthetic sentinel values alive across a minute boundary; production TTL policy is tested separately.
  await Promise.all(paidKeys.map((key) => redis.execute(["PEXPIRE", key, "120000"])));
  const paidBefore = await Promise.all(paidKeys.map((key) => redis.execute(["GET", key])));
  assert.equal(paidKeys.length, 2);
  const cwd = await mkdtemp(join(tmpdir(), "blast-private-community-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const logs: string[] = [];

  async function start() {
    const port = await freePort();
    const child = spawn(
      process.execPath,
      [
        "--no-env-file",
        "--preload",
        new URL("./loopback-fetch-only.ts", import.meta.url).pathname,
        new URL("../src/main.ts", import.meta.url).pathname,
      ],
      {
        cwd,
        env: { ...environment, PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout!.on("data", (data) => {
      logs.push(data.toString());
    });
    child.stderr!.on("data", (data) => {
      logs.push(data.toString());
    });
    children.push(child);
    const origin = `http://127.0.0.1:${port}`;
    return waitForHealth(child, origin, 40_000);
  }

  const origins = [await start(), await start()];
  const token = await new SignJWT({ sid: "retained-session" })
    .setProtectedHeader({ alg: "ES256" })
    .setSubject("did:privy:retained-pilot")
    .setIssuer("privy.io")
    .setAudience(environment.PRIVY_APP_ID)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(
      await importPKCS8(
        keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        "ES256",
      ),
    );
  const beforeCount = (await pool.query("SELECT count(*)::int AS n FROM social_accounts")).rows[0]
    .n;
  for (const backend of origins) {
    const relay = privateBackendRelay(
      parseRelayConfig({ ...environment, BLAST_BACKEND_API_ORIGIN: backend }),
      { clientAddress: () => "192.0.2.2" },
    );
    const credentials: Record<string, string> =
      backend === origins[0]
        ? { authorization: `Bearer ${token}` }
        : { cookie: `__Host-blast_wallet=${walletToken}` };
    const call = socialCall(relay, credentials);
    if (pnlOnly) {
      await verifyHome(call, presaleId);
      await verifyPortfolio(call, true);
      continue;
    }
    await verifyCommunityScenario(
      call,
      relay,
      walletToken,
      presaleId,
      backend === origins[0],
      logs,
    );
  }
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM presale_bridge_transfers")).rows[0].n,
    0,
  );
  assert.deepEqual(
    (await pool.query("SELECT * FROM social_accounts WHERE account_id=$1", [accountId])).rows[0],
    beforeAccount,
  );
  assert.deepEqual(
    (
      await pool.query(
        "SELECT * FROM social_account_wallets WHERE account_id=$1 ORDER BY address",
        [accountId],
      )
    ).rows,
    beforeWallets,
  );
  assert.deepEqual(
    (
      await pool.query("SELECT * FROM social_wallet_sessions WHERE token_hash=$1", [
        walletSessionTokenHash(walletToken),
      ])
    ).rows[0],
    beforeSession,
  );
  assert.deepEqual(
    await Promise.all(paidKeys.map((key) => redis.execute(["GET", key]))),
    paidBefore,
  );
  assert.deepEqual(
    (await pool.query("SELECT * FROM presale_embedded_wallets")).rows,
    beforeEmbedded,
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM social_accounts")).rows[0].n,
    beforeCount,
  );
  t.diagnostic(
    "Two native Bun listeners retain identity, wallet session and paid counters against disposable chain facts; no provider or chain request.",
  );
}

test(
  "feed profile comments and SSR preserve authority through two native Bun listeners",
  { timeout: 90_000 },
  (t) => verifySocialReads(t, false),
);
test(
  "curve PnL includes outside-venue trades through both native backend authentication paths",
  { timeout: 90_000 },
  (t) => verifySocialReads(t, true),
);
