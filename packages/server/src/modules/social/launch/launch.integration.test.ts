import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { defineBlastDeployment, launchpadDeployment } from "@interest-protocol/blast-sdk/deployments";
import { encodeCreatorClaimMessage, type LaunchState } from "@interest-protocol/blast-sdk/launchpad";
import { bcs } from "@mysten/sui/bcs";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { Ed25519Keypair, Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import { buildMemePackageBytecode } from "@interest-protocol/blast-sdk/launchpad/template";
import { Transaction } from "@mysten/sui/transactions";
import { fromHex, toBase64, toHex } from "@mysten/sui/utils";
import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { CREATE_SUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { CREATOR_CAPS_PATH, type CreatorCapsClaim, type CreatorCapsEligibility } from "@blast/core/modules/social/contracts/creator-claims.ts";
import type { LaunchDraftResponse, LaunchPublishPlan } from "@blast/core/modules/social/contracts/launch.ts";
import { blankLaunchDraft, LAUNCH_DEAD_ADDRESS, type LaunchDraft, type LaunchRules } from "@blast/core/modules/social/launch/model.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createCreatorClaimRoutes } from "@blast/server/modules/social/creator-claims/route.ts";
import { creatorClaimSigner } from "@blast/server/modules/social/creator-claims/signer.ts";
import { creatorXLookup } from "@blast/server/modules/social/launch/creator-x.ts";
import { readPublishedLaunch, type ReadPublishedLaunch } from "@blast/server/modules/social/launch/reconcile.ts";
import { creatorCommitmentOf } from "@blast/server/modules/social/creator-claims/commitment.ts";
import type { CreateLogoStore } from "@blast/server/modules/social/create/route.ts";
import type { MemeTemplate } from "@blast/server/modules/social/launch/meme-template.ts";
import { createSocialLaunchRoutes, type SocialLaunchRoutesDependencies } from "@blast/server/modules/social/launch/route.ts";
import { readLaunchDetails } from "@blast/server/modules/social/launch/details.ts";
import { migrationManifest } from "../../../../../core/test/fixtures/modules/launch-migration/fixtures.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { uuid } from "../../../../../core/test/kit.ts";

/**
 * `/launch`'s draft routes over migration 0148 as the web runtime role
 * `blast_web`, with a real Privy token verifier and the Postgres rate
 * limiter. Publishing builds every step with the SDK's meme template and
 * a fixture deployment that includes both venues. No transactions are broadcast.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-launch-app";
const NOW = Math.floor(Date.now() / 1_000);
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const verificationKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
const POOL_SETTINGS = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 8, statementTimeoutMs: 5_000 };
const DEPLOYMENT = defineBlastDeployment(migrationManifest());

const wallet = (tag: string) => `0x${tag.padStart(64, "0")}`;
const KAI = { id: uuid(0xc1), did: "did:privy:launch-kai", callsign: "launch_kai", wallet: wallet("c1") };
const MIRA = { id: uuid(0xc2), did: "did:privy:launch-mira", callsign: "launch_mira", wallet: wallet("c2") };
const COIN = `${wallet("abc")}::pip::PIP`;
const OBJECT = (tag: string) => wallet(tag);
const DIGEST = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const SEALED_TREASURY_CAP = { object_id: OBJECT("7b"), version: "12", digest: DIGEST };

/** The mainnet rules as read on 2026-10-29. */
const RULES: LaunchRules = {
  meme_decimals: [6, 9],
  quote_fee_bps: 100,
  meme_fee_bps: 50,
  protocol_meme_bps: 250,
  protocol_quote_bps: 150,
  creation_fee: "0",
  protocol_fee_share_bps: 6_500,
  pool_fee_meme_bps: 5_000,
  pool_fee_quote_bps: 1_500,
  quotes: [CREATE_SUI_QUOTE_TYPE],
  cetus_tiers: { [CREATE_SUI_QUOTE_TYPE]: [[200, 10_000]] },
  bluefin_options: { status: "ready", min_tick: -443_636, max_tick: 443_636 },
};

/** The SDK's template, in the test's own thread. */
const TEMPLATE: MemeTemplate = {
  async bytecode(input) {
    return toBase64(await buildMemePackageBytecode({ ...input, sellBurnBps: BigInt(input.sellBurnBps), creatorRecipient: { kind: "account", accountCommitment: fromHex(input.accountCommitment) } }, { originalPackageId: input.launchpadOriginalPackageId, core: { originalPackageId: input.coreOriginalPackageId } }));
  },
};

function token(did: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: NOW + 3_600, iat: NOW - 60, iss: "privy.io", sid: "s-1", sub: did });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

const path = (id = "", tail = "") => `${ORIGIN}/api/social/me/launches${id ? `/${id}` : ""}${tail}`;

function request(did: string, url: string, init: RequestInit & { json?: unknown } = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token(did)}`);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return new Request(url, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

async function ok<T>(response: Response, status = 200): Promise<T> {
  const body: unknown = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return body as T;
}

async function refusal(response: Response, status: number, code: string): Promise<Record<string, unknown>> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error.code, code);
  return body.error;
}

type Routes = ReturnType<typeof createSocialLaunchRoutes>;
type Fixture = Readonly<{
  admin: Pool;
  database: () => ReadableDatabase;
  kit: ReturnType<typeof createSocialRouteKit>;
  routes: (overrides?: Partial<SocialLaunchRoutesDependencies>) => Routes;
  logos: Map<string, Buffer>;
  png: Buffer;
}>;

async function withDatabase(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const { url } = database;
  const admin = createPool(url, { max: 4 });
  const web = createRuntimePool(urlAs(url, "blast_web"), POOL_SETTINGS, "social-launch-test");
  try {
    for (const account of [KAI, MIRA]) {
      await admin.query(
        `INSERT INTO social_accounts (account_id, privy_did, callsign, onboarding_shown_at, onboarded_at, privacy, sharing_since)
         VALUES ($1, $2, $3, now(), now(), 'public', now())`,
        [account.id, account.did, account.callsign],
      );
      await admin.query("INSERT INTO social_account_wallets (address, account_id, kind, verified_at) VALUES ($1, $2, 'external', now())", [account.wallet, account.id]);
    }
    const { default: sharp } = await import("sharp");
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 255, g: 181, b: 71 } } }).png().toBuffer();
    const accounts = new PostgresSocialAccounts(() => web);
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey }),
      limiter: new PostgresRateLimitEnforcer({ pool: web, subjectPepper: "social-launch-fixture-pepper-0123456789" }),
      accounts,
      primary: () => web,
    });
    const logos = new Map<string, Buffer>();
    const logoStore: CreateLogoStore = {
      async write(pathname, bytes) {
        logos.set(pathname, bytes);
        return { url: `https://blob.example/${pathname}` };
      },
    };
    const readDatabase = () => autocommitReader(web, "social", { label: "social.launch-test" });
    const routes = (overrides: Partial<SocialLaunchRoutesDependencies> = {}) => createSocialLaunchRoutes({
      kit,
      rules: async () => RULES,
      deployment: () => DEPLOYMENT,
      canPublish: async () => true,
      logoStore: () => logoStore,
      coverStore: () => null,
      template: TEMPLATE,
      wallets: async (accountId) => (await accounts.wallets(accountId)).map((row) => row.address),
      commitment: (context, accountId) => context.transaction((social) => creatorCommitmentOf(social, accountId), { label: "test.commitment" }),
      readPublishedLaunch: async () => null,
      resolveCreatorX: async () => null,
      canAssignCreatorX: async () => false,
      launchMemeType: async (launchId) => (launchId === OBJECT("1a") ? COIN : null),
      // The chain builder is real; this fixture retains balance intents without making RPC calls.
      preparePublication: async (transaction) => ({ transaction: await transaction.toJSON({ supportedIntents: ["CoinWithBalance"] }), digest: DIGEST }),
      publicationStatus: async () => "pending",
      publicationCoin: async () => ({ coin_type: COIN, sealed_treasury_cap: SEALED_TREASURY_CAP, ticket: { object_id: OBJECT("7c"), version: "12", digest: DIGEST }, currency: { object_id: OBJECT("cc"), version: "12", digest: DIGEST } }),
      findBlockedTerm: async (text) => (text.toLowerCase().includes("rugpull") ? "rugpull" : null),
      database: readDatabase,
      ...overrides,
    });
    await run({ admin, database: readDatabase, kit, routes, logos, png });
  } finally {
    await web.end();
    await admin.end();
    await database.drop();
  }
}

const named = (change: Partial<LaunchDraft> = {}): LaunchDraft => ({ ...blankLaunchDraft(CREATE_SUI_QUOTE_TYPE), name: "Pip", symbol: "PIP", description: "The smallest seed on Sui.", first_buy: 100, ...change });

/** Creates Kai's draft with a logo; answers its id and version. */
async function finishedDraft(routes: Routes, png: Buffer, id: string, draft = named()): Promise<LaunchDraftResponse> {
  await ok<LaunchDraftResponse>(await routes.draft.PUT(request(KAI.did, path(id), { method: "PUT", json: { version: 0, draft } }), testClient()), 201);
  return ok<LaunchDraftResponse>(await routes.logo.PUT(request(KAI.did, path(id, "/logo"), { method: "PUT", body: Uint8Array.from(png), headers: { "content-type": "image/png" } }), testClient()));
}

const commands = (plan: LaunchPublishPlan) => Transaction.from(plan.steps[0].transaction).getData();

test("drafts save, resume and answer their issues against the deployed rules", { skip }, () =>
  withDatabase(async ({ admin, routes: make, logos, png }) => {
    const routes = make();
    const id = uuid(0x101);
    const created = await ok<LaunchDraftResponse>(await routes.draft.PUT(request(KAI.did, path(id), { method: "PUT", json: { version: 0, draft: blankLaunchDraft(CREATE_SUI_QUOTE_TYPE) } }), testClient()), 201);
    assert.equal(created.version, 1);
    assert.deepEqual(created.issues.map((issue) => issue.path), ["logo", "name", "symbol"]);
    assert.deepEqual(created.rules, RULES);

    const saved = await ok<LaunchDraftResponse>(await routes.draft.PUT(request(KAI.did, path(id), { method: "PUT", json: { version: 1, draft: named() } }), testClient()));
    assert.equal(saved.version, 2);
    // A stale version is a conflict carrying the stored draft; a retry of the same body is harmless.
    const conflict = await refusal(await routes.draft.PUT(request(KAI.did, path(id), { method: "PUT", json: { version: 1, draft: named({ name: "Other" }) } }), testClient()), 409, "draft_conflict");
    assert.equal((conflict.draft as LaunchDraftResponse).draft.name, "Pip");
    await ok(await routes.draft.PUT(request(KAI.did, path(id), { method: "PUT", json: { version: 1, draft: named() } }), testClient()));

    const logo = await ok<LaunchDraftResponse>(await routes.logo.PUT(request(KAI.did, path(id, "/logo"), { method: "PUT", body: Uint8Array.from(png), headers: { "content-type": "image/png" } }), testClient()));
    assert.match(logo.logo_url ?? "", /^https:\/\/blob\.example\/create-logos\//);
    assert.equal(logos.size, 1);
    assert.deepEqual(logo.issues, []);

    await admin.query("UPDATE social_launch_drafts SET body=body - 'pool_bps' WHERE draft_id=$1", [id]);
    const resumed = await ok<LaunchDraftResponse>(await routes.draft.GET(request(KAI.did, path(id)), testClient()));
    assert.equal(resumed.draft.pool_bps, 1_927);
    assert.deepEqual(resumed.issues, []);

    const list = await ok<{ drafts: { draft_id: string }[] }>(await routes.list.GET(request(KAI.did, path()), testClient()));
    assert.deepEqual(list.drafts.map((draft) => draft.draft_id), [id]);
    // Another account reaches none of it.
    await refusal(await routes.draft.GET(request(MIRA.did, path(id)), testClient()), 404, "not_found");
    assert.deepEqual((await ok<{ drafts: unknown[] }>(await routes.list.GET(request(MIRA.did, path()), testClient()))).drafts, []);
  }));

test("an unknown key or an out-of-bound value is refused before anything is stored", { skip }, () =>
  withDatabase(async ({ routes: make }) => {
    const routes = make();
    const id = uuid(0x102);
    const bad = await refusal(await routes.draft.PUT(request(KAI.did, path(id), { method: "PUT", json: { version: 0, draft: { ...named(), sell_burn_bps: 9_000 } } }), testClient()), 400, "invalid_request");
    assert.equal(bad.field, "sell_burn_bps");
    await refusal(await routes.draft.PUT(request(KAI.did, path(id), { method: "PUT", json: { version: 0, draft: { ...named(), opening_round: 1 } } }), testClient()), 400, "invalid_request");
    await refusal(await routes.draft.GET(request(KAI.did, path(id)), testClient()), 404, "not_found");
  }));

test("the existing deployment builds the coin, registration and launch with a 0xdead remainder", { skip }, () =>
  withDatabase(async ({ admin, routes: make, png }) => {
    const routes = make();
    const id = uuid(0x103);
    const draft = await finishedDraft(routes, png, id, named({ curve_bps: 5_000, pool_bps: 2_000, recipients: [{ label: "Treasury", address: MIRA.wallet, bps: 1_000 }] }));
    assert.deepEqual(draft.issues, []);

    // The creating wallet must be the account's own.
    await refusal(await routes.publish.POST(request(KAI.did, path(id, "/publish"), { method: "POST", json: { version: draft.version, step: "publish_coin", creator: MIRA.wallet } }), testClient()), 400, "invalid_request");

    const coin = await ok<LaunchPublishPlan>(await routes.publish.POST(request(KAI.did, path(id, "/publish"), { method: "POST", json: { version: draft.version, step: "publish_coin", creator: KAI.wallet } }), testClient()));
    assert.equal(coin.launchpad_original_package_id, launchpadDeployment(DEPLOYMENT).originalPackageId);
    const retried = await Promise.all([1, 2].map(() => routes.publish.POST(request(KAI.did, path(id, "/publish"), { method: "POST", json: { version: draft.version, step: "publish_coin", creator: KAI.wallet } }), testClient()).then((response) => ok<LaunchPublishPlan>(response))));
    assert.deepEqual(retried, [coin, coin]);
    assert.equal((await ok<LaunchDraftResponse>(await routes.draft.GET(request(KAI.did, path(id)), testClient()))).publishing, true);
    await refusal(await routes.draft.PUT(request(KAI.did, path(id), { method: "PUT", json: { version: draft.version, draft: named({ name: "Changed before signing" }) } }), testClient()), 409, "draft_published");
    const publish = commands(coin);
    assert.equal(publish.sender, KAI.wallet);
    assert.deepEqual(publish.commands.map((command) => command.$kind), ["Publish", "MoveCall"]);
    assert.equal(publish.commands[0]!.Publish!.dependencies.at(-1), launchpadDeployment(DEPLOYMENT).packageId);

    const registration = await ok<LaunchPublishPlan>(await routes.publish.POST(request(KAI.did, path(id, "/publish"), { method: "POST", json: {
      version: draft.version, step: "register_currency", creator: KAI.wallet,
      coin: { coin_type: COIN, currency: { object_id: OBJECT("cc"), version: "12", digest: DIGEST } },
    } }), testClient()));
    assert.match(JSON.stringify(commands(registration).commands), /coin_registry.*finalize_registration/);
    assert.equal((await admin.query("SELECT coin_type FROM social_launch_drafts WHERE draft_id = $1", [id])).rows[0].coin_type, COIN);

    // The coin exists now: the draft is frozen and never builds a second coin.
    await refusal(await routes.draft.PUT(request(KAI.did, path(id), { method: "PUT", json: { version: draft.version, draft: named({ name: "Changed" }) } }), testClient()), 409, "draft_published");
    const again = await ok<LaunchPublishPlan>(await routes.publish.POST(request(KAI.did, path(id, "/publish"), { method: "POST", json: { version: draft.version, step: "publish_coin", creator: KAI.wallet } }), testClient()));
    assert.deepEqual(again, coin);
    await refusal(await routes.publish.POST(request(KAI.did, path(id, "/publish"), { method: "POST", json: {
      version: draft.version, step: "create_launch", creator: KAI.wallet,
      coin: { coin_type: `${wallet("def")}::other::OTHER`, sealed_treasury_cap: SEALED_TREASURY_CAP, ticket: { object_id: OBJECT("7c"), version: "12", digest: DIGEST }, currency: { object_id: OBJECT("cc"), initial_shared_version: "13" } },
    } }), testClient()), 400, "invalid_request");

    const creation = await ok<LaunchPublishPlan>(await routes.publish.POST(request(KAI.did, path(id, "/publish"), { method: "POST", json: {
      version: draft.version, step: "create_launch", creator: KAI.wallet,
      coin: { coin_type: COIN, sealed_treasury_cap: SEALED_TREASURY_CAP, ticket: { object_id: OBJECT("7c"), version: "12", digest: DIGEST }, currency: { object_id: OBJECT("cc"), initial_shared_version: "13" } },
    } }), testClient()));
    const calls = commands(creation).commands.filter((command) => command.MoveCall).map((command) => `${command.MoveCall!.module}::${command.MoveCall!.function}`);
    for (const call of ["launch_config::venue_admission", "cetus::prepare", "launch::new", "launch::set_virtual_quote", "launch::set_graduation_target", "launch::set_allocation_plan", "launch::set_lp_fee_split", "launch::finalize", "launch::buy", "launch::share"]) {
      assert.ok(calls.includes(call), `${call} in ${calls.join(", ")}`);
    }
    const transaction = commands(creation);
    const allocationRecipients = transaction.commands.filter(command => command.MoveCall?.module === "payout" && command.MoveCall.function === "recipient");
    assert.equal(allocationRecipients.length, 2);
    const deadAddress = allocationRecipients.at(-1)!.MoveCall!.arguments[0]!;
    assert.equal(deadAddress.$kind, "Input");
    assert.equal(`0x${Buffer.from(transaction.inputs[deadAddress.Input!]!.Pure!.bytes, "base64").toString("hex")}`, LAUNCH_DEAD_ADDRESS);

    // A draft is absent from the public projection until its chain publication is confirmed.
    const detailsDb = autocommitReader(admin, "social", { label: "test.launch_details" });
    assert.equal(await readLaunchDetails(OBJECT("1a"),detailsDb),null);
    // Recording the launch checks it on chain: an unknown launch is not found; the real one is recorded once.
    await refusal(await routes.published.POST(request(KAI.did, path(id, "/published"), { method: "POST", json: { launch_id: OBJECT("1b") } }), testClient()), 404, "not_found");
    const published = await ok<LaunchDraftResponse>(await routes.published.POST(request(KAI.did, path(id, "/published"), { method: "POST", json: { launch_id: OBJECT("1a") } }), testClient()));
    assert.equal(published.published_launch_id, OBJECT("1a"));
    const details = await readLaunchDetails(OBJECT("1a"),detailsDb);
    assert.ok(details);
    assert.deepEqual(Object.keys(details).sort(),["cover","iconUrl","links","tagline"]);
    assert.equal(details.iconUrl, published.logo_url);
    const beforeLegacy = await readLaunchDetails(OBJECT("1a"), detailsDb);
    await admin.query("UPDATE social_launch_drafts SET body=body - 'pool_bps' WHERE draft_id=$1", [id]);
    assert.deepEqual(await readLaunchDetails(OBJECT("1a"), detailsDb), beforeLegacy);
    await admin.query("UPDATE social_launch_drafts SET body=$2::jsonb WHERE draft_id=$1",[id,JSON.stringify({private:"broken"})]);
    assert.equal(await readLaunchDetails(OBJECT("1a"),detailsDb),null);
    await admin.query("UPDATE social_launch_drafts SET body=$2::jsonb WHERE draft_id=$1",[id,JSON.stringify(draft.draft)]);
    await ok(await routes.published.POST(request(KAI.did, path(id, "/published"), { method: "POST", json: { launch_id: OBJECT("1a") } }), testClient()));
    await refusal(await routes.publish.POST(request(KAI.did, path(id, "/publish"), { method: "POST", json: { version: draft.version, step: "publish_coin", creator: KAI.wallet } }), testClient()), 409, "draft_published");
  }));

test("a published X assignment recovers after a closed tab and only the assigned X identity gets a claim", { skip }, () =>
  withDatabase(async ({ admin, database, kit, routes: make, png }) => {
    const id = uuid(0x10a);
    const subject = "18934567890123456789";
    const launchId = OBJECT("1a");
    const unrelatedId = OBJECT("1b");
    const createDigest = "11111111111111111111111111111111";
    let lookups = 0;
    let preparedCommitment: string | undefined;
    const resolveCreatorX = creatorXLookup("fixture-token", 1, async (url) => {
      lookups += 1;
      assert.equal(url, "https://api.x.com/2/users/by/username/mira");
      return Response.json({ data: { id: subject, username: "Mira" } });
    });
    const launchpad = launchpadDeployment(DEPLOYMENT).originalPackageId;
    const client = {
      core: {
        async getTransaction({ digest }: { digest: string }) {
          assert.equal(digest, createDigest);
          return { $kind: "Transaction", Transaction: {
            digest,
            effects: { status: { success: true }, changedObjects: [{
              idOperation: "Created", objectId: launchId,
              outputOwner: { $kind: "Shared", Shared: { initialSharedVersion: "21" } },
            }] },
            objectTypes: { [launchId]: `${launchpad}::launch::Launch<${COIN},${CREATE_SUI_QUOTE_TYPE}>` },
          } };
        },
      },
    } as unknown as ClientWithCoreApi;
    const readPublished: ReadPublishedLaunch = (step, signal) => readPublishedLaunch(client, step, signal);
    const routes = make({
      canAssignCreatorX: async () => true,
      resolveCreatorX,
      readPublishedLaunch: readPublished,
      template: {
        bytecode(input) {
          preparedCommitment = input.accountCommitment;
          return TEMPLATE.bytecode(input);
        },
      },
      preparePublication: async (tx) => ({
        transaction: await tx.toJSON({ supportedIntents: ["CoinWithBalance"] }),
        digest: tx.getData().commands[0]?.$kind === "Publish" ? DIGEST : createDigest,
      }),
    });
    const draft = await finishedDraft(routes, png, id, named({ creator_x_handle: "@Mira", x_handle: "PipCoin" }));
    assert.equal(draft.draft.creator_x_handle, "Mira");
    const publish = (step: string, coin?: unknown) => routes.publish.POST(request(KAI.did, path(id, "/publish"), {
      method: "POST", json: { version: draft.version, step, creator: KAI.wallet, ...(coin ? { coin } : {}) },
    }), testClient());
    const first = await ok<LaunchPublishPlan>(await publish("publish_coin"));
    assert.deepEqual(await ok(await publish("publish_coin")), first);
    assert.equal(lookups, 1);
    const { rows: [pinned] } = await admin.query("SELECT creator_x_subject, creator_x_commitment FROM social_launch_drafts WHERE draft_id = $1", [id]);
    assert.equal(pinned.creator_x_subject, subject);
    assert.equal(toHex(pinned.creator_x_commitment), preparedCommitment);
    await refusal(await routes.draft.PUT(request(KAI.did, path(id), { method: "PUT", json: {
      version: draft.version, draft: named({ creator_x_handle: "Kai" }),
    } }), testClient()), 409, "draft_published");
    await ok(await publish("create_launch", {
      coin_type: COIN, sealed_treasury_cap: SEALED_TREASURY_CAP,
      ticket: { object_id: OBJECT("7c"), version: "12", digest: DIGEST },
      currency: { object_id: OBJECT("cc"), initial_shared_version: "13" },
    }));
    const record = (objectId: string) => routes.published.POST(request(KAI.did, path(id, "/published"), {
      method: "POST", json: { launch_id: objectId },
    }), testClient());
    await refusal(await record(unrelatedId), 404, "not_found");
    assert.equal((await admin.query("SELECT published_launch_id FROM social_launch_drafts WHERE draft_id = $1", [id])).rows[0].published_launch_id, null);

    assert.equal(await readLaunchDetails(launchId, database()), null);
    const signer = creatorClaimSigner(Ed25519Keypair.generate());
    const built: string[] = [];
    const sponsored: string[] = [];
    const claims = createCreatorClaimRoutes({
      kit,
      database,
      readPublishedLaunch: readPublished,
      signer: () => signer,
      blastWallet: async (caller) => caller.kind === "privy" && caller.did === MIRA.did ? MIRA.wallet : KAI.wallet,
      linkedXSubject: async (did) => did === MIRA.did ? subject : "18123456789012345678",
      chain: async () => ({
        async launch(objectId) {
          return { objectId, memeType: COIN, creatorRecipient: {
            kind: "account", accountCommitment: pinned.creator_x_commitment,
          } } as LaunchState;
        },
        async signerPublicKeys() { return [toHex(signer.publicKey)]; },
        async kind({ claimant, attestation }) {
          built.push(claimant);
          assert.ok(attestation);
          const [expiry, signature] = bcs.tuple([bcs.u64(), bcs.vector(bcs.u8())]).parse(attestation);
          const message = encodeCreatorClaimMessage({
            memeType: COIN, accountCommitment: pinned.creator_x_commitment, claimant, expiryMs: BigInt(expiry),
          });
          assert.ok(await new Ed25519PublicKey(signer.publicKey).verify(message, Uint8Array.from(signature)));
          return Uint8Array.of(1);
        },
        async simulate() { return { status: "success" }; },
      }),
      async sponsor({ sender }) {
        sponsored.push(sender);
        return { reservation_id: "fixture", transaction_bytes: "AA==", sponsor_signature: "", expires_at_ms: Date.now() + 120_000, gas_budget: "5000000" };
      },
    });
    const eligibility = (did: string, objectId = launchId) => claims.eligibility(
      request(did, `${ORIGIN}${CREATOR_CAPS_PATH}?launch_id=${objectId}`), testClient());
    await refusal(await eligibility(KAI.did), 403, "not_creator_recipient");
    await refusal(await eligibility(MIRA.did, unrelatedId), 403, "not_creator_recipient");
    assert.deepEqual(await ok<CreatorCapsEligibility>(await eligibility(MIRA.did)), {
      launch_id: launchId, claimant: MIRA.wallet,
    });
    assert.equal(await readLaunchDetails(launchId, database()), null);
    assert.deepEqual(built, []);
    assert.deepEqual(sponsored, []);

    const claim = (did: string, objectId = launchId) => claims.caps(request(did, `${ORIGIN}${CREATOR_CAPS_PATH}`, {
      method: "POST", json: { launch_id: objectId },
    }), testClient());
    await refusal(await claim(KAI.did), 403, "not_creator_recipient");
    await refusal(await claim(MIRA.did, unrelatedId), 403, "not_creator_recipient");
    assert.deepEqual(built, []);
    assert.deepEqual(sponsored, []);
    const prepared = await ok<CreatorCapsClaim>(await claim(MIRA.did));
    assert.equal(prepared.claimant, MIRA.wallet);
    assert.deepEqual(sponsored, [MIRA.wallet]);
    assert.equal((await ok<LaunchDraftResponse>(await record(launchId))).published_launch_id, launchId);
    const publicDetails = await readLaunchDetails(launchId, database());
    assert.deepEqual(publicDetails?.creatorFeeAssignment, { provider: "x", handleAtAssignment: "Mira" });
    assert.deepEqual(publicDetails?.links, [{ label: "X", url: "https://x.com/PipCoin" }]);
    assert.doesNotMatch(JSON.stringify(publicDetails), new RegExp(subject));
    await refusal(await claim(KAI.did), 403, "not_creator_recipient");
    assert.deepEqual(built, [MIRA.wallet]);
    assert.deepEqual(sponsored, [MIRA.wallet]);
  }));

test("an unfinished draft, a blocked word or a missing deployment never builds a transaction", { skip }, () =>
  withDatabase(async ({ routes: make, png }) => {
    const routes = make();
    const unfinished = uuid(0x104);
    const draft = await ok<LaunchDraftResponse>(await routes.draft.PUT(request(KAI.did, path(unfinished), { method: "PUT", json: { version: 0, draft: named() } }), testClient()), 201);
    await refusal(await routes.publish.POST(request(KAI.did, path(unfinished, "/publish"), { method: "POST", json: { version: draft.version, step: "publish_coin", creator: KAI.wallet } }), testClient()), 422, "draft_incomplete");

    const blocked = uuid(0x105);
    const rug = await finishedDraft(routes, png, blocked, named({ description: "a rugpull" }));
    const error = await refusal(await routes.publish.POST(request(KAI.did, path(blocked, "/publish"), { method: "POST", json: { version: rug.version, step: "publish_coin", creator: KAI.wallet } }), testClient()), 422, "blocked_term");
    assert.equal(error.field, "description");

    const off = uuid(0x106);
    const ready = await finishedDraft(routes, png, off);
    const reasons = await refusal(await make({ deployment: () => null }).publish.POST(request(KAI.did, path(off, "/publish"), { method: "POST", json: { version: ready.version, step: "publish_coin", creator: KAI.wallet } }), testClient()), 409, "publish_unavailable");
    assert.deepEqual(reasons.reasons, ["launchpad_not_deployed"]);
  }));

test("overallocated supply is refused before any coin publication", { skip }, () =>
  withDatabase(async ({ routes: make, png }) => {
    let prepared = 0;
    const routes = make({ preparePublication: async () => { prepared++; throw new Error("Must not build an overallocated launch"); } });
    const id = uuid(0x107);
    const saved = await finishedDraft(routes, png, id, named({ curve_bps: 5_000, pool_bps: 2_000, recipients: [{ label: "Treasury", address: MIRA.wallet, bps: 3_000 }] }));
    assert.ok(saved.issues.some(issue => issue.path === "recipients"));
    await refusal(await routes.publish.POST(request(KAI.did, path(id, "/publish"), { method: "POST", json: { version: saved.version, step: "publish_coin", creator: KAI.wallet } }), testClient()), 422, "draft_incomplete");
    assert.equal(prepared, 0);
  }));

test("a fixed-supply legacy coin resumes after its publication without changing its pool share", { skip }, () =>
  withDatabase(async ({ admin, routes: make, png }) => {
    const routes = make();
    const id = uuid(0x108);
    const saved = await finishedDraft(routes, png, id, named({ burnable: false, first_buy: 0 }));
    await ok<LaunchPublishPlan>(await routes.publish.POST(request(KAI.did, path(id, "/publish"), { method: "POST", json: { version: saved.version, step: "publish_coin", creator: KAI.wallet } }), testClient()));
    await admin.query("UPDATE social_launch_drafts SET body=body - 'pool_bps' WHERE draft_id=$1", [id]);
    const resumed = await ok<LaunchDraftResponse>(await routes.draft.GET(request(KAI.did, path(id)), testClient()));
    assert.equal(resumed.draft.burnable, false);
    assert.equal(resumed.draft.pool_bps, 1_927);
    assert.deepEqual(resumed.issues, []);
    await ok<LaunchPublishPlan>(await routes.publish.POST(request(KAI.did, path(id, "/publish"), { method: "POST", json: {
      version: saved.version, step: "register_currency", creator: KAI.wallet,
      coin: { coin_type: COIN, currency: { object_id: OBJECT("cc"), version: "12", digest: DIGEST } },
    } }), testClient()));
    await ok<LaunchPublishPlan>(await routes.publish.POST(request(KAI.did, path(id, "/publish"), { method: "POST", json: {
      version: saved.version, step: "create_launch", creator: KAI.wallet,
      coin: { coin_type: COIN, sealed_treasury_cap: SEALED_TREASURY_CAP, ticket: { object_id: OBJECT("7c"), version: "12", digest: DIGEST }, currency: { object_id: OBJECT("cc"), initial_shared_version: "13" } },
    } }), testClient()));
  }));
