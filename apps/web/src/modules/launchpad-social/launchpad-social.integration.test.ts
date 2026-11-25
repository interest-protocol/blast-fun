import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { createPrivySessionVerifier } from "@blast/server/lib/privy-adapter/adapter.ts";
import { createSyntheticPrivyGateway, SYNTHETIC_SUI_ADDRESS } from "../../../../../packages/core/test/fixtures/lib/privy-adapter/fixtures.ts";
import type { RateBucket, RateLimitPort, RateLimitSubject } from "@blast/core/lib/web-security/rate-limits.ts";
import { CursorError, encodeCursor } from "@blast/core/modules/launchpad-contract/cursor.ts";
import { createLaunchpadWalletProofRoutes } from "@blast/server/modules/launchpad-identity/route.ts";
import { LaunchpadIdentityService } from "@blast/server/modules/launchpad-identity/service.ts";
import { resetDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import {
  FIXTURE_CHECKPOINT,
  FIXTURE_FINGERPRINT,
  FIXTURE_NETWORK,
  advanceWatermark,
  urlAs,
} from "../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../packages/core/test/fixtures/modules/database/template.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { syntheticSlushSigner } from "../../../../../packages/core/test/fixtures/modules/mission-control/wallet-challenges/testing.ts";
import { measureChainPosition, type ChainJoinDependencies } from "@blast/server/modules/read-routing/chain-join.ts";
import { SocialQueryError, thesesCursor, type HolderProof } from "@blast/server/modules/launchpad-social/contracts.ts";
import type { HolderProofPort } from "@blast/server/modules/launchpad-social/holder-proof.ts";
import { setThesisVisibility } from "./moderation.ts";
import { parseThesisListResponse } from "@blast/core/modules/launchpad-social/list-contract.ts";
import { databaseThesisSource, handleThesisListRequest } from "@blast/server/modules/launchpad-social/list-resource.ts";
import { postHandler } from "@blast/server/modules/launchpad-social/mutation.ts";
import { listLaunchTheses, postAudit, searchTheses } from "@blast/server/modules/launchpad-social/reads.ts";
import { installRuntimeConfig } from "../../../../../packages/server/test/fixtures/config/runtime-config.ts";
import { testClient } from "../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";

// The default wallet verifier reads its node URL from the API runtime config.
installRuntimeConfig();

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";

const ORIGIN = "https://blast.fun";
const PRIVY_TOKEN = "synthetic-access-token";
const PRIVY_NOW = 2_000_000_000;
const SUBJECT_PEPPER = "launchpad-social-test-pepper-of-32-characters";
const EXPECTED = { network: FIXTURE_NETWORK, deployment: FIXTURE_FINGERPRINT } as const;
const SLUSH = syntheticSlushSigner.toSuiAddress();

function objectId(label: number): string {
  return `0x${label.toString(16).padStart(64, "0")}`;
}

/** Two canonical launches, a cetus pool whose ID is no launch, and a launch blast-infra never indexed. */
const LAUNCH_A = objectId(0xa1);
const LAUNCH_B = objectId(0xb1);
const CETUS_POOL = objectId(0xc1);
const FOREIGN = objectId(0xf1);
const COIN_A = `${objectId(0xa2)}::alpha::ALPHA`;
const COIN_B = `${objectId(0xb2)}::beta::BETA`;

class AllowingLimiter implements RateLimitPort {
  readonly calls: string[] = [];
  async consume(bucket: RateBucket, subject: RateLimitSubject) {
    this.calls.push(`${bucket}:${subject.ip ?? "-"}`);
    return { allowed: true, bucket, policyVersion: 1, retryAfterSeconds: 0 };
  }
}

/** A holder proof that answers whatever the scenario set, and counts its calls. */
class ScriptedHolderProof implements HolderProofPort {
  answer: HolderProof | Error = { verification: "unavailable" };
  calls = 0;
  async prove(): Promise<HolderProof> {
    this.calls += 1;
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

interface Harness {
  admin: Pool;
  web: Pool;
  replica: Pool;
  identity: LaunchpadIdentityService;
  limiter: AllowingLimiter;
  holderProof: ScriptedHolderProof;
  /** Whether the Privy user has an embedded Sui wallet. */
  privyWallet: boolean;
  csrf: string;
  ids: number;
}

async function withHarness(body: (harness: Harness) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 2 });
  await admin.query(
    `INSERT INTO coins (coin_type, decimals, launcher, creator, metadata, pool_key, created_checkpoint, created_at_ms)
     VALUES ($1, 9, $5, $5, '{"name":"Alpha","symbol":"ALPHA","icon_url":"https://i/a.png"}', $3, 901, 1790000000001),
            ($2, 9, $6, $6, '{"name":"Beta","symbol":"BETA","icon_url":"https://i/b.png"}', $4, 902, 1790000000002)`,
    // Alpha's creator is the Privy user's embedded wallet; Beta's is the Slush wallet.
    [COIN_A, COIN_B, `blast_curve:${LAUNCH_A}`, `blast_curve:${LAUNCH_B}`, SYNTHETIC_SUI_ADDRESS, SLUSH],
  );
  await admin.query(
    `INSERT INTO pools (pool_key, venue, coin_type, quote_type, lifecycle, created_checkpoint, created_at_ms)
     VALUES ($1, 'blast_curve', $4, '0x2::sui::SUI', 'live', 901, 1790000000001),
            ($2, 'blast_curve', $5, '0x2::sui::SUI', 'live', 902, 1790000000002),
            ($3, 'cetus', $4, '0x2::sui::SUI', 'migrated', 903, 1790000000003)`,
    [`blast_curve:${LAUNCH_A}`, `blast_curve:${LAUNCH_B}`, `cetus:${CETUS_POOL}`, COIN_A, COIN_B],
  );
  const settings = {
    connectionTimeoutMs: 2_000,
    idleInTransactionMs: 5_000,
    idleTimeoutMs: 1_000,
    lockTimeoutMs: 1_000,
    max: 4,
    statementTimeoutMs: 4_000,
  };
  // Writes run as the web runtime role and public reads as the replica role, as in production.
  const web = createRuntimePool(urlAs(database.url, "blast_web"), settings);
  const replica = createRuntimePool(urlAs(database.url, "blast_replica"), settings, "blast-replica");
  let nonce = 1;
  const limiter = new AllowingLimiter();
  const harness: Harness = {
    admin,
    web,
    replica,
    limiter,
    holderProof: new ScriptedHolderProof(),
    privyWallet: true,
    identity: new LaunchpadIdentityService(web, {
      createNonce: () => Buffer.alloc(32, nonce++).toString("base64url"),
      limiter,
      subjectPepper: SUBJECT_PEPPER,
      verifyPrivySession: (token) =>
        createPrivySessionVerifier({
          appId: "synthetic-privy-app",
          gateway: createSyntheticPrivyGateway("success", { withWallet: harness.privyWallet }),
          now: () => PRIVY_NOW,
        }).verifySession(token),
    }),
    csrf: "",
    ids: 1,
  };
  try {
    const bootstrap = await walletProofRoutes(harness).csrf(new Request(`${ORIGIN}/api/launchpad/csrf`));
    harness.csrf = /__Host-blast_csrf=([A-Za-z0-9_-]{43});/.exec(bootstrap.headers.get("set-cookie") ?? "")?.[1] ?? "";
    assert.ok(harness.csrf);
    await body(harness);
  } finally {
    await Promise.all([admin.end(), web.end(), replica.end()]);
    await database.drop();
  }
}

function walletProofRoutes(harness: Harness) {
  return createLaunchpadWalletProofRoutes({ expectedOrigin: ORIGIN, identity: harness.identity });
}

function headers(harness: Harness, extra: Record<string, string> = {}): Headers {
  return new Headers({
    "content-type": "application/json",
    cookie: `__Host-blast_csrf=${harness.csrf}`,
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    "x-blast-csrf": harness.csrf,
    ...extra,
  });
}

const NO_DISCLOSURE = { text: null, walletAddress: null };

function postInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    launchId: LAUNCH_A,
    kind: "community_thesis",
    stance: "bullish",
    body: "The curve fills steadily and the creator answers questions.",
    evidenceLinks: ["https://example.com/thread"],
    disclosure: NO_DISCLOSURE,
    revisionOf: null,
    ...overrides,
  };
}

function handler(harness: Harness, holderProof: HolderProofPort | null = harness.holderProof) {
  return postHandler(
    {
      expected: EXPECTED,
      holderProof,
      createId: () => `00000000-0000-4000-8000-${String(harness.ids++).padStart(12, "0")}`,
    },
    { expectedOrigin: ORIGIN, identity: harness.identity, limiter: harness.limiter, pool: harness.web },
  );
}

async function postWithPrivy(harness: Harness, input: Record<string, unknown>, holderProof?: HolderProofPort | null, idempotencyKey?: string): Promise<Response> {
  return handler(harness, holderProof)(new Request(`${ORIGIN}/api/launchpad/theses`, {
    method: "POST",
    headers: headers(harness, { authorization: `Bearer ${PRIVY_TOKEN}`, ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) }),
    body: JSON.stringify({ input }),
  }), testClient());
}

/** A fresh Wallet Proof for `social_post`, signed by the synthetic Slush wallet. */
async function walletProof(harness: Harness) {
  const response = await walletProofRoutes(harness).issue(new Request(`${ORIGIN}/api/launchpad/wallet-proofs`, {
    method: "POST",
    headers: headers(harness),
    body: JSON.stringify({ action: "social_post", address: SLUSH }),
  }), testClient());
  assert.equal(response.status, 201);
  const { challenge } = await response.json() as { challenge: { address: string; challengeId: string; message: string } };
  const { signature } = await syntheticSlushSigner.signPersonalMessage(new TextEncoder().encode(challenge.message));
  return { address: challenge.address, challengeId: challenge.challengeId, message: challenge.message, signature };
}

async function postWithProof(harness: Harness, input: Record<string, unknown>, proof?: Record<string, string>) {
  const used = proof ?? await walletProof(harness);
  const response = await handler(harness)(new Request(`${ORIGIN}/api/launchpad/theses`, {
    method: "POST",
    headers: headers(harness),
    body: JSON.stringify({ input, proof: used }),
  }), testClient());
  return { response, proof: used };
}

function audit(harness: Harness, thesisId: string) {
  return postAudit(autocommitReader(harness.web, "launchpad-social"), thesisId);
}

type CreatedPost = {
  id: string;
  thesisId: string;
  kind: string;
  stance: string | null;
  authorIdentityId: string;
  authorLabels: string[];
  disclosure: Record<string, unknown>;
};

async function created(response: Response): Promise<CreatedPost> {
  assert.equal(response.status, 201, await response.clone().text());
  return ((await response.json()) as { post: CreatedPost }).post;
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

async function storedRecords(harness: Harness): Promise<number> {
  const result = await harness.admin.query<{ theses: string; documents: string }>(
    `SELECT (SELECT count(*) FROM mission_control_launchpad_theses) AS theses,
            (SELECT count(*) FROM mission_control_launchpad_search_documents) AS documents`,
  );
  const row = result.rows[0];
  assert.equal(row?.documents, row?.theses, "every stored record here is public and current");
  return Number(row?.theses);
}

/** Public reads as production routes them: the replica role first, the web role as the primary. */
async function chainJoin(harness: Harness): Promise<ChainJoinDependencies> {
  await harness.admin.query(advanceWatermark(FIXTURE_CHECKPOINT));
  return {
    replica: autocommitReader(harness.replica, "chain-read"),
    primary: autocommitReader(harness.web, "chain-read"),
    position: (source) => measureChainPosition(source === "replica" ? harness.replica : harness.web, source),
    now: Date.now,
    requireRecovery: false,
    expected: EXPECTED,
  };
}

async function listPage(harness: Harness, launchId: string, request: { limit?: string; cursor?: string | null }) {
  const page = await listLaunchTheses(launchId, request, await chainJoin(harness));
  assert.equal(page.status, "fresh");
  assert.equal(page.provenance.source, "replica");
  assert.ok("data" in page);
  return page.data;
}

async function search(harness: Harness, query: string) {
  const answer = await searchTheses(query, { limit: "10", cursor: null }, await chainJoin(harness));
  assert.equal(answer.status, "fresh");
  assert.ok("data" in answer);
  return answer.data.theses;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("a Privy session and a Wallet Proof each persist a complete post under an opaque author identity", { skip }, async () => {
  await withHarness(async (harness) => {
    const before = Date.now();
    const privy = await created(await postWithPrivy(harness, postInput({ disclosure: { text: "I hold a small bag.", walletAddress: null } })));
    const again = await created(await postWithPrivy(harness, postInput({ body: "Second take" })));
    const proven = await created((await postWithProof(harness, postInput({
      launchId: LAUNCH_B, stance: "bearish", body: "Concentrated supply; I sold.", evidenceLinks: [],
    }))).response);
    assert.equal(again.authorIdentityId, privy.authorIdentityId, "one durable identity per author");
    assert.notEqual(proven.authorIdentityId, privy.authorIdentityId);
    assert.match(privy.authorIdentityId, UUID);
    for (const post of [privy, again, proven]) {
      const text = JSON.stringify(post);
      assert.ok(!text.includes(SYNTHETIC_SUI_ADDRESS.slice(2)) && !text.includes(SLUSH.slice(2)), "no undisclosed wallet is public");
    }
    assert.deepEqual(harness.limiter.calls.filter((call) => call.startsWith("launchpad_social_post")).length, 3);

    const privyAudit = await audit(harness, privy.thesisId);
    assert.ok(privyAudit);
    const [record] = privyAudit.records;
    const subjectKey = record.author.subjectKey;
    assert.match(subjectKey ?? "", /^[0-9a-f]{64}$/, "a keyed hash of the Privy DID, never the DID");
    const createdAt = Date.parse(record.createdAt);
    assert.ok(createdAt >= before - 1_000 && createdAt <= Date.now() + 1_000, "server time");
    assert.deepEqual(record, {
      id: privy.id,
      thesisId: privy.id,
      revisionOf: null,
      launchId: LAUNCH_A,
      kind: "community_thesis",
      stance: "bullish",
      authorIdentityId: privy.authorIdentityId,
      body: "The curve fills steadily and the creator answers questions.",
      evidenceLinks: ["https://example.com/thread"],
      disclosure: { text: "I hold a small bag.", walletAddress: null, verification: "not_requested", observedCheckpoint: null, observedAt: null },
      authorLabels: [],
      provenance: { network: FIXTURE_NETWORK, deployment: FIXTURE_FINGERPRINT, checkpoint: FIXTURE_CHECKPOINT },
      postedAt: record.createdAt,
      createdAt: record.createdAt,
      moderationState: "public",
      moderationChangedAt: null,
      author: { method: "privy", subjectKey, walletAddress: null },
    });
    assert.deepEqual(privyAudit.moderation, []);
    assert.deepEqual((await audit(harness, proven.thesisId))?.records.map((row) => [row.launchId, row.author, row.stance]), [
      [LAUNCH_B, { method: "wallet_proof", subjectKey: null, walletAddress: SLUSH }, "bearish"],
    ]);
  });
});

test("foreign, non-curve, stanceless downgraded and cross-launch writes fail atomically and leave the Wallet Proof unspent", { skip }, async () => {
  await withHarness(async (harness) => {
    const refusals: [Record<string, unknown>, number, string][] = [
      [postInput({ launchId: FOREIGN }), 404, "LAUNCHPAD_NOT_FOUND"],
      [postInput({ launchId: CETUS_POOL }), 404, "LAUNCHPAD_NOT_FOUND"],
      [postInput({ evidenceLinks: ["javascript:alert(1)"] }), 400, "LAUNCHPAD_REQUEST_INVALID"],
      [postInput({ body: "hidden \u202Eoverride" }), 400, "LAUNCHPAD_REQUEST_INVALID"],
      // Disclosing someone else's wallet is refused before anything is read.
      [postInput({ disclosure: { text: null, walletAddress: SYNTHETIC_SUI_ADDRESS } }), 403, "LAUNCHPAD_FORBIDDEN"],
      // Not Alpha's creator: the update becomes a community thesis, which needs a stance.
      [postInput({ kind: "creator_update", stance: null }), 400, "LAUNCHPAD_STANCE_REQUIRED"],
    ];
    const proof = await walletProof(harness);
    for (const [input, status, code] of refusals) {
      const { response } = await postWithProof(harness, input, proof);
      assert.equal(response.status, status, JSON.stringify(input));
      assert.equal(await errorCode(response), code);
    }
    assert.equal(await storedRecords(harness), 0);
    assert.equal(harness.holderProof.calls, 0, "no holder proof is read for a wallet that is not the writer's");

    // The same proof was never spent: it still authorizes one write.
    const original = await created((await postWithProof(harness, postInput(), proof)).response);
    assert.equal((await postWithProof(harness, postInput(), proof)).response.status, 401, "now it is spent");

    // A revision cannot move a post to another launch or kind, nor be written by another author.
    for (const overrides of [
      { launchId: LAUNCH_B, revisionOf: original.id },
      { kind: "creator_update", launchId: LAUNCH_B, stance: null, revisionOf: original.id },
      { revisionOf: "00000000-0000-4000-8000-0000000fffff" },
    ]) {
      const moved = await postWithProof(harness, postInput(overrides));
      assert.equal(moved.response.status, 403, JSON.stringify(overrides));
    }
    assert.equal((await postWithPrivy(harness, postInput({ revisionOf: original.id }))).status, 403, "another author");
    assert.equal(await storedRecords(harness), 1);
    assert.deepEqual((await audit(harness, original.thesisId))?.records.map((record) => record.launchId), [LAUNCH_A]);

    // The database refuses a revision on another launch even if a caller skipped the guard.
    await assert.rejects(
      harness.web.query(
        `INSERT INTO mission_control_launchpad_theses (record_id, thesis_id, revision_of, launch_id, kind, stance,
           author_identity_id, body, evidence_links, verification, network, deployment_fingerprint,
           launch_checkpoint, thesis_created_at)
         SELECT gen_random_uuid(), thesis_id, record_id, $1, kind, stance, author_identity_id, body, evidence_links,
           verification, network, deployment_fingerprint, launch_checkpoint, thesis_created_at
         FROM mission_control_launchpad_theses WHERE record_id = $2`,
        [LAUNCH_B, original.id],
      ),
      { code: "23503" },
    );
  });
});

test("writes wait for the chain views: no checkpoint or another deployment is 503, and nothing is stored", { skip }, async () => {
  await withHarness(async (harness) => {
    await harness.admin.query("UPDATE watermarks SET reader_lo = checkpoint_hi_inclusive + 1");
    const unindexed = await postWithPrivy(harness, postInput());
    assert.equal(unindexed.status, 503);
    assert.equal(await errorCode(unindexed), "LAUNCHPAD_UNAVAILABLE");

    await harness.admin.query("UPDATE watermarks SET reader_lo = 0");
    await harness.admin.query(`UPDATE deployment_identity SET deployment_fingerprint = '${"e".repeat(64)}'`);
    const otherDeployment = await postWithPrivy(harness, postInput());
    assert.equal(otherDeployment.status, 503);
    assert.equal(await storedRecords(harness), 0);
  });
});

test("the launch's creator writes creator theses and updates; a revision keeps its stored kind", { skip }, async () => {
  await withHarness(async (harness) => {
    const thesis = await created(await postWithPrivy(harness, postInput({ kind: "creator_thesis" })));
    const update = await created(await postWithPrivy(harness, postInput({ kind: "creator_update", stance: null, body: "Plan published" })));
    const onBeta = await created((await postWithProof(harness, postInput({ launchId: LAUNCH_B, kind: "creator_update", stance: null }))).response);
    const revised = await created(await postWithPrivy(harness, postInput({
      kind: "creator_update", stance: null, body: "Plan revised", revisionOf: update.id,
    })));
    assert.equal(revised.thesisId, update.thesisId);
    const community = await created(await postWithPrivy(harness, postInput()));
    // A revision keeps its post's stored kind, whatever kind it asks for.
    const switched = await created(await postWithPrivy(harness, postInput({ kind: "creator_thesis", body: "Still community", revisionOf: community.id })));
    assert.equal(switched.kind, "community_thesis");
    const kept = await created(await postWithPrivy(harness, postInput({ kind: "community_thesis", body: "Plan final", revisionOf: revised.id })));
    assert.equal(kept.kind, "creator_update");

    const page = await listPage(harness, LAUNCH_A, {});
    assert.deepEqual(page.theses.map((post) => [post.kind, post.stance, post.authorLabels, post.body]), [
      ["community_thesis", "bullish", [], "Still community"],
      ["creator_update", "bullish", ["creator"], "Plan final"],
      ["creator_thesis", "bullish", ["creator"], "The curve fills steadily and the creator answers questions."],
    ]);
    assert.equal(page.theses[2].id, thesis.id);
    assert.equal(onBeta.authorIdentityId === thesis.authorIdentityId, false);
  });
});

test("a launch's public posts page newest first with a stable cursor through new posts and revisions", { skip }, async () => {
  await withHarness(async (harness) => {
    const posted: string[] = [];
    for (let index = 1; index <= 5; index += 1) {
      const input = postInput({ body: `Thesis number ${index}` });
      const response = index % 2 === 0 ? (await postWithProof(harness, input)).response : await postWithPrivy(harness, input);
      posted.push((await created(response)).thesisId);
    }
    await created(await postWithPrivy(harness, postInput({ launchId: LAUNCH_B, body: "Another launch" })));

    const all = await listPage(harness, LAUNCH_A, { limit: "50" });
    assert.deepEqual(all.theses.map((post) => post.body), [5, 4, 3, 2, 1].map((n) => `Thesis number ${n}`));
    assert.equal(all.nextCursor, null);
    assert.equal(all.launchId, LAUNCH_A);
    assert.deepEqual(Object.keys(all.theses[0]).sort(), [
      "authorIdentityId", "authorLabels", "body", "createdAt", "disclosure", "evidenceLinks", "id", "kind", "launchId",
      "moderationState", "postedAt", "provenance", "revisionOf", "stance", "thesisId",
    ], "spec §6.9 fields; no author identity, subject key or moderation time");

    const first = await listPage(harness, LAUNCH_A, { limit: "2" });
    assert.deepEqual(first.theses.map((post) => post.thesisId), [posted[4], posted[3]]);
    assert.ok(first.nextCursor);

    // A new post and a revision of an unread post change nothing for the next pages.
    await created(await postWithPrivy(harness, postInput({ body: "Thesis number 6" })));
    const third = (await audit(harness, posted[2]))?.records[0];
    assert.equal(third?.author.method, "privy");
    const revised = await created(await postWithPrivy(harness, postInput({ body: "Thesis number 3, revised", revisionOf: third?.id })));
    assert.equal(revised.thesisId, posted[2]);

    const second = await listPage(harness, LAUNCH_A, { limit: "2", cursor: first.nextCursor });
    assert.deepEqual(second.theses.map((post) => [post.thesisId, post.body]), [
      [posted[2], "Thesis number 3, revised"],
      [posted[1], "Thesis number 2"],
    ]);
    assert.equal(second.theses[0].revisionOf, third?.id);
    assert.equal(second.theses[0].postedAt, third?.postedAt, "a revision keeps its post's place");
    const last = await listPage(harness, LAUNCH_A, { limit: "2", cursor: second.nextCursor });
    assert.deepEqual(last.theses.map((post) => post.thesisId), [posted[0]]);
    assert.equal(last.nextCursor, null);

    // A token belongs to its launch's list; anything else is a CursorError before any read.
    for (const cursor of [first.nextCursor.replace(/.$/, "!"), "bm90LWEtdG9rZW4"]) {
      await assert.rejects(listLaunchTheses(LAUNCH_A, { cursor }, await chainJoin(harness)), CursorError);
    }
    await assert.rejects(listLaunchTheses("0xnope", {}, await chainJoin(harness)), CursorError);
    await assert.rejects(
      listLaunchTheses(LAUNCH_B, { cursor: first.nextCursor }, await chainJoin(harness)),
      CursorError,
      "another launch's token",
    );
    assert.deepEqual((await listPage(harness, FOREIGN, {})).theses, [], "a foreign launch has no posts");
  });
});

test("hidden records leave the public list and search while their audit identity remains", { skip }, async () => {
  await withHarness(async (harness) => {
    const x = await created(await postWithPrivy(harness, postInput({ body: "Graduation looks near for Alpha." })));
    const y = await created((await postWithProof(harness, postInput({ body: "Graduation looks near for Alpha." }))).response);
    const z = await created(await postWithPrivy(harness, postInput({ launchId: LAUNCH_B, body: "Beta whales are selling" })));

    // Duplicate text matches deterministically: newest first, then record ID.
    const hits = await search(harness, "GRADUATION alp");
    assert.deepEqual(hits.map((hit) => hit.thesis.id), [y.id, x.id]);
    assert.deepEqual(hits[0].launch, {
      launchId: LAUNCH_A, coinType: COIN_A, name: "Alpha", symbol: "ALPHA", iconUrl: "https://i/a.png",
      lifecycle: "live", creator: SYNTHETIC_SUI_ADDRESS, createdAtMs: 1790000000001,
    }, "launch identity, lifecycle and creator joined from the chain views; no price or balance");
    assert.deepEqual((await search(harness, "beta")).map((hit) => [hit.thesis.id, hit.launch.symbol]), [[z.id, "BETA"]]);
    assert.deepEqual(await search(harness, "nothing-like-this"), []);
    for (const query of ["", "   ", "!!! ???", "x".repeat(201)]) {
      await assert.rejects(searchTheses(query, {}, await chainJoin(harness)), SocialQueryError, JSON.stringify(query));
    }

    const hidden = await setThesisVisibility(harness.web, {
      recordId: x.id, visibility: "hidden", reason: "spam", moderator: "operator:7",
    });
    assert.equal(hidden?.moderationState, "hidden");
    assert.deepEqual((await listPage(harness, LAUNCH_A, {})).theses.map((post) => post.id), [y.id]);
    assert.deepEqual((await search(harness, "graduation")).map((hit) => hit.thesis.id), [y.id]);
    const trail = await audit(harness, x.thesisId);
    assert.equal(trail?.records.length, 1);
    assert.equal(trail?.records[0].body, "Graduation looks near for Alpha.", "the record itself is unchanged");
    assert.equal(trail?.records[0].moderationState, "hidden");
    assert.ok(trail?.records[0].moderationChangedAt);
    assert.deepEqual(trail?.moderation.map(({ recordId, visibility, reason, moderator }) => ({ recordId, visibility, reason, moderator })), [
      { recordId: x.id, visibility: "hidden", reason: "spam", moderator: "operator:7" },
    ]);

    // A hidden record cannot be revised back into view by its author.
    assert.equal((await postWithPrivy(harness, postInput({ body: "Same thing again", revisionOf: x.id }))).status, 403);

    // Restoring it brings it back to both; a repeated change records nothing new.
    await setThesisVisibility(harness.web, { recordId: x.id, visibility: "public", reason: "appeal", moderator: "operator:7" });
    await setThesisVisibility(harness.web, { recordId: x.id, visibility: "public", reason: "appeal", moderator: "operator:7" });
    assert.equal((await audit(harness, x.thesisId))?.moderation.length, 2);
    assert.deepEqual((await search(harness, "graduation")).map((hit) => hit.thesis.id), [y.id, x.id]);
    assert.equal(await setThesisVisibility(harness.web, {
      recordId: "00000000-0000-4000-8000-0000000fffff", visibility: "hidden", reason: "spam", moderator: "operator:7",
    }), null);
    await assert.rejects(setThesisVisibility(harness.web, {
      recordId: x.id, visibility: "hidden", reason: "Not A Reason!", moderator: "operator:7",
    }), TypeError);

    // A revision replaces its record's search row; the old text no longer matches.
    await created((await postWithProof(harness, postInput({ body: "Changed my mind: distribution", revisionOf: y.id }))).response);
    assert.deepEqual((await search(harness, "graduation")).map((hit) => hit.thesis.id), [x.id]);
    assert.equal((await search(harness, "distribution"))[0]?.thesis.thesisId, y.thesisId);

    // Social rows never make a launch: once blast-infra no longer lists B's curve
    // (a replay), B has no posts and no search hits, but its records stay.
    await harness.admin.query("DELETE FROM pools WHERE pool_key = $1", [`blast_curve:${LAUNCH_B}`]);
    assert.deepEqual(await search(harness, "beta"), []);
    assert.deepEqual((await listPage(harness, LAUNCH_B, {})).theses, []);
    assert.equal((await audit(harness, z.thesisId))?.records.length, 1);

    // A record hidden and restored while its launch is absent matches again once the launch is back.
    await setThesisVisibility(harness.web, { recordId: z.id, visibility: "hidden", reason: "spam", moderator: "operator:7" });
    await setThesisVisibility(harness.web, { recordId: z.id, visibility: "public", reason: "appeal", moderator: "operator:7" });
    await harness.admin.query(
      `INSERT INTO pools (pool_key, venue, coin_type, quote_type, lifecycle, created_checkpoint, created_at_ms)
       VALUES ($1, 'blast_curve', $2, '0x2::sui::SUI', 'live', 902, 1790000000002)`,
      [`blast_curve:${LAUNCH_B}`, COIN_B],
    );
    assert.deepEqual((await search(harness, "beta")).map((hit) => hit.thesis.id), [z.id]);
    assert.deepEqual((await listPage(harness, LAUNCH_B, {})).theses.map((post) => post.id), [z.id]);
  });
});

test("a disclosed wallet is verified at a snapshot checkpoint and time, or unavailable, and never blocks the write", { skip }, async () => {
  await withHarness(async (harness) => {
    const disclosed = { text: "My embedded wallet.", walletAddress: SYNTHETIC_SUI_ADDRESS };
    async function disclosureOf(answer: HolderProof | Error, holderProof: HolderProofPort | null = harness.holderProof) {
      harness.holderProof.answer = answer;
      const post = await created(await postWithPrivy(harness, postInput({ disclosure: disclosed }), holderProof));
      const stored = (await audit(harness, post.thesisId))?.records[0].disclosure;
      assert.deepEqual(post.disclosure, stored, "the public post carries the stored disclosure");
      return stored;
    }
    const observedAtMs = Date.UTC(2026, 9, 1, 12, 0, 1, 250);
    assert.deepEqual(await disclosureOf({ verification: "verified_holder", checkpoint: 326_274_001, observedAtMs, coinType: COIN_A }), {
      ...disclosed, verification: "verified_holder", observedCheckpoint: "326274001", observedAt: "2026-10-01T12:00:01.250Z",
    });
    assert.deepEqual(await disclosureOf({ verification: "not_holder", checkpoint: 326_274_002, observedAtMs, coinType: COIN_A }), {
      ...disclosed, verification: "not_holder", observedCheckpoint: "326274002", observedAt: "2026-10-01T12:00:01.250Z",
    });
    const unavailable = { ...disclosed, verification: "unavailable", observedCheckpoint: null, observedAt: null };
    assert.deepEqual(await disclosureOf({ verification: "unavailable" }), unavailable);
    assert.deepEqual(await disclosureOf(new Error("blast-infra down")), unavailable);
    // A proof about another coin proves nothing about this launch.
    assert.deepEqual(await disclosureOf({ verification: "verified_holder", checkpoint: 3, observedAtMs, coinType: COIN_B }), unavailable);
    // Without a configured proof a disclosed wallet is unavailable.
    assert.deepEqual(await disclosureOf({ verification: "verified_holder", checkpoint: 3, observedAtMs, coinType: COIN_A }, null), unavailable);
    assert.equal(harness.holderProof.calls, 5);

    // A Privy user without a Sui wallet has none to disclose; nothing is read.
    harness.privyWallet = false;
    const walletless = await postWithPrivy(harness, postInput({ disclosure: disclosed }));
    assert.equal(walletless.status, 403);
    assert.equal(harness.holderProof.calls, 5);
    const plain = await created(await postWithPrivy(harness, postInput()));
    assert.deepEqual((await audit(harness, plain.thesisId))?.records[0].authorLabels, []);
  });
});

test("a body whose compatibility form expands many times is stored, searchable and bounded", { skip }, async () => {
  await withHarness(async (harness) => {
    const arabic = await created(await postWithPrivy(harness, postInput({ body: "\uFDFA".repeat(1_000) })));
    // One 700-ligature word expands to 2,100 characters: stored, though PostgreSQL indexes no word over
    // 2 KB. Spaced ligature words stay searchable.
    await created(await postWithPrivy(harness, postInput({ body: "\uFB03".repeat(700) })));
    const ligatures = await created(await postWithPrivy(harness, postInput({ body: "e\uFB03cient \uFB04ow ".repeat(70).trim() })));
    assert.equal((await search(harness, "عليه"))[0]?.thesis.id, arabic.id);
    assert.equal((await search(harness, "efficient fflow"))[0]?.thesis.id, ligatures.id);
    const lengths = await harness.admin.query<{ length: number }>(
      "SELECT char_length(search_text) AS length FROM mission_control_launchpad_search_documents ORDER BY 1",
    );
    assert.deepEqual(lengths.rows.map((row) => row.length <= 4_000), [true, true, true]);
  });
});

test("a Mission Control reset keeps the launchpad's authors, posts, moderation and search rows", { skip }, async () => {
  await withHarness(async (harness) => {
    const kept = await created(await postWithPrivy(harness, postInput({ body: "Durable audit identity" })));
    const hidden = await created(await postWithPrivy(harness, postInput({ body: "Hidden but kept" })));
    await setThesisVisibility(harness.web, { recordId: hidden.id, visibility: "hidden", reason: "spam", moderator: "operator:7" });

    await resetDatabase(harness.admin);

    assert.equal((await search(harness, "durable"))[0]?.thesis.id, kept.id);
    assert.equal((await audit(harness, hidden.thesisId))?.moderation.length, 1);
    const again = await created(await postWithPrivy(harness, postInput({ body: "After the reset" })));
    assert.equal(again.authorIdentityId, kept.authorIdentityId, "the author keeps their identity");
  });
});

test("a revision of a superseded record conflicts, and of two concurrent revisions exactly one is written", { skip }, async () => {
  await withHarness(async (harness) => {
    const original = await created(await postWithPrivy(harness, postInput({ body: "First take" })));
    const racing = await Promise.all([1, 2].map((n) =>
      postWithPrivy(harness, postInput({ body: `Second take ${n}`, revisionOf: original.id }))));
    assert.deepEqual(racing.map((response) => response.status).sort(), [201, 409]);
    const stale = await postWithPrivy(harness, postInput({ body: "Third take", revisionOf: original.id }));
    assert.equal(stale.status, 409);
    assert.equal(await errorCode(stale), "LAUNCHPAD_CONFLICT");
    const versions = (await audit(harness, original.thesisId))?.records ?? [];
    assert.equal(versions.length, 2);
    assert.deepEqual((await listPage(harness, LAUNCH_A, {})).theses.map((post) => post.id), [versions[1].id]);
  });
});

test("a creator kind from a writer not verified as the launch's creator is stored as a community thesis", { skip }, async () => {
  await withHarness(async (harness) => {
    // Beta's creator is the Slush wallet, not the Privy user's; Alpha's is the Privy user's, not the Slush wallet.
    const privy = await created(await postWithPrivy(harness, postInput({ launchId: LAUNCH_B, kind: "creator_thesis", stance: "bearish" })));
    const proven = await created((await postWithProof(harness, postInput({ kind: "creator_update", stance: "neutral" }))).response);
    for (const post of [privy, proven]) {
      assert.equal(post.kind, "community_thesis");
      assert.deepEqual(post.authorLabels, [], "no Creator label");
    }
    assert.equal((await audit(harness, proven.thesisId))?.records[0].kind, "community_thesis");

    // Without a stance a downgraded request is refused, with that reason, for either credential.
    const stanceless = await postWithPrivy(harness, postInput({ launchId: LAUNCH_B, kind: "creator_update", stance: null }));
    assert.equal(stanceless.status, 400);
    assert.equal(await errorCode(stanceless), "LAUNCHPAD_STANCE_REQUIRED");
    const { response, proof } = await postWithProof(harness, postInput({ kind: "creator_update", stance: null }));
    assert.equal(response.status, 400);
    assert.equal(await errorCode(response), "LAUNCHPAD_STANCE_REQUIRED");
    await created((await postWithProof(harness, postInput(), proof)).response);

    // A revision of a downgraded post stays a community thesis.
    const revised = await created(await postWithPrivy(harness, postInput({
      launchId: LAUNCH_B, kind: "creator_thesis", stance: "neutral", body: "Revised", revisionOf: privy.id,
    })));
    assert.equal(revised.kind, "community_thesis");
    assert.equal(revised.thesisId, privy.thesisId);
  });
});

/**
 * A replica that lags behind the primary: every read runs in one repeatable-read
 * snapshot taken now, as the replica role, so later primary writes stay invisible to it.
 */
async function laggingReplica(harness: Harness): Promise<{ database: ReadableDatabase; release: () => Promise<void> }> {
  const client = await harness.replica.connect();
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SELECT count(*) FROM mission_control_launchpad_theses");
  return {
    database: { read: (text, values) => client.query(text, values as unknown[]) } as ReadableDatabase,
    release: async () => {
      await client.query("ROLLBACK");
      client.release();
    },
  };
}

test("a hidden record leaves the list and search at once, while the replica still holds it as public", { skip }, async () => {
  await withHarness(async (harness) => {
    const x = await created(await postWithPrivy(harness, postInput({ body: "Graduation looks near for Alpha." })));
    const y = await created((await postWithProof(harness, postInput({ body: "Graduation looks near too." }))).response);
    const join = await chainJoin(harness);
    const lagging = await laggingReplica(harness);
    try {
      await setThesisVisibility(harness.web, { recordId: x.id, visibility: "hidden", reason: "spam", moderator: "operator:7" });
      const stale = await lagging.database.read<{ visibility: string }>(
        "SELECT visibility FROM mission_control_launchpad_theses WHERE record_id = $1", [x.id],
      );
      assert.equal(stale.rows[0]?.visibility, "public", "the replica has not seen the hide yet");

      const behind = { ...join, replica: lagging.database };
      const list = await listLaunchTheses(LAUNCH_A, {}, behind);
      assert.ok("data" in list);
      assert.equal(list.provenance.source, "replica", "chain identity still comes from the replica views");
      assert.deepEqual(list.data.theses.map((post) => post.id), [y.id]);
      const hits = await searchTheses("graduation", {}, behind);
      assert.ok("data" in hits);
      assert.deepEqual(hits.data.theses.map((hit) => hit.thesis.id), [y.id]);
      assert.equal(hits.data.theses[0].launch.symbol, "ALPHA");
    } finally {
      await lagging.release();
    }
    assert.equal((await audit(harness, x.thesisId))?.records[0].moderationState, "hidden", "its audit identity remains");
  });
});

test("search skips posts of launches the views no longer list, a bounded batch at a time, without losing a hit", { skip }, async () => {
  await withHarness(async (harness) => {
    const alpha = await created(await postWithPrivy(harness, postInput({ body: "Kiwi season on Alpha" })));
    const beta: string[] = [];
    for (let index = 0; index < 16; index += 1) {
      beta.push((await created(await postWithPrivy(harness, postInput({ launchId: LAUNCH_B, body: `Kiwi take ${index}` })))).id);
    }
    const newest = await created(await postWithPrivy(harness, postInput({ body: "Kiwi again on Alpha" })));
    // A replay: blast-infra no longer lists Beta's curve, so its sixteen posts between Alpha's two are skipped.
    await harness.admin.query("DELETE FROM pools WHERE pool_key = $1", [`blast_curve:${LAUNCH_B}`]);

    const pages: string[][] = [];
    let cursor: string | null = null;
    do {
      const answer = await searchTheses("kiwi", { limit: "1", cursor }, await chainJoin(harness));
      assert.ok("data" in answer);
      pages.push(answer.data.theses.map((hit) => hit.thesis.id));
      for (const hit of answer.data.theses) assert.equal(hit.launch.launchId, LAUNCH_A);
      cursor = answer.data.nextCursor;
    } while (cursor && pages.length < 10);
    // A page with a hit reads at most four batches of two posts (the first stops after seven of Beta's); one without
    // a hit yet reads on (up to sixteen batches), so the second page reaches Alpha's older post. Its batch was full,
    // so it keeps a token, and the last page reads nothing more.
    assert.deepEqual(pages, [[newest.id], [alpha.id], []], "every canonical hit once, in order");
    assert.equal(beta.length, 16);
  });
});

test("the list route serves stored posts, both credentials' and every disclosure, exactly as the browser parses them", { skip }, async () => {
  await withHarness(async (harness) => {
    harness.holderProof.answer = { verification: "verified_holder", checkpoint: 901, observedAtMs: 1_790_000_000_500, coinType: COIN_A };
    const privy = await created(await postWithPrivy(harness, postInput({
      kind: "creator_thesis", disclosure: { text: "Creator allocation.", walletAddress: SYNTHETIC_SUI_ADDRESS },
    })));
    const proven = await created((await postWithProof(harness, postInput({ evidenceLinks: [], stance: "bearish" }))).response);
    const join = await chainJoin(harness);
    const list = (query: string) => handleThesisListRequest(
      new Request(`${ORIGIN}/api/launchpad/theses${query}`),
      databaseThesisSource(join),
    );
    const response = await list(`?launchId=${LAUNCH_A}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const body = await response.json();
    const parsed = parseThesisListResponse(body, LAUNCH_A);
    assert.equal(parsed.theses.state, "available");
    assert.ok(parsed.theses.state === "available");
    assert.deepEqual(parsed.theses.data.items.map((post) => post.id), [proven.id, privy.id]);
    assert.deepEqual(parsed.theses.data.items[1].authorLabels, ["creator", "wallet"]);
    assert.deepEqual(parsed.theses.data.items[1].disclosure, {
      text: "Creator allocation.", walletAddress: SYNTHETIC_SUI_ADDRESS, verification: "verified_holder",
      observedCheckpoint: "901", observedAt: "2026-09-21T14:13:20.500Z",
    });
    assert.deepEqual(parsed, body, "the parser keeps the served answer as served");

    // A launch the views do not list has no posts; a malformed launch ID is refused before any read.
    const foreign = await (await list(`?launchId=${FOREIGN}`)).json();
    assert.deepEqual(foreign.theses.state, "empty");
    assert.equal((await list("?launchId=0xA1")).status, 400);
  });
});

test("the largest valid list token reads from the newest post; forged values are 400 before any read", { skip }, async () => {
  await withHarness(async (harness) => {
    const older = await created(await postWithPrivy(harness, postInput({ body: "First" })));
    const newer = await created(await postWithPrivy(harness, postInput({ body: "Second" })));
    const join = await chainJoin(harness);
    const list = (cursor: string) => handleThesisListRequest(
      new Request(`${ORIGIN}/api/launchpad/theses?launchId=${LAUNCH_A}&cursor=${encodeURIComponent(cursor)}`),
      databaseThesisSource(join),
    );
    const shape = thesesCursor(LAUNCH_A);
    const edge = await list(encodeCursor(shape, ["9223372036854775807"], [newer.thesisId]));
    assert.equal(edge.status, 200, "the bigint maximum is a valid position, never a database error");
    assert.deepEqual((await edge.json()).theses.data.items.map((post: { id: string }) => post.id), [newer.id, older.id]);
    for (const [key, tie] of [["9223372036854775808", newer.thesisId], ["1".repeat(30), newer.thesisId], ["1", "not-a-uuid"]]) {
      const refused = await list(encodeCursor(shape, [key], [tie]));
      assert.equal(refused.status, 400, `${key} ${tie}`);
    }
  });
});

test("a retry with the same Idempotency-Key answers with the first post and writes nothing more", { skip }, async () => {
  await withHarness(async (harness) => {
    const key = "4f1c2a9e-7b3d-4e6f-9a01-23456789abcd";
    const first = await created(await postWithPrivy(harness, postInput(), undefined, key));
    const retry = await created(await postWithPrivy(harness, postInput(), undefined, key));
    assert.equal(retry.id, first.id, "the retry is answered with the stored post");
    assert.match(first.id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "a version 8 UUID from the key");
    assert.equal((await audit(harness, first.thesisId))?.records.length, 1);
    const other = await created(await postWithPrivy(harness, postInput(), undefined, "a-different-key-0123456789"));
    assert.notEqual(other.id, first.id, "another key is another post");
    // A retry key for another launch never answers with this launch's post.
    const elsewhere = await created(await postWithPrivy(harness, postInput({ launchId: LAUNCH_B }), undefined, key));
    assert.notEqual(elsewhere.id, first.id);
    // The same key with other text is refused, never answered with the old post.
    const changed = await postWithPrivy(harness, postInput({ body: "Other text under an old retry key." }), undefined, key);
    assert.equal(changed.status, 409);
    const malformed = await postWithPrivy(harness, postInput(), undefined, "short");
    assert.equal(malformed.status, 400);
  });
});
