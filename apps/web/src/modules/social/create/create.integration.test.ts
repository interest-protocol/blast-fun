import { testClient } from "../../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../../packages/core/test/fixtures/modules/database/template.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { fromBase64, normalizeStructTag } from "@mysten/sui/utils";
import { Transaction } from "@mysten/sui/transactions";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { deserialize } from "@mysten/move-bytecode-template";
import { bcs } from "@mysten/sui/bcs";

import { presaleIdentityFixture } from "../../../../../../packages/core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { parsePresaleRuntimeIdentity } from "@blast/core/modules/presale/deployment/service.ts";
import type { PresaleRuntimeIdentity } from "@blast/core/modules/presale/deployment/contracts.ts";
import {
  CREATE_WAL_QUOTE_TYPE,
  CREATE_DEEP_QUOTE_TYPE,
  CREATE_HASHI_BTC_QUOTE_TYPE,
  CREATE_USDSUI_QUOTE_TYPE,
  CREATE_QUOTE_TYPE,
  CREATE_SUI_QUOTE_TYPE,
  CREATE_TEST_SUI_QUOTE_TYPE,
  type CreateAllowlistSummary,
  type CreateDraft,
  type CreateDraftPage,
  type CreateDraftResponse,
  type CreatePublishPlan,
} from "@blast/core/modules/social/contracts/create.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import { blankDraft, CREATE_DEFAULT_FEE_POLICY } from "@blast/core/modules/social/create/model.ts";
import { createCoinTemplateExecutor } from "@blast/server/modules/social/create/coin-template.ts";
import { createSocialCreateRoutes, type CreateLogoStore, type SocialCreateRoutesDependencies } from "@blast/server/modules/social/create/route.ts";
import { readSuiQuotePrice } from "@blast/server/modules/social/create/quote-price.ts";
import { coinKindProof, prepareWalletCoinPublication, type CoinPublication } from "@blast/server/modules/social/create/publish-approval.ts";
import type { SaleCoverStore } from "@blast/server/modules/social/sales/cover.ts";
import type { SocialSaleMetadataResponse } from "@blast/core/modules/social/contracts/sales.ts";
import { createStore } from "#web/components/social/create/create-store.ts";
import { uuid } from "../../../../../../packages/core/test/kit.ts";

/**
 * Social-feed UI-20: the Create draft routes over migration 0068 as the web
 * runtime role `blast_web`, with a real Privy token verifier over a fixture
 * ES256 key and the Postgres rate limiter. Publishing covers both unavailable
 * dependencies and real coin bytecode/plans; transactions are not broadcast.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-create-app";
const NOW = Math.floor(Date.now() / 1_000);
const PEPPER = "social-create-fixture-pepper-0123456789abc";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const verificationKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
const validator = createSocialValidator();
const POOL_SETTINGS = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 8, statementTimeoutMs: 5_000 };

const wallet = (tag: string) => `0x${tag.padStart(64, "0")}`;
/** One test executor for every publish: production's 4 s budget includes the cold Worker start, which a loaded host can exceed. A pass returns as soon as the build does. */
const coinTemplate = { bytecode: createCoinTemplateExecutor({ timeoutMs: 60_000 }) };
const PUBLISHED_OBJECT_DIGEST = "4yUWbNQnn9KhVz9mSaQnTnmzAhHmzuHJyUz1rQpRKjat";
const SEALED_TREASURY_CAP = { object_id: wallet("ca"), version: "12", digest: PUBLISHED_OBJECT_DIGEST };
const ACCOUNTS = {
  kai: { id: uuid(0xc1), did: "did:privy:create-kai", callsign: "create_kai", wallet: wallet("c1") },
  mira: { id: uuid(0xc2), did: "did:privy:create-mira", callsign: "create_mira", wallet: wallet("c2") },
} as const;
const ALLOWLIST: CreateAllowlistSummary = { allowlist_id: uuid(0xa11), root: "ab".repeat(32), leaf_count: 1_200, min_cap: 100, max_cap: 5_000, quote_type: CREATE_QUOTE_TYPE };
// The smallest valid PNG sharp decodes: 64×64, one colour.
let PNG: Buffer;

function token(did: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: NOW + 3_600, iat: NOW - 60, iss: "privy.io", sid: "s-1", sub: did });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

const path = (id = "") => `${ORIGIN}/api/social/me/drafts${id ? `/${id}` : ""}`;

function request(did: string | null, url: string, init: RequestInit & { json?: unknown } = {}): Request {
  const headers = new Headers(init.headers);
  if (did) headers.set("authorization", `Bearer ${token(did)}`);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  return new Request(url, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
}

type Routes = ReturnType<typeof createSocialCreateRoutes>;
type Fixture = Readonly<{
  admin: Pool;
  routes: Routes;
  logos: Map<string, Buffer>;
  withStore: Routes;
  covers: Map<string, Buffer>;
  removed: string[];
  /** R3-42: the routes with other dependencies (a SUI price source, a mainnet deployment and its CreationPolicy). */
  routesWith: (overrides: Partial<SocialCreateRoutesDependencies>) => Routes;
  /** R3-42: SUI's price read the way the runtime reads it, here as `blast_web`. */
  suiPrice: SocialCreateRoutesDependencies["quotePrice"];
}>;
/** R3-25: a sale Kai's wallet holds the cap of, and one Mira's does. */
const KAI_SALE = `0x${"5a1e".padStart(64, "0")}`;
const MIRA_SALE = `0x${"5a1f".padStart(64, "0")}`;
const KAI_OTHER_SALE = `0x${"5a20".padStart(64, "0")}`;
const EDITORS: Readonly<Record<string, string>> = { [KAI_SALE]: ACCOUNTS.kai.wallet, [KAI_OTHER_SALE]: ACCOUNTS.kai.wallet, [MIRA_SALE]: ACCOUNTS.mira.wallet };

test("invalid stored draft bodies fail as server integrity errors without replacing the saved row", { skip }, () =>
  withDatabase(async ({ admin, routes }) => {
    const did = ACCOUNTS.kai.did;
    const id = uuid(0xd30);
    await ok<CreateDraftResponse>(await routes.draft.PUT(request(did, path(id), { method: "PUT", json: { version: 0, draft: blankDraft() } }), testClient()), 201, "create-draft-response");
    await admin.query("UPDATE social_presale_drafts SET body = jsonb_set(body, '{name}', '5') WHERE draft_id = $1", [id]);
    const snapshot = () => admin.query("SELECT to_jsonb(d)::text AS row FROM social_presale_drafts d WHERE draft_id = $1", [id]).then((result) => result.rows);
    const before = await snapshot();
    for (let attempt = 0; attempt < 2; attempt++) {
      const error = await refusal(await routes.draft.GET(request(did, path(id)), testClient()), 503, "service_unavailable");
      assert.equal(Object.hasOwn(error, "field"), false);
      assert.deepEqual(await snapshot(), before);
    }
    await refusal(await routes.draft.PUT(request(did, path(id), { method: "PUT", json: { version: 1, draft: { ...blankDraft(), name: 5 } } }), testClient()), 400, "invalid_request");
    assert.deepEqual(await snapshot(), before);
  }));

test("whitelisting USDC unlocks the refused draft and every step of a second same-name presale", { skip }, () =>
  withDatabase(async ({ routesWith }) => {
    const { did, wallet: creator } = ACCOUNTS.kai;
    // Mainnet CreationPolicy read on 2026-10-13: SUI and TEST_SUI allowed, USDC absent.
    const allowed = [CREATE_SUI_QUOTE_TYPE, CREATE_TEST_SUI_QUOTE_TYPE];
    const publishing = routesWith({
      deployment: () => ({ status: "ready", identity: MAINNET }), authorize: async () => MAINNET,
      template: coinTemplate,
      creationPolicy: async () => ({ quotes: allowed, witnesses: [normalizeStructTag(`${MAINNET.presale.migrators.originalPackageId}::bluefin::Venue`)] }),
    });
    const fill = (): CreateDraft => ({ ...suiDraft(), quote_type: createStore.get().draft.quote_type, venue: "bluefin", pool_fee: 10_000, name: "Same token", symbol: "SAME" });
    const save = (id: string, draft: CreateDraft) => publishing.draft.PUT(request(did, path(id), { method: "PUT", json: { version: 0, draft } }), testClient());
    const plans = async (id: string) => {
      const coinType = `${wallet("c01")}::drft::DRFT`;
      const steps = [
        { step: "publish_coin" },
        { step: "register_currency", coin: { coin_type: coinType, currency: { object_id: wallet("cc"), version: "12", digest: PUBLISHED_OBJECT_DIGEST } } },
        { step: "create_presale", coin: { coin_type: coinType, sealed_treasury_cap: SEALED_TREASURY_CAP, currency: { object_id: wallet("cc"), initial_shared_version: "12" } } },
      ] as const;
      for (const step of steps) {
        const plan = await ok<CreatePublishPlan>(await publishing.publish.POST(request(did, `${path(id)}/publish`, {
          method: "POST", json: { version: 1, creator, ...step },
        }), testClient()), 200, "create-publish-plan");
        assert.equal(plan.steps[0]?.kind, step.step);
      }
    };
    try {
      createStore.reset({ ownerId: ACCOUNTS.kai.id, quotes: [CREATE_TEST_SUI_QUOTE_TYPE] });
      const refusedId = uuid(0xf0f);
      await ok(await save(refusedId, { ...fill(), quote_type: CREATE_QUOTE_TYPE }), 201, "create-draft-response");
      const refused = await refusal(await publishing.publish.POST(request(did, `${path(refusedId)}/publish`, {
        method: "POST", json: { version: 1, creator, step: "publish_coin" },
      }), testClient()), 409, "publish_unavailable");
      assert.deepEqual(refused.reasons, ["creation_policy"]);
      assert.equal(refused.contract_error, "EQuoteNotAllowed");
      for (const [id, saleId] of [[uuid(0xf10), KAI_SALE], [uuid(0xf11), KAI_OTHER_SALE]] as const) {
        const saved = await ok<CreateDraftResponse>(await save(id, fill()), 201, "create-draft-response");
        assert.deepEqual(saved.quotes, allowed.includes(CREATE_QUOTE_TYPE) ? [CREATE_QUOTE_TYPE, CREATE_TEST_SUI_QUOTE_TYPE] : [CREATE_TEST_SUI_QUOTE_TYPE]);
        await plans(id);
        await ok(await publishing.published.POST(request(did, `${path(id)}/published`, {
          method: "POST", json: { presale_id: saleId },
        }), testClient()), 200, "sale-metadata-response");
        if (!allowed.includes(CREATE_QUOTE_TYPE)) {
          allowed.push(CREATE_QUOTE_TYPE);
          await plans(refusedId);
        }
        const reloaded = await ok<CreateDraftResponse>(await publishing.draft.GET(request(did, path(id)), testClient()), 200, "create-draft-response");
        createStore.set({ quotes: reloaded.quotes });
        createStore.startNewDraft();
        assert.equal(createStore.get().draft.name, "");
        assert.equal(createStore.get().draft.quote_type, CREATE_QUOTE_TYPE);
        const refreshed = await ok<CreateDraftPage>(await publishing.list.GET(request(did, `${path()}?resume=true`), testClient()), 200, "create-draft-page");
        assert.deepEqual(refreshed.items, []);
      }
      const differentId = uuid(0xf12);
      await ok(await save(differentId, { ...fill(), name: "Different token" }), 201, "create-draft-response");
      await plans(differentId);
    } finally {
      createStore.reset();
    }
  }));

test("Create restores only drafts saved after the latest publication and allows repeated names", { skip }, () =>
  withDatabase(async ({ routesWith }) => {
    const { did } = ACCOUNTS.kai;
    const draft = { ...suiDraft(), quote_type: CREATE_QUOTE_TYPE, name: "Same token", symbol: "SAME" };
    const withStore = routesWith({
      deployment: () => ({ status: "ready", identity: MAINNET }), authorize: async () => MAINNET,
      template: coinTemplate,
      creationPolicy: async () => ({ quotes: [CREATE_QUOTE_TYPE], witnesses: [normalizeStructTag(`${MAINNET.presale.migrators.originalPackageId}::${draft.venue}::Venue`)] }),
    });
    const save = (id: string, version = 0) => withStore.draft.PUT(request(did, path(id), { method: "PUT", json: { version, draft } }), testClient());
    const publish = (id: string, presaleId: string) => withStore.published.POST(request(did, `${path(id)}/published`, { method: "POST", json: { presale_id: presaleId } }), testClient());
    const coinPlan = (id: string) => withStore.publish.POST(request(did, `${path(id)}/publish`, {
      method: "POST", json: { version: 1, creator: ACCOUNTS.kai.wallet, step: "publish_coin" },
    }), testClient());
    const resume = () => withStore.list.GET(request(did, `${path()}?limit=1&resume=true`), testClient());
    const oldId = uuid(0xf01);
    const completedId = uuid(0xf02);
    await ok(await save(oldId), 201, "create-draft-response");
    await ok(await save(completedId), 201, "create-draft-response");
    await ok(await coinPlan(completedId), 200, "create-publish-plan");
    await ok(await publish(completedId, KAI_SALE), 200, "sale-metadata-response");
    const refreshed = await ok<CreateDraftPage>(await resume(), 200, "create-draft-page");
    assert.deepEqual(refreshed.items, [], "completed launches must not uncover an older unfinished form");
    const savedDrafts = await ok<CreateDraftPage>(await withStore.list.GET(request(did, path()), testClient()), 200, "create-draft-page");
    assert.equal(savedDrafts.items[0]?.draft_id, oldId, "older drafts remain available explicitly");
    const nextId = uuid(0xf03);
    await ok(await save(nextId), 201, "create-draft-response");
    await ok(await coinPlan(nextId), 200, "create-publish-plan");
    assert.equal((await ok<CreateDraftPage>(await resume(), 200, "create-draft-page")).items[0]?.draft_id, nextId);
    await ok(await publish(nextId, KAI_OTHER_SALE), 200, "sale-metadata-response");
    assert.deepEqual((await ok<CreateDraftPage>(await resume(), 200, "create-draft-page")).items, []);
    const differentId = uuid(0xf04);
    await ok(await withStore.draft.PUT(request(did, path(differentId), {
      method: "PUT", json: { version: 0, draft: { ...draft, name: "Another token" } },
    }), testClient()), 201, "create-draft-response");
    await ok(await coinPlan(differentId), 200, "create-publish-plan");
    await refusal(await withStore.list.GET(request(did, `${path()}?resume=invalid`), testClient()), 400, "invalid_parameter");
    await refusal(await save(completedId, 1), 409, "draft_published");
    await refusal(await withStore.publish.POST(request(did, `${path(completedId)}/publish`, {
      method: "POST", json: { version: 1, creator: ACCOUNTS.kai.wallet, step: "publish_coin" },
    }), testClient()), 409, "draft_published");
  }));

async function withDatabase(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 4 });
  const web = createRuntimePool(urlAs(database.url, "blast_web"), POOL_SETTINGS, "social-create-test");
  try {
    for (const account of Object.values(ACCOUNTS)) {
      await admin.query(
        `INSERT INTO social_accounts (account_id, privy_did, callsign, onboarding_shown_at, onboarded_at, privacy, sharing_since)
         VALUES ($1, $2, $3, now(), now(), 'public', now())`,
        [account.id, account.did, account.callsign],
      );
      await admin.query("INSERT INTO social_account_wallets (address, account_id, kind, verified_at) VALUES ($1, $2, 'external', now())", [account.wallet, account.id]);
    }
    const { default: sharp } = await import("sharp");
    PNG = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 214, g: 27, b: 112 } } }).png().toBuffer();
    const accounts = new PostgresSocialAccounts(() => web);
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey }),
      limiter: new PostgresRateLimitEnforcer({ pool: web, subjectPepper: PEPPER }),
      accounts,
      primary: () => web,
    });
    const logos = new Map<string, Buffer>();
    const store: CreateLogoStore = {
      async write(pathname, bytes) {
        logos.set(pathname, bytes);
        return { url: `https://blob.example/${pathname}` };
      },
    };
    const covers = new Map<string, Buffer>();
    const removed: string[] = [];
    const coverStore: SaleCoverStore = {
      async write(pathname, bytes) {
        covers.set(pathname, bytes);
        return { url: `https://blob.example/${pathname}` };
      },
      async remove(url) {
        removed.push(url);
        covers.delete(url.replace("https://blob.example/", ""));
      },
    };
    const routes = (logoStore: CreateLogoStore | null, overrides: Partial<SocialCreateRoutesDependencies> = {}) =>
      createSocialCreateRoutes({
        kit,
        feePolicy: async () => CREATE_DEFAULT_FEE_POLICY,
        allowlist: async (id, did) => (id === ALLOWLIST.allowlist_id && did === ACCOUNTS.kai.did ? ALLOWLIST : null),
        logoStore: () => logoStore,
        deployment: () => ({ status: "unavailable", reason: "missing" }),
        authorize: () => Promise.reject(new Error("no deployment")),
        creationPolicy: async () => null,
        quotePrice: async () => null,
        raiseQuotePrice: async () => ({ usd_price: "2", as_of_ms: Date.now() }),
        coinPublication: async () => null,
        prepareWalletPublication(transaction, signal) {
          transaction.setGasBudget(20_000_000);
          transaction.setGasPayment([{ objectId: wallet("ee"), version: "1", digest: PUBLISHED_OBJECT_DIGEST }]);
          const client = { core: {
            getChainIdentifier: async () => ({ chainIdentifier: PUBLISHED_OBJECT_DIGEST }),
            getCurrentSystemState: async () => ({ systemState: { epoch: "12", referenceGasPrice: "750" } }),
          } } as unknown as ClientWithCoreApi;
          return prepareWalletCoinPublication(client, transaction, signal);
        },
        cetusTiers: async () => ({ [CREATE_QUOTE_TYPE]: [[200, 10_000]], [CREATE_SUI_QUOTE_TYPE]: [[200, 10_000]], [CREATE_USDSUI_QUOTE_TYPE]: [[200, 10_000]], [CREATE_WAL_QUOTE_TYPE]: [[200, 10_000]] }),
        bluefinOptions: async () => ({ status: "ready", min_tick: -443_636, max_tick: 443_636 }),
        template: null,
        wallets: async (accountId) => (await accounts.wallets(accountId)).map((row) => row.address),
        draftLimit: 3,
        database: () => autocommitReader(web, "social", { label: "social.create-test" }),
        coverStore: () => (logoStore ? coverStore : null),
        editor: async (presaleId) => EDITORS[presaleId] ?? null,
        findBlockedTerm: async (text) => (text.toLowerCase().includes("rugpull") ? "rugpull" : null),
        ...overrides,
      });
    const suiPrice = () => readSuiQuotePrice(autocommitReader(web, "social", { label: "social.create-test-price" }));
    await run({ admin, routes: routes(null), withStore: routes(store), logos, covers, removed, routesWith: (overrides) => routes(null, overrides), suiPrice });
  } finally {
    await web.end();
    await admin.end();
    await database.drop();
  }
}

async function ok<T>(response: Response, status: number, schema: Parameters<typeof validator.validate>[0]): Promise<T> {
  const body: unknown = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.deepEqual(validator.validate(schema, body).errors, []);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.ok(response.headers.get("x-request-id"));
  return body as T;
}

async function refusal(response: Response, status: number, code: string): Promise<Record<string, unknown>> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error.code, code);
  assert.deepEqual(validator.validate("error", body).errors, []);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return body.error;
}

const named = (name: string): CreateDraft => ({ ...blankDraft(), name, symbol: name.slice(0, 4).toUpperCase() });

test("migrated month drafts and explicit units retain identities, read without writes and save once", { skip }, () =>
  withDatabase(async ({ admin, routes, routesWith }) => {
    // The normal fixture rehearses the complete chain. Reconstruct its immediate
    // predecessor to seed genuinely old persisted bodies, then apply 0130 once.
    await admin.query("ALTER TABLE social_presale_drafts DROP CONSTRAINT social_presale_drafts_canonical_recipients");
    await admin.query("DELETE FROM mission_control_schema_migrations WHERE name = '0130_social_recipient_drafts'");
    const writer = routesWith({});
    const draft = named("Meridian");
    const explicit = { ...draft, quote_type: CREATE_TEST_SUI_QUOTE_TYPE, token_recipients: [{ ...draft.token_recipients[0]!, vest: false, cliff: 3, cliff_unit: "minutes" as const }] };
    const legacyRow = (row: CreateDraft["token_recipients"][number]) => ({ label: row.label, address: row.address, bps: row.bps, vest: row.vest, cliff_months: row.cliff, months: row.duration });
    const legacy = { ...draft, token_recipients: draft.token_recipients.map(legacyRow), raise_recipients: draft.raise_recipients.map(legacyRow) };
    const fixtures = [[0, explicit, explicit], [1, legacy, draft], [2, legacy, draft]] as const;
    for (const [index, body] of fixtures) {
      await admin.query(`INSERT INTO social_presale_drafts
        (draft_id, account_id, version, body, logo_url, created_at, updated_at, published_presale_id, published_at)
        VALUES ($1, $2, 7, $3::jsonb, $4, '2026-09-01 00:00:00.123456+00', '2026-09-02 00:00:00.654321+00', $5, $6)`,
      [uuid(0xd10 + index), ACCOUNTS.kai.id, JSON.stringify(body), "https://blob.example/saved-logo.png", index === 2 ? KAI_SALE : null, index === 2 ? "2026-09-03 00:00:00.987654+00" : null]);
    }
    const protectedRows = () => admin.query("SELECT (to_jsonb(d) - 'body')::text AS facts FROM social_presale_drafts d ORDER BY draft_id");
    const protectedBefore = (await protectedRows()).rows;
    assert.deepEqual(await migrateDatabase(admin), ["0130_social_recipient_drafts"]);
    assert.deepEqual((await protectedRows()).rows, protectedBefore);
    assert.deepEqual(await migrateDatabase(admin), []);
    for (const [index, , expected] of fixtures) {
      const id = uuid(0xd10 + index);
      const before = (await admin.query("SELECT to_jsonb(d)::text AS row FROM social_presale_drafts d WHERE draft_id = $1", [id])).rows;
      for (let read = 0; read < 2; read++) {
        const restored = await ok<CreateDraftResponse>(await routes.draft.GET(request(ACCOUNTS.kai.did, path(id)), testClient()), 200, "create-draft-response");
        assert.equal(restored.draft_id, id);
        assert.equal(restored.version, 7);
        assert.equal(restored.logo_url, "https://blob.example/saved-logo.png");
        assert.equal(restored.published_presale_id, index === 2 ? KAI_SALE : null);
        assert.deepEqual(restored.draft, expected);
      }
      assert.deepEqual((await admin.query("SELECT to_jsonb(d)::text AS row FROM social_presale_drafts d WHERE draft_id = $1", [id])).rows, before);
      await refusal(await routes.draft.GET(request(null, path(id)), testClient()), 401, "unauthorized");
      await refusal(await routes.draft.GET(request(ACCOUNTS.mira.did, path(id)), testClient()), 404, "not_found");
      await refusal(await writer.draft.PUT(request(ACCOUNTS.mira.did, path(id), { method: "PUT", json: { version: 7, draft: expected } }), testClient()), 404, "not_found");
      if (index === 2) {
        await refusal(await writer.draft.PUT(request(ACCOUNTS.kai.did, path(id), { method: "PUT", json: { version: 7, draft: expected } }), testClient()), 409, "draft_published");
        assert.deepEqual((await admin.query("SELECT to_jsonb(d)::text AS row FROM social_presale_drafts d WHERE draft_id = $1", [id])).rows, before);
        continue;
      }
      const saved = await ok<CreateDraftResponse>(await writer.draft.PUT(request(ACCOUNTS.kai.did, path(id), { method: "PUT", json: { version: 7, draft: expected } }), testClient()), 200, "create-draft-response");
      assert.equal(saved.version, 8);
      assert.deepEqual(saved.draft, expected);
      const afterSave = (await admin.query("SELECT to_jsonb(d)::text AS row FROM social_presale_drafts d WHERE draft_id = $1", [id])).rows;
      const retried = await ok<CreateDraftResponse>(await writer.draft.PUT(request(ACCOUNTS.kai.did, path(id), { method: "PUT", json: { version: 7, draft: expected } }), testClient()), 200, "create-draft-response");
      assert.equal(retried.version, 8);
      const conflict = await refusal(await writer.draft.PUT(request(ACCOUNTS.kai.did, path(id), { method: "PUT", json: { version: 7, draft: { ...expected, name: "Another edit" } } }), testClient()), 409, "draft_conflict");
      assert.equal((conflict.draft as CreateDraftResponse).version, 8);
      assert.deepEqual((await admin.query("SELECT to_jsonb(d)::text AS row FROM social_presale_drafts d WHERE draft_id = $1", [id])).rows, afterSave);
    }
    await refusal(await writer.draft.PUT(request(ACCOUNTS.kai.did, path(uuid(0xd10)), { method: "PUT", json: { version: 8, draft: legacy } }), testClient()), 400, "invalid_request");
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM social_presale_drafts")).rows[0].count, 3);
  }),
);

test("UI-20: create, read, save with the version, a stale save conflicts, a retried save is harmless, delete", { skip }, () =>
  withDatabase(async ({ admin, routes }) => {
    const { did } = ACCOUNTS.kai;
    const id = uuid(0xd1);
    const created = await ok<CreateDraftResponse>(await routes.draft.PUT(request(did, path(id), { method: "PUT", json: { version: 0, draft: blankDraft() } }), testClient()), 201, "create-draft-response");
    assert.equal(created.version, 1);
    assert.deepEqual(created.draft, blankDraft());
    assert.deepEqual(created.issues.map((issue) => issue.message), ["Add a name", "Add a ticker", "Add Team's Sui address", "Add Treasury's Sui address", "Add Team's Sui address"]);
    assert.deepEqual(created.fee_policy, CREATE_DEFAULT_FEE_POLICY);
    // A retried create (same body) answers the stored draft.
    assert.equal((await ok<CreateDraftResponse>(await routes.draft.PUT(request(did, path(id), { method: "PUT", json: { version: 0, draft: blankDraft() } }), testClient()), 200, "create-draft-response")).version, 1);

    const saved = await ok<CreateDraftResponse>(await routes.draft.PUT(request(did, path(id), { method: "PUT", json: { version: 1, draft: named("Meridian") } }), testClient()), 200, "create-draft-response");
    assert.equal(saved.version, 2);
    assert.equal(saved.issues.length, 3);
    // The same save again (its answer was lost): harmless.
    assert.equal((await ok<CreateDraftResponse>(await routes.draft.PUT(request(did, path(id), { method: "PUT", json: { version: 1, draft: named("Meridian") } }), testClient()), 200, "create-draft-response")).version, 2);
    // Another tab saving over version 1 with other values: a conflict carrying the stored draft.
    const conflict = await refusal(await routes.draft.PUT(request(did, path(id), { method: "PUT", json: { version: 1, draft: named("Kestrel") } }), testClient()), 409, "draft_conflict");
    const stored = conflict.draft as CreateDraftResponse;
    assert.deepEqual(validator.validate("create-draft-response", stored).errors, []);
    assert.equal(stored.draft.name, "Meridian");
    assert.equal(stored.version, 2);

    const read = await ok<CreateDraftResponse>(await routes.draft.GET(request(did, path(id)), testClient()), 200, "create-draft-response");
    assert.equal(read.draft.name, "Meridian");
    assert.equal((await routes.draft.DELETE(request(did, path(id), { method: "DELETE" }), testClient())).status, 204);
    assert.equal((await routes.draft.DELETE(request(did, path(id), { method: "DELETE" }), testClient())).status, 204, "deleting again is harmless");
    await refusal(await routes.draft.GET(request(did, path(id)), testClient()), 404, "not_found");
    await refusal(await routes.draft.PUT(request(did, path(id), { method: "PUT", json: { version: 2, draft: blankDraft() } }), testClient()), 404, "not_found");
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_presale_drafts")).rows[0].n, 0);
  }));

test("UI-20: another account's draft reads as not found; signed out is unauthorized", { skip }, () =>
  withDatabase(async ({ routes }) => {
    const id = uuid(0xd2);
    await ok(await routes.draft.PUT(request(ACCOUNTS.kai.did, path(id), { method: "PUT", json: { version: 0, draft: blankDraft() } }), testClient()), 201, "create-draft-response");
    const mira = ACCOUNTS.mira.did;
    await refusal(await routes.draft.GET(request(mira, path(id)), testClient()), 404, "not_found");
    await refusal(await routes.draft.PUT(request(mira, path(id), { method: "PUT", json: { version: 1, draft: named("Theft") } }), testClient()), 404, "not_found");
    await refusal(await routes.draft.PUT(request(mira, path(id), { method: "PUT", json: { version: 0, draft: named("Theft") } }), testClient()), 404, "not_found");
    assert.equal((await routes.draft.DELETE(request(mira, path(id), { method: "DELETE" }), testClient())).status, 204);
    const kept = await ok<CreateDraftResponse>(await routes.draft.GET(request(ACCOUNTS.kai.did, path(id)), testClient()), 200, "create-draft-response");
    assert.equal(kept.draft.name, "", "another account changed nothing");
    await refusal(await routes.list.GET(request(null, path()), testClient()), 401, "unauthorized");
    await refusal(await routes.draft.GET(request(ACCOUNTS.kai.did, path("not-a-uuid")), testClient()), 404, "not_found");
  }));

test("UI-20: the drafts list pages by keyset, newest save first; the per-account limit holds", { skip }, () =>
  withDatabase(async ({ routes }) => {
    const { did } = ACCOUNTS.kai;
    for (const [n, name] of [[1, "Alpha"], [2, "Beta"], [3, "Gamma"]] as const) {
      await ok(await routes.draft.PUT(request(did, path(uuid(0xe0 + n)), { method: "PUT", json: { version: 0, draft: named(name) } }), testClient()), 201, "create-draft-response");
    }
    await refusal(await routes.draft.PUT(request(did, path(uuid(0xe9)), { method: "PUT", json: { version: 0, draft: named("Delta") } }), testClient()), 422, "draft_limit");
    // Touch Alpha so it is the newest.
    await ok(await routes.draft.PUT(request(did, path(uuid(0xe1)), { method: "PUT", json: { version: 1, draft: named("Alpha2") } }), testClient()), 200, "create-draft-response");
    const first = await ok<CreateDraftPage>(await routes.list.GET(request(did, `${path()}?limit=2`), testClient()), 200, "create-draft-page");
    assert.deepEqual(first.items.map((item) => item.name), ["Alpha2", "Gamma"]);
    assert.ok(first.next_cursor);
    const second = await ok<CreateDraftPage>(await routes.list.GET(request(did, `${path()}?limit=2&cursor=${first.next_cursor}`), testClient()), 200, "create-draft-page");
    assert.deepEqual(second.items.map((item) => item.name), ["Beta"]);
    assert.equal(second.next_cursor, null);
    await refusal(await routes.list.GET(request(did, `${path()}?cursor=forged.abcdefghijkl`), testClient()), 400, "invalid_parameter");
    await refusal(await routes.list.GET(request(did, `${path()}?limit=99`), testClient()), 400, "invalid_parameter");
    const mira = await ok<CreateDraftPage>(await routes.list.GET(request(ACCOUNTS.mira.did, path()), testClient()), 200, "create-draft-page");
    assert.deepEqual(mira.items, []);
  }));

test("UI-20: a save is read strictly: shape errors name the field, other bodies are refused", { skip }, () =>
  withDatabase(async ({ routes }) => {
    const { did } = ACCOUNTS.kai;
    const id = uuid(0xd3);
    const bad = await refusal(await routes.draft.PUT(request(did, path(id), { method: "PUT", json: { version: 0, draft: { ...blankDraft(), target: 1.234 } } }), testClient()), 400, "invalid_request");
    assert.equal(bad.field, "target");
    await refusal(await routes.draft.PUT(request(did, path(id), { method: "PUT", json: { version: 0 } }), testClient()), 400, "invalid_request");
    await refusal(await routes.draft.PUT(request(did, path(id), { method: "PUT", json: { version: -1, draft: blankDraft() } }), testClient()), 400, "invalid_request");
    await refusal(await routes.draft.PUT(request(did, path(id), { method: "PUT", body: "{}", headers: { "content-type": "text/plain" } }), testClient()), 400, "invalid_request");
    await refusal(await routes.draft.PUT(request(did, path(id), { method: "PUT", body: "x".repeat(70_000), headers: { "content-type": "application/json" } }), testClient()), 413, "body_too_large");
  }));

test("UI-20: an allowlist attaches only for the sign-in that uploaded it, and its summary rides with the draft", { skip }, () =>
  withDatabase(async ({ routes }) => {
    const id = uuid(0xd4);
    const draft = { ...blankDraft(), eligibility: "allowlist" as const, allowlist_id: ALLOWLIST.allowlist_id };
    const saved = await ok<CreateDraftResponse>(await routes.draft.PUT(request(ACCOUNTS.kai.did, path(id), { method: "PUT", json: { version: 0, draft } }), testClient()), 201, "create-draft-response");
    assert.deepEqual(saved.allowlist, ALLOWLIST);
    assert.ok(!saved.issues.some((issue) => issue.path === "allowlist"));
    await refusal(await routes.draft.PUT(request(ACCOUNTS.mira.did, path(uuid(0xd5)), { method: "PUT", json: { version: 0, draft } }), testClient()), 422, "allowlist_not_found");
    const cleared = await ok<CreateDraftResponse>(await routes.draft.PUT(request(ACCOUNTS.kai.did, path(id), { method: "PUT", json: { version: 1, draft: { ...draft, allowlist_id: null } } }), testClient()), 200, "create-draft-response");
    assert.equal(cleared.allowlist, null);
    assert.ok(cleared.issues.some((issue) => issue.message === "Upload the allowlist"));
  }));

test("UI-20: a logo is re-encoded into the store and set on the draft; refused images and a missing store are named", { skip }, () =>
  withDatabase(async ({ routes, withStore, logos }) => {
    const { did } = ACCOUNTS.kai;
    const id = uuid(0xd6);
    await ok(await routes.draft.PUT(request(did, path(id), { method: "PUT", json: { version: 0, draft: blankDraft() } }), testClient()), 201, "create-draft-response");
    const upload = (r: Routes, body: Uint8Array, type = "image/png") =>
      r.logo.PUT(request(did, `${path(id)}/logo`, { method: "PUT", body: Buffer.from(body), headers: { "content-type": type } }), testClient());
    await refusal(await upload(routes, PNG), 503, "logo_upload_unavailable");
    const withLogo = await ok<CreateDraftResponse>(await upload(withStore, PNG), 200, "create-draft-response");
    assert.equal(withLogo.version, 2);
    assert.match(withLogo.logo_url ?? "", /^https:\/\/blob\.example\/create-logos\/[0-9a-f]{64}\.webp$/);
    assert.equal(logos.size, 1);
    assert.equal((await refusal(await upload(withStore, Buffer.from("not an image")), 422, "invalid_logo")).reason, "type");
    assert.equal((await refusal(await upload(withStore, PNG, "image/jpeg"), 422, "invalid_logo")).reason, "type");
    await refusal(await withStore.logo.PUT(request(ACCOUNTS.mira.did, `${path(id)}/logo`, { method: "PUT", body: Buffer.from(PNG), headers: { "content-type": "image/png" } }), testClient()), 404, "not_found");
  }));

test("UI-20: publishing answers why it is off and sends nothing", { skip }, () =>
  withDatabase(async ({ routes }) => {
    const { did } = ACCOUNTS.kai;
    const id = uuid(0xd7);
    await ok(await routes.draft.PUT(request(did, path(id), { method: "PUT", json: { version: 0, draft: blankDraft() } }), testClient()), 201, "create-draft-response");
    const off = await refusal(
      await routes.publish.POST(request(did, `${path(id)}/publish`, { method: "POST", json: { version: 1, step: "publish_coin", creator: ACCOUNTS.kai.wallet } }), testClient()),
      409,
      "publish_unavailable",
    );
    // This fixture deliberately omits the deployment and coin template.
    assert.deepEqual(off.reasons, ["presale_not_deployed", "coin_template_missing"]);
    await refusal(await routes.publish.POST(request(ACCOUNTS.mira.did, `${path(id)}/publish`, { method: "POST", json: { version: 1, step: "publish_coin", creator: ACCOUNTS.mira.wallet } }), testClient()), 404, "not_found");
  }));

// ---- R3-25: the sale's details in the draft, its cover, and publishing them ----

const LINKS = {
  site: "meridian.finance",
  x_handle: "@meridianfx",
  telegram: "https://t.me/meridianfx",
  docs_url: "https://docs.meridian.finance/intro#top",
  audit_url: "http://audits.example/meridian.pdf",
};

async function coverForm(bytes: Uint8Array, type = "image/png"): Promise<{ body: Uint8Array<ArrayBuffer>; headers: Record<string, string> }> {
  const form = new FormData();
  form.set("cover", new File([new Uint8Array(bytes)], "cover", { type }));
  const encoded = new Response(form);
  const contentType = encoded.headers.get("content-type");
  assert.ok(contentType, "Multipart encoding must supply its boundary before the body is consumed");
  const body = new Uint8Array(await encoded.arrayBuffer());
  return { body, headers: { "content-type": contentType, "content-length": String(body.byteLength) } };
}

test("R3-25-AC-1 / AC-2: a draft round-trips the links and quote; a pasted handle is kept bare; an unknown key is still refused", { skip }, () =>
  withDatabase(async ({ admin, routes }) => {
    const { did } = ACCOUNTS.kai;
    const id = uuid(0xd8);
    const created = await ok<CreateDraftResponse>(await routes.draft.PUT(request(did, path(id), { method: "PUT", json: { version: 0, draft: { ...named("Meridian"), ...LINKS } } }), testClient()), 201, "create-draft-response");
    assert.deepEqual(
      [created.draft.site, created.draft.x_handle, created.draft.telegram, created.draft.docs_url, created.draft.audit_url, created.draft.quote_type],
      ["meridian.finance", "meridianfx", "meridianfx", "https://docs.meridian.finance/intro#top", "http://audits.example/meridian.pdf", blankDraft().quote_type],
    );
    assert.equal(created.cover, null);
    assert.equal(created.published_presale_id, null);
    assert.ok(!created.issues.some((issue) => issue.section === "links"));
    const read = await ok<CreateDraftResponse>(await routes.draft.GET(request(did, path(id)), testClient()), 200, "create-draft-response");
    assert.deepEqual(read.draft, created.draft);
    // The columns hold the checked values: https, no fragment, bare handles.
    const columns = (await admin.query("SELECT quote_type, site, x_handle, telegram, docs_url, audit_url FROM social_presale_drafts WHERE draft_id = $1", [id])).rows[0];
    assert.deepEqual(columns, {
      quote_type: blankDraft().quote_type,
      site: "https://meridian.finance",
      x_handle: "meridianfx",
      telegram: "meridianfx",
      docs_url: "https://docs.meridian.finance/intro",
      audit_url: "https://audits.example/meridian.pdf",
    });
    // A page from before the fields omits them: the draft keeps blank ones.
    const older = Object.fromEntries(Object.entries(named("Older")).filter(([key]) => !["quote_type", "site", "x_handle", "telegram", "docs_url", "audit_url"].includes(key)));
    const kept = await ok<CreateDraftResponse>(await routes.draft.PUT(request(did, path(uuid(0xd9)), { method: "PUT", json: { version: 0, draft: older } }), testClient()), 201, "create-draft-response");
    assert.deepEqual([kept.draft.site, kept.draft.quote_type], ["", blankDraft().quote_type]);
    // Closed: an unknown key, a quote Blast does not raise (or SUI's not in its canonical form), a non-string link are refused, naming the field.
    for (const [draft, field] of [
      [{ ...named("X"), website: "x" }, "draft"],
      [{ ...named("X"), quote_type: `${wallet("a7")}::wal::WAL` }, "quote_type"],
      [{ ...named("X"), quote_type: "0x2::sui::SUI" }, "quote_type"],
      [{ ...named("X"), site: 5 }, "site"],
    ] as const) {
      const bad = await refusal(await routes.draft.PUT(request(did, path(id), { method: "PUT", json: { version: 1, draft } }), testClient()), 400, "invalid_request");
      assert.equal(bad.field, field);
    }
  }));

test("R3-25-AC-2: each wrong link is an issue in the links section, in the gate's words, and a wrong one is not a column", { skip }, () =>
  withDatabase(async ({ admin, routes }) => {
    const { did } = ACCOUNTS.kai;
    const id = uuid(0xda);
    const draft = { ...named("Meridian"), site: "not a site", docs_url: "ftp://docs.example", audit_url: "https://user@audits.example", x_handle: "a".repeat(16), telegram: "abcd" };
    const saved = await ok<CreateDraftResponse>(await routes.draft.PUT(request(did, path(id), { method: "PUT", json: { version: 0, draft } }), testClient()), 201, "create-draft-response");
    assert.deepEqual(saved.issues.filter((issue) => issue.section === "links").map((issue) => [issue.path, issue.message]), [
      ["site", "Website isn't a web address"],
      ["docs_url", "Docs isn't a web address"],
      ["audit_url", "Audit report isn't a web address"],
      ["x_handle", "X handles are up to 15 letters, digits or _"],
      ["telegram", "Telegram names are 5 to 32 letters, digits or _"],
    ]);
    assert.deepEqual((await admin.query("SELECT site, x_handle, telegram, docs_url, audit_url FROM social_presale_drafts WHERE draft_id = $1", [id])).rows[0], {
      site: null, x_handle: null, telegram: null, docs_url: null, audit_url: null,
    });
  }));

test("R3-25-AC-3: a cover uploads, replaces and removes; over 4 MB, an SVG and a non-image are refused; a missing store is named", { skip }, () =>
  withDatabase(async ({ routes, withStore, covers, removed }) => {
    const { did } = ACCOUNTS.kai;
    const id = uuid(0xdb);
    await ok(await routes.draft.PUT(request(did, path(id), { method: "PUT", json: { version: 0, draft: blankDraft() } }), testClient()), 201, "create-draft-response");
    const { default: sharp } = await import("sharp");
    const image = (colour: string) => sharp({ create: { width: 1_800, height: 600, channels: 3, background: colour } }).png().toBuffer();
    const upload = async (r: Routes, bytes: Uint8Array, type = "image/png", who: string = did) => {
      const form = await coverForm(bytes, type);
      return r.cover.POST(request(who, `${path(id)}/cover`, { method: "POST", body: form.body, headers: form.headers }), testClient());
    };
    await refusal(await upload(routes, await image("#d61b70")), 503, "cover_upload_unavailable");
    const first = await ok<CreateDraftResponse>(await upload(withStore, await image("#d61b70")), 200, "create-draft-response");
    assert.equal(first.version, 2);
    assert.deepEqual([first.cover?.width, first.cover?.height], [1_536, 512]);
    // Gap 17: the upload's own size is kept beside the 3:1 cover, so the hint survives a reload.
    assert.deepEqual(first.cover?.source, { width: 1_800, height: 600 });
    const reloaded = await ok<CreateDraftResponse>(await withStore.draft.GET(request(did, path(id)), testClient()), 200, "create-draft-response");
    assert.deepEqual(reloaded.cover, first.cover);
    assert.match(first.cover?.url ?? "", new RegExp(`^https://blob\\.example/draft-covers/${id}/[0-9a-f]{64}\\.webp$`));
    const meta = await sharp(covers.get(first.cover!.url.replace("https://blob.example/", ""))!).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ["webp", 1_536, 512]);
    const second = await ok<CreateDraftResponse>(await upload(withStore, await image("#123456")), 200, "create-draft-response");
    assert.deepEqual(removed, [first.cover!.url], "the replaced cover's object is deleted");
    await refusal(await upload(withStore, new Uint8Array(5 * 1_024 * 1_024)), 413, "body_too_large");
    assert.equal((await refusal(await upload(withStore, Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/svg+xml"), 422, "invalid_cover")).reason, "type");
    assert.equal((await refusal(await upload(withStore, Buffer.from("not an image")), 422, "invalid_cover")).reason, "type");
    await refusal(await upload(withStore, await image("#000000"), "image/png", ACCOUNTS.mira.did), 404, "not_found");
    const gone = await ok<CreateDraftResponse>(await withStore.cover.DELETE(request(did, `${path(id)}/cover`, { method: "DELETE" }), testClient()), 200, "create-draft-response");
    assert.equal(gone.cover, null);
    assert.deepEqual(removed, [first.cover!.url, second.cover!.url]);
    assert.equal(covers.size, 0);
  }));

test("R3-25-AC-7: publishing records the sale and writes its details in one transaction; a failure in either leaves neither", { skip }, () =>
  withDatabase(async ({ admin, withStore }) => {
    const { did } = ACCOUNTS.kai;
    const id = uuid(0xdc);
    await ok(await withStore.draft.PUT(request(did, path(id), { method: "PUT", json: { version: 0, draft: { ...named("Meridian"), tagline: "Onchain FX for stablecoins", ...LINKS } } }), testClient()), 201, "create-draft-response");
    const { default: sharp } = await import("sharp");
    const form = await coverForm(await sharp({ create: { width: 1_536, height: 512, channels: 3, background: "#d61b70" } }).png().toBuffer());
    const withCover = await ok<CreateDraftResponse>(await withStore.cover.POST(request(did, `${path(id)}/cover`, { method: "POST", body: form.body, headers: form.headers }), testClient()), 200, "create-draft-response");
    const published = (presaleId: string, who = did) =>
      withStore.published.POST(request(who, `${path(id)}/published`, { method: "POST", json: { presale_id: presaleId } }), testClient());
    const state = async () => ({
      draft: (await admin.query("SELECT published_presale_id FROM social_presale_drafts WHERE draft_id = $1", [id])).rows[0].published_presale_id,
      details: (await admin.query("SELECT count(*)::int AS n FROM social_sale_metadata")).rows[0].n,
    });

    // Not the cap holder of the sale, or not a sale id: refused, nothing written.
    await refusal(await published(MIRA_SALE), 403, "not_sale_creator");
    await refusal(await published("0xnope"), 400, "invalid_request");
    assert.deepEqual(await state(), { draft: null, details: 0 });

    // An injected failure in the details write: the sale record rolls back with it.
    await admin.query(`CREATE FUNCTION fail_details() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$;
      CREATE TRIGGER fail_details BEFORE INSERT ON social_sale_metadata FOR EACH ROW EXECUTE FUNCTION fail_details();`);
    await refusal(await published(KAI_SALE), 503, "service_unavailable");
    assert.deepEqual(await state(), { draft: null, details: 0 });
    await admin.query("DROP TRIGGER fail_details ON social_sale_metadata; DROP FUNCTION fail_details();");
    // And one in the sale record: no details are written.
    await admin.query(`CREATE FUNCTION fail_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.published_presale_id IS NOT NULL THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_record BEFORE UPDATE ON social_presale_drafts FOR EACH ROW EXECUTE FUNCTION fail_record();`);
    await refusal(await published(KAI_SALE), 503, "service_unavailable");
    assert.deepEqual(await state(), { draft: null, details: 0 });
    await admin.query("DROP TRIGGER fail_record ON social_presale_drafts; DROP FUNCTION fail_record();");

    // Both land together: the draft's tagline, checked links and cover are the sale's details.
    const body: unknown = await (await published(KAI_SALE)).json();
    assert.deepEqual(validator.validate("sale-metadata-response", body).errors, []);
    const answer = body as SocialSaleMetadataResponse;
    assert.deepEqual(answer.metadata, {
      tagline: "Onchain FX for stablecoins",
      site: "https://meridian.finance",
      x_handle: "meridianfx",
      telegram: "meridianfx",
      docs_url: "https://docs.meridian.finance/intro",
      audit_url: "https://audits.example/meridian.pdf",
      cover: withCover.cover,
      launch_at_ms: null,
    });
    assert.deepEqual(await state(), { draft: KAI_SALE, details: 1 });
    const edits = (await admin.query("SELECT account_id::text FROM social_sale_metadata_edits WHERE presale_id = $1", [KAI_SALE])).rows;
    assert.deepEqual(edits, [{ account_id: ACCOUNTS.kai.id }]);
    // Once: the same sale again changes nothing; another sale is refused; the draft's cover is the sale's now.
    assert.equal((await published(KAI_SALE)).status, 200);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_sale_metadata_edits")).rows[0].n, 1);
    await refusal(await published(KAI_OTHER_SALE), 409, "draft_published");
    const read = await ok<CreateDraftResponse>(await withStore.draft.GET(request(did, path(id)), testClient()), 200, "create-draft-response");
    assert.equal(read.published_presale_id, KAI_SALE);
    await withStore.draft.DELETE(request(did, path(id), { method: "DELETE" }), testClient());
    assert.deepEqual(await state(), { draft: KAI_SALE, details: 1 }, "deleting a draft cannot erase a published presale’s discovery history");
    const drafts = await (await withStore.list.GET(request(did, path()), testClient())).json();
    assert.equal(drafts.items.length, 0, "published presales belong on Created, not Saved drafts");
    for (const n of [0xdd, 0xde, 0xdf]) {
      await ok(await withStore.draft.PUT(request(did, path(uuid(n)), { method: "PUT", json: { version: 0, draft: named("Next launch") } }), testClient()), 201, "create-draft-response");
    }
    await refusal(await withStore.draft.PUT(request(did, path(uuid(0xe0)), { method: "PUT", json: { version: 0, draft: named("Delta") } }), testClient()), 422, "draft_limit");

    await refusal(await withStore.cover.DELETE(request(did, `${path(id)}/cover`, { method: "DELETE" }), testClient()), 409, "draft_published");
  }));

// ---- R3-42: the "Raise in" picker's coins, a SUI draft, and publishing it ----

const MAINNET: PresaleRuntimeIdentity = { ...parsePresaleRuntimeIdentity(presaleIdentityFixture(), { production: false }), network: "mainnet" };
const SUI_AS_OF = 1_791_000_000_000;

/** A SUI draft as the picker leaves it ($400,000 → 120,000 SUI, $25,000 → 7,300, $10 → 3), every recipient addressed. */
function suiDraft(): CreateDraft {
  const draft = named("Driftwood");
  return {
    ...draft,
    quote_type: CREATE_SUI_QUOTE_TYPE,
    venue: "cetus",
    target: 120_000,
    wallet_cap: 7_300,
    min_commitment: 3,
    max_wallets: 40_000,
    token_recipients: draft.token_recipients.map((row, index) => ({ ...row, address: wallet(`b${index}`) })),
    raise_recipients: draft.raise_recipients.map((row) => ({ ...row, address: wallet("b0") })),
  };
}

test("publish enforces the server raise floor and preserves admitted or demonstrably started drafts", { skip }, () =>
  withDatabase(async ({ routesWith, admin }) => {
    const { did, wallet: creator } = ACCOUNTS.kai;
    const id = uuid(0xe60);
    const legacyId = uuid(0xe61);
    const usdcId = uuid(0xe62);
    const witness = normalizeStructTag(`${MAINNET.presale.migrators.originalPackageId}::cetus::Venue`);
    let price = { usd_price: "3.42", as_of_ms: Date.now() };
    let publication: CoinPublication | null = null;
    const routes = routesWith({
      deployment: () => ({ status: "ready", identity: MAINNET }), authorize: async () => MAINNET,
      creationPolicy: async () => ({ quotes: [CREATE_SUI_QUOTE_TYPE, CREATE_QUOTE_TYPE], witnesses: [witness] }),
      template: coinTemplate,
      raiseQuotePrice: async () => price,
      coinPublication: async () => publication,
    });
    const draft = { ...suiDraft(), target: 292.4, wallet_cap: 100, max_wallets: 100 };
    const save = (draftId: string, version: number, body: CreateDraft) =>
      routes.draft.PUT(request(did, path(draftId), { method: "PUT", json: { version, draft: body } }), testClient());
    const publishCoin = { step: "publish_coin" };
    const createSale = { step: "create_presale", coin: {
      coin_type: `${wallet("c01")}::drft::DRFT`, sealed_treasury_cap: SEALED_TREASURY_CAP,
      currency: { object_id: wallet("cc"), initial_shared_version: "12" },
    } };
    const plan = (draftId: string, step: object, version = 1) =>
      routes.publish.POST(request(did, `${path(draftId)}/publish`, { method: "POST", json: { version, creator, ...step } }), testClient());
    async function belowFloor(draftId: string, step: object, message: string, version = 1) {
      const error = await refusal(await plan(draftId, step, version), 422, "draft_incomplete");
      assert.equal(error.reason, "minimum_raise");
      assert.deepEqual(error.issues, [{ section: "raise", path: "target", message }]);
    }

    await ok(await save(usdcId, 0, { ...draft, quote_type: CREATE_QUOTE_TYPE, target: 999.99, max_wallets: 400 }), 201, "create-draft-response");
    for (const step of [publishCoin, createSale]) await belowFloor(usdcId, step, "Set a target of at least 1,000\u00a0USDC.");
    await ok(await save(id, 0, draft), 201, "create-draft-response");
    const admitted = await ok<CreatePublishPlan>(await plan(id, publishCoin), 200, "create-publish-plan");
    const signedTerms = admitted.steps[0]!.transaction!;
    const kindProof = await coinKindProof(signedTerms);
    const digest = await Transaction.from(signedTerms).getDigest();

    price = { usd_price: "3.00", as_of_ms: Date.now() };
    await belowFloor(id, publishCoin, "Set a target of at least 333.34\u00a0SUI.");
    await belowFloor(id, createSale, "Set a target of at least 333.34\u00a0SUI.");
    publication = { digest, kindProof, timestampMs: Date.now() };
    await ok(await plan(id, createSale), 200, "create-publish-plan");
    price.as_of_ms -= 120_001;
    await belowFloor(id, publishCoin, "Wait for a price or choose another raise coin.");
    await ok(await plan(id, createSale), 200, "create-publish-plan");
    await ok(await save(id, 1, { ...draft, target: 292.39 }), 200, "create-draft-response");
    await belowFloor(id, createSale, "Wait for a price or choose another raise coin.", 2);
    price = { usd_price: "3.43", as_of_ms: Date.now() };
    const updated = await ok<CreatePublishPlan>(await plan(id, publishCoin, 2), 200, "create-publish-plan");
    const updatedTerms = updated.steps[0]!.transaction!;
    assert.equal(await coinKindProof(updatedTerms), kindProof);
    assert.notEqual(await Transaction.from(updatedTerms).getDigest(), digest);
    price.as_of_ms -= 120_001;

    await ok(await save(legacyId, 0, draft), 201, "create-draft-response");
    await belowFloor(legacyId, createSale, "Wait for a price or choose another raise coin.");
    // Old server issues a publication for a draft created after migration.
    publication = { digest: PUBLISHED_OBJECT_DIGEST, kindProof, timestampMs: Date.now() };
    await ok(await plan(legacyId, createSale), 200, "create-publish-plan");
    await admin.query("UPDATE social_presale_raise_floor_rollout SET legacy_until = statement_timestamp() WHERE legacy_until IS NULL");
    await admin.query("DELETE FROM social_presale_publish_approvals WHERE digest = $1", [PUBLISHED_OBJECT_DIGEST]);
    await ok(await plan(legacyId, createSale), 200, "create-publish-plan");
    publication = { ...publication, digest: "started-after-cutoff", timestampMs: Date.now() + 60_000 };
    await belowFloor(legacyId, createSale, "Wait for a price or choose another raise coin.");

    const sponsoredDigest = "8sDLT2eKfTQTPUqt3knVFLNvMdBG7fRFE7dPx2djsQMZ";
    await admin.query(`INSERT INTO presale_sponsor_reservations
      (privy_did, sender, intent, pool_reservation_id, tx_bytes, digest, gas_budget, expires_at, pool_deadline, state, created_at)
      SELECT $1, $2, 'create', '718', $3, $4, 20000000, legacy_until + interval '1 minute',
        legacy_until + interval '10 seconds', 'reserved', legacy_until
      FROM social_presale_raise_floor_rollout`,
    [did, creator, Buffer.from([1]), sponsoredDigest]);
    publication = { ...publication, digest: sponsoredDigest };
    await ok(await plan(legacyId, createSale), 200, "create-publish-plan");
  }));

test("upload-to-publish: processed images, real coin bytecode, registration, presale terms and saved cover", { skip }, () =>
  withDatabase(async ({ withStore, routesWith, logos, admin }) => {
    const { did, wallet: creator } = ACCOUNTS.kai;
    const id = uuid(0xe4);
    const draft = { ...suiDraft(), tagline: "A small coin", site: "example.com" };
    await ok(await withStore.draft.PUT(request(did, path(id), { method: "PUT", json: { version: 0, draft } }), testClient()), 201, "create-draft-response");
    const uploaded = await ok<CreateDraftResponse>(await withStore.logo.PUT(request(did, `${path(id)}/logo`, { method: "PUT", headers: { "content-type": "image/png" }, body: new Uint8Array(PNG) }), testClient()), 200, "create-draft-response");
    assert.ok(uploaded.logo_url?.endsWith(".webp"));
    const { default: sharp } = await import("sharp");
    assert.deepEqual(await sharp([...logos.values()][0]).metadata().then(({ width, height, format }) => ({ width, height, format })), { width: 512, height: 512, format: "webp" });
    const cover = await sharp({ create: { width: 256, height: 128, channels: 3, background: "pink" } }).png().toBuffer();
    const form = new FormData();
    form.set("cover", new Blob([new Uint8Array(cover)], { type: "image/png" }));
    const saved = await ok<CreateDraftResponse>(await withStore.cover.POST(request(did, `${path(id)}/cover`, { method: "POST", body: form }), testClient()), 200, "create-draft-response");
    const witness = normalizeStructTag(`${MAINNET.presale.migrators.originalPackageId}::${draft.venue}::Venue`);
    const publishing = routesWith({ deployment: () => ({ status: "ready", identity: MAINNET }), authorize: async () => MAINNET, template: coinTemplate, creationPolicy: async () => ({ quotes: [CREATE_SUI_QUOTE_TYPE], witnesses: [witness] }) });
    const plan = async (step: string, coin?: unknown) => ok<CreatePublishPlan>(await publishing.publish.POST(request(did, `${path(id)}/publish`, { method: "POST", json: { version: saved.version, creator, step, ...(coin ? { coin } : {}) } }), testClient()), 200, "create-publish-plan");
    const publication = Transaction.from((await plan("publish_coin")).steps[0]!.transaction!);
    const bytecode = publication.getData().commands[0]!.Publish!.modules[0]!;
    const coinModule = deserialize(fromBase64(bytecode));
    assert.deepEqual(coinModule.constant_pool[3].data, [...bcs.string().serialize(uploaded.logo_url!).toBytes()], "on-chain icon is the processed public URL");
    assert.deepEqual(coinModule.constant_pool[4].data, [draft.decimals], "the sale coin uses the draft's decimal precision");
    assert.ok(coinModule.identifiers.includes("sealed_treasury_cap"));
    assert.equal(publication.getData().sender, creator);
    assert.equal(publication.getData().commands[1]!.MoveCall!.function, "make_immutable");
    const coinType = `${wallet("c01")}::drif::DRIF`;
    const registration = Transaction.from((await plan("register_currency", { coin_type: coinType, currency: { object_id: wallet("cc"), version: "12", digest: PUBLISHED_OBJECT_DIGEST } })).steps[0]!.transaction!);
    assert.equal(registration.getData().commands[0]!.MoveCall!.function, "finalize_registration");
    const presale = Transaction.from((await plan("create_presale", { coin_type: coinType, sealed_treasury_cap: SEALED_TREASURY_CAP, currency: { object_id: wallet("cd"), initial_shared_version: "13" } })).steps[0]!.transaction!);
    assert.ok(presale.getData().inputs.some((input) =>
      input.$kind === "Object" && input.Object.$kind === "ImmOrOwnedObject" &&
      input.Object.ImmOrOwnedObject.objectId === SEALED_TREASURY_CAP.object_id,
    ));
    assert.ok(presale.getData().commands.some((command) => command.MoveCall?.function === "finalize"));
    assert.ok(presale.getData().commands.some((command) => command.MoveCall?.function === "share"));
    await ok(await withStore.published.POST(request(did, `${path(id)}/published`, { method: "POST", json: { presale_id: KAI_SALE } }), testClient()), 200, "sale-metadata-response");
    const row = (await admin.query("SELECT published_presale_id FROM social_presale_drafts WHERE draft_id = $1", [id])).rows[0];
    assert.equal(row.published_presale_id, KAI_SALE);
    const metadata = (await admin.query("SELECT cover_url FROM social_sale_metadata WHERE presale_id = $1", [KAI_SALE])).rows[0];
    assert.equal(metadata.cover_url, saved.cover?.url);
  }));

test("R3-42-AC-1/5: the draft answer lists the coins a sale can raise: normal quotes with SUI only when its price is known", { skip }, () =>
  withDatabase(async ({ admin, routes, routesWith, suiPrice }) => {
    const { did } = ACCOUNTS.kai;
    const id = uuid(0xe1);
    // No price source at all: non-SUI quotes, nothing to convert at.
    const plain = await ok<CreateDraftResponse>(await routes.draft.PUT(request(did, path(id), { method: "PUT", json: { version: 0, draft: named("Meridian") } }), testClient()), 201, "create-draft-response");
    assert.deepEqual([plain.quotes, plain.sui_price], [[CREATE_QUOTE_TYPE, CREATE_USDSUI_QUOTE_TYPE, CREATE_WAL_QUOTE_TYPE, CREATE_DEEP_QUOTE_TYPE, CREATE_HASHI_BTC_QUOTE_TYPE, CREATE_TEST_SUI_QUOTE_TYPE], null]);
    const priced = routesWith({ quotePrice: suiPrice });
    // A source but no SUI row: still non-SUI quotes.
    const none = await ok<CreateDraftResponse>(await priced.draft.GET(request(did, path(id)), testClient()), 200, "create-draft-response");
    assert.deepEqual([none.quotes, none.sui_price], [[CREATE_QUOTE_TYPE, CREATE_USDSUI_QUOTE_TYPE, CREATE_WAL_QUOTE_TYPE, CREATE_DEEP_QUOTE_TYPE, CREATE_HASHI_BTC_QUOTE_TYPE, CREATE_TEST_SUI_QUOTE_TYPE], null]);
    await admin.query("INSERT INTO blast_infra_fixture.prices (coin_type, usd_price, as_of_ms, source) VALUES ($1, 3.42, $2, 'pyth')", [CREATE_SUI_QUOTE_TYPE, SUI_AS_OF]);
    const read = await ok<CreateDraftResponse>(await priced.draft.GET(request(did, path(id)), testClient()), 200, "create-draft-response");
    assert.deepEqual(read.quotes, [CREATE_SUI_QUOTE_TYPE, CREATE_QUOTE_TYPE, CREATE_USDSUI_QUOTE_TYPE, CREATE_WAL_QUOTE_TYPE, CREATE_DEEP_QUOTE_TYPE, CREATE_HASHI_BTC_QUOTE_TYPE, CREATE_TEST_SUI_QUOTE_TYPE]);
    assert.deepEqual(read.sui_price, { usd_price: "3.42", as_of_ms: SUI_AS_OF });
    // A read that fails answers non-SUI quotes, never a guessed rate.
    const failing = routesWith({ quotePrice: () => readSuiQuotePrice({ read: async () => { throw new Error("replica down"); } }) });
    const down = await ok<CreateDraftResponse>(await failing.draft.GET(request(did, path(id)), testClient()), 200, "create-draft-response");
    assert.deepEqual([down.quotes, down.sui_price], [[CREATE_QUOTE_TYPE, CREATE_USDSUI_QUOTE_TYPE, CREATE_WAL_QUOTE_TYPE, CREATE_DEEP_QUOTE_TYPE, CREATE_HASHI_BTC_QUOTE_TYPE, CREATE_TEST_SUI_QUOTE_TYPE], null]);
  }));

test("R3-42-AC-3: a SUI draft saves and reloads as it was: the coin and its figures, never converted again", { skip }, () =>
  withDatabase(async ({ admin, routesWith, suiPrice }) => {
    const { did } = ACCOUNTS.kai;
    const id = uuid(0xe2);
    const priced = routesWith({ quotePrice: suiPrice });
    await admin.query("INSERT INTO blast_infra_fixture.prices (coin_type, usd_price, as_of_ms, source) VALUES ($1, 3.42, $2, 'pyth')", [CREATE_SUI_QUOTE_TYPE, SUI_AS_OF]);
    const saved = await ok<CreateDraftResponse>(await priced.draft.PUT(request(did, path(id), { method: "PUT", json: { version: 0, draft: suiDraft() } }), testClient()), 201, "create-draft-response");
    assert.deepEqual(saved.draft, suiDraft());
    // The price moves; the saved figures do not.
    await admin.query("UPDATE blast_infra_fixture.prices SET usd_price = 4.10 WHERE coin_type = $1", [CREATE_SUI_QUOTE_TYPE]);
    const reloaded = await ok<CreateDraftResponse>(await priced.draft.GET(request(did, path(id)), testClient()), 200, "create-draft-response");
    assert.deepEqual(reloaded.draft, suiDraft());
    assert.equal(reloaded.sui_price?.usd_price, "4.10");
    const column = (await admin.query("SELECT quote_type FROM social_presale_drafts WHERE draft_id = $1", [id])).rows[0];
    assert.deepEqual(column, { quote_type: CREATE_SUI_QUOTE_TYPE });
    // Its checks read in SUI.
    const resaved = await ok<CreateDraftResponse>(await priced.draft.PUT(request(did, path(id), { method: "PUT", json: { version: 1, draft: { ...suiDraft(), max_wallets: 10 } } }), testClient()), 200, "create-draft-response");
    assert.ok(resaved.issues.some((issue) => issue.path === "reach" && issue.message === "At the minimum, 10 wallets raise only 30 SUI"), JSON.stringify(resaved.issues));
  }));

for (const { quoteType, symbol, decimals } of [
  { quoteType: CREATE_SUI_QUOTE_TYPE, symbol: "SUI", decimals: 9 },
  { quoteType: CREATE_USDSUI_QUOTE_TYPE, symbol: "USDsui", decimals: 6 },
  { quoteType: CREATE_WAL_QUOTE_TYPE, symbol: "WAL", decimals: 9 },
]) {
test(`publishing a ${symbol} draft requires policy approval and uses its quote and decimals`, { skip }, () =>
  withDatabase(async ({ routesWith }) => {
    const { did } = ACCOUNTS.kai;
    const id = uuid(0xe3);
    const draft = { ...suiDraft(), quote_type: quoteType };
    const witness = normalizeStructTag(`${MAINNET.presale.migrators.originalPackageId}::${draft.venue}::Venue`);
    const publishing = (quotes: readonly string[], witnesses: readonly string[] = [witness], unreadable = false) =>
      routesWith({
        deployment: () => ({ status: "ready", identity: MAINNET }),
        authorize: async () => MAINNET,
        template: { bytecode: async () => ({ modules: [], dependencies: [] }) },
        creationPolicy: async () => unreadable ? null : { quotes, witnesses },
      });
    const created = await ok<CreateDraftResponse>(await publishing([]).draft.PUT(request(did, path(id), { method: "PUT", json: { version: 0, draft } }), testClient()), 201, "create-draft-response");
    assert.deepEqual(created.issues, []);
    const step = {
      version: 1,
      step: "create_presale",
      creator: ACCOUNTS.kai.wallet,
      coin: { coin_type: `${wallet("c01")}::drft::DRFT`, sealed_treasury_cap: SEALED_TREASURY_CAP, currency: { object_id: wallet("cc"), initial_shared_version: "12" } },
    };
    const publish = (quotes: readonly string[]) => publishing(quotes).publish.POST(request(did, `${path(id)}/publish`, { method: "POST", json: step }), testClient());
    // A policy that admits USDC only refuses this sale, naming why, and builds nothing.
    const refused = await refusal(await publish([CREATE_QUOTE_TYPE]), 409, "publish_unavailable");
    assert.deepEqual(refused.reasons, ["creation_policy"]);
    assert.equal(refused.contract_error, "EQuoteNotAllowed");
    const venueRefused = await refusal(await publishing([quoteType], []).publish.POST(request(did, `${path(id)}/publish`, { method: "POST", json: step }), testClient()), 409, "publish_unavailable");
    assert.equal(venueRefused.contract_error, "EMigrationWitnessNotAllowed");
    const unavailable = await refusal(await publishing([], [], true).publish.POST(request(did, `${path(id)}/publish`, { method: "POST", json: step }), testClient()), 409, "publish_unavailable");
    assert.deepEqual(unavailable.reasons, ["creation_policy"]);
    assert.equal(unavailable.contract_error, undefined, "an RPC outage must not be reported as a delisted coin");
    // An admitted quote types the venue call and determines the atom precision.
    const response = await publish([CREATE_QUOTE_TYPE, quoteType]);
    const plan = (await response.json()) as CreatePublishPlan;
    assert.equal(response.status, 200, JSON.stringify(plan));
    assert.equal(plan.steps[0]!.kind, "create_presale");
    assert.deepEqual(plan.steps[0]!.presale_package, {
      package_id: MAINNET.presale.packageId,
      original_package_id: MAINNET.presale.originalPackageId,
      core_original_package_id: MAINNET.presale.core.originalPackageId,
      venue: draft.venue,
    });
    assert.ok(plan.steps[0]!.transaction);
    const data = JSON.parse(plan.steps[0]!.transaction) as { commands: Array<{ MoveCall?: { module: string; function: string; typeArguments: string[] } }>; inputs: Array<{ Pure?: { bytes: string } }> };
    const calls = data.commands.flatMap((command) => (command.MoveCall ? [command.MoveCall] : []));
    const venue = calls.find((call) => call.module === draft.venue && call.function === "prepare")!;
    assert.ok(venue, JSON.stringify(calls.map((call) => `${call.module}::${call.function}`)));
    assert.ok(venue.typeArguments.map((type) => normalizeStructTag(type)).includes(quoteType), JSON.stringify(venue.typeArguments));
    assert.ok(!calls.some((call) => call.typeArguments.map((type) => normalizeStructTag(type)).includes(CREATE_QUOTE_TYPE)), "no call is typed by USDC");
    // The target is encoded at the selected quote’s precision.
    const u64 = (value: bigint) => Buffer.from(new BigUint64Array([value]).buffer).toString("base64");
    assert.ok(data.inputs.some((input) => input.Pure?.bytes === u64(120_000n * 10n ** BigInt(decimals))), "the target is in the quote coin’s atoms");
  }));

}


test("listed TEST_SUI saves and publishes through the normal quote policy; absent quotes are refused", { skip }, () =>
  withDatabase(async ({ routesWith }) => {
    const { did, wallet: creator } = ACCOUNTS.kai;
    const id = uuid(0xe4);
    const witness = normalizeStructTag(`${MAINNET.presale.migrators.originalPackageId}::bluefin::Venue`);
    const routes = (admitted: boolean) => routesWith({
      deployment: () => ({ status: "ready", identity: MAINNET }),
      authorize: async () => MAINNET,
      template: coinTemplate,
      creationPolicy: async () => ({ quotes: admitted ? [CREATE_TEST_SUI_QUOTE_TYPE] : [], witnesses: [witness] }),
    });
    const draft = { ...suiDraft(), quote_type: CREATE_TEST_SUI_QUOTE_TYPE, venue: "bluefin", pool_fee: 10_000 };
    const save = (admitted: boolean, version: number, body = draft) => routes(admitted).draft.PUT(request(did, path(id), { method: "PUT", json: { version, draft: body } }), testClient());
    const saved = await ok<CreateDraftResponse>(await save(true, 0), 201, "create-draft-response");
    assert.ok(saved.quotes.includes(CREATE_TEST_SUI_QUOTE_TYPE));
    assert.deepEqual(saved.issues, []);
    const step = { version: 1, step: "create_presale", creator, coin: { coin_type: `${wallet("c01")}::drft::DRFT`, sealed_treasury_cap: SEALED_TREASURY_CAP, currency: { object_id: wallet("cc"), initial_shared_version: "12" } } };
    const publish = (admitted: boolean, version: number) => routes(admitted).publish.POST(request(did, `${path(id)}/publish`, { method: "POST", json: { ...step, version } }), testClient());
    const refused = await refusal(await publish(false, 1), 409, "publish_unavailable");
    assert.deepEqual(refused.reasons, ["creation_policy"]);
    assert.equal(refused.contract_error, "EQuoteNotAllowed");
    const plan = await ok<CreatePublishPlan>(await publish(true, 1), 200, "create-publish-plan");
    const data = JSON.parse(plan.steps[0]!.transaction!) as { commands: Array<{ MoveCall?: { module: string; function: string; typeArguments: string[] } }> };
    const calls = data.commands.flatMap((command) => command.MoveCall ? [command.MoveCall] : []);
    assert.ok(calls.some((call) => call.module === "bluefin" && call.function === "prepare" && call.typeArguments.includes(CREATE_TEST_SUI_QUOTE_TYPE)));
  }));

test("sponsored publish preserves budget reasons and retry timing instead of reporting an outage", { skip }, () =>
  withDatabase(async ({ routesWith }) => {
    const id = uuid(0xe6);
    let failure: Error = new PresaleRouteError("budget_exceeded", { extra: { reason: "daily_limit" }, retryAfterSeconds: 3600 });
    const routes = routesWith({
      deployment: () => ({ status: "ready", identity: MAINNET }), authorize: async () => MAINNET,
      creationPolicy: async () => ({ quotes: [CREATE_SUI_QUOTE_TYPE], witnesses: [normalizeStructTag(`${MAINNET.presale.migrators.originalPackageId}::cetus::Venue`)] }),
      template: coinTemplate,
      sponsorCreation: async () => { throw failure; },
    });
    await ok(await routes.draft.PUT(request(ACCOUNTS.kai.did, path(id), { method: "PUT", json: { version: 0, draft: suiDraft() } }), testClient()), 201, "create-draft-response");
    const publish = () => routes.publish.POST(request(ACCOUNTS.kai.did, `${path(id)}/publish`, {
      method: "POST", json: { version: 1, step: "publish_coin", creator: ACCOUNTS.kai.wallet, fee: "sponsored" },
    }), testClient());
    for (const error of [
      failure,
      new PresaleRouteError("budget_exceeded", { extra: { reason: "open_reservations" }, retryAfterSeconds: 30 }),
      new PresaleRouteError("rate_limited", { retryAfterSeconds: 60 }),
    ]) {
      failure = error;
      assert.ok(error instanceof PresaleRouteError);
      const response = await publish();
      const body = await refusal(response, 429, "rate_limited");
      assert.equal(body.reason, error.extra.reason);
      assert.equal(response.headers.get("Retry-After"), String(error.retryAfterSeconds));
    }
    failure = new Error("sponsor node unavailable");
    await refusal(await publish(), 503, "service_unavailable");
    const draft = await ok<CreateDraftResponse>(await routes.draft.GET(request(ACCOUNTS.kai.did, path(id)), testClient()), 200, "create-draft-response");
    assert.equal(draft.version, 1);
    assert.deepEqual(draft.draft, suiDraft());
  }));

test("owned draft plans sponsor embedded creation; wallet plans and invalid drafts never request sponsorship", { skip }, async () => {
  await withDatabase(async ({ routesWith }) => {
    const id = uuid(0xe5);
    const identity = MAINNET;
    const calls: string[] = [];
    const routes = routesWith({
      deployment: () => ({ status: "ready", identity }), authorize: async () => identity,
      creationPolicy: async () => ({ quotes: [CREATE_SUI_QUOTE_TYPE], witnesses: [normalizeStructTag(`${identity.presale.migrators.originalPackageId}::cetus::Venue`)] }),
      template: coinTemplate,
      async sponsorCreation({ transaction, caller, sender }) {
        assert.equal(caller.kind === "privy" && caller.did, ACCOUNTS.kai.did); assert.equal(sender, ACCOUNTS.kai.wallet);
        assert.equal(transaction.getData().commands[0]?.$kind, "Publish");
        calls.push(caller.kind === "privy" ? caller.did : caller.address);
        const kind = await transaction.build({ onlyTransactionKind: true });
        const bytes = bcs.TransactionData.serialize({ V1: { kind: bcs.TransactionKind.parse(kind), sender, gasData: { owner: wallet("5b"), price: "750", budget: "20000000", payment: [] }, expiration: { None: true } } }).toBytes();
        return { reservation_id: uuid(0xf1), transaction_bytes: Buffer.from(bytes).toString("base64") };
      },
    });
    await ok(await routes.draft.PUT(request(ACCOUNTS.kai.did, path(id), { method: "PUT", json: { version: 0, draft: suiDraft() } }), testClient()), 201, "create-draft-response");
    const body = { version: 1, step: "publish_coin", creator: ACCOUNTS.kai.wallet, fee: "sponsored" };
    const plan = await ok<CreatePublishPlan>(await routes.publish.POST(request(ACCOUNTS.kai.did, `${path(id)}/publish`, { method: "POST", json: body }), testClient()), 200, "create-publish-plan");
    assert.ok(plan.steps[0]?.sponsorship); assert.equal(calls.length, 1);
    const walletPlan = await ok<CreatePublishPlan>(await routes.publish.POST(request(ACCOUNTS.kai.did, `${path(id)}/publish`, { method: "POST", json: { ...body, fee: "wallet" } }), testClient()), 200, "create-publish-plan");
    assert.equal(walletPlan.steps[0]?.sponsorship, undefined); assert.equal(calls.length, 1);
    const bad = await routes.publish.POST(request(ACCOUNTS.kai.did, `${path(id)}/publish`, { method: "POST", json: { ...body, creator: ACCOUNTS.mira.wallet } }), testClient());
    assert.equal(bad.status, 400); assert.equal(calls.length, 1);
  });
});

for (const scenario of ["cetus-quote", "cetus-spacing", "bluefin-range"] as const) {
  test(`publish rechecks live venue compatibility: ${scenario}`, { skip }, () => withDatabase(async ({ routesWith }) => {
    const id = uuid(0xfa);
    const draft = { ...suiDraft(), venue: scenario === "bluefin-range" ? "bluefin" : "cetus" } as const;
    const witness = normalizeStructTag(`${MAINNET.presale.migrators.originalPackageId}::${draft.venue}::Venue`);
    let supported = true;
    let bytecodeReads = 0;
    const routes = routesWith({
      deployment: () => ({ status: "ready", identity: MAINNET }),
      authorize: async () => MAINNET,
      creationPolicy: async () => ({ quotes: [draft.quote_type], witnesses: [witness] }),
      template: { bytecode: async () => { bytecodeReads++; return { modules: [], dependencies: [] }; } },
      cetusTiers: async () => supported ? { [draft.quote_type]: [[200, 10_000]] } : scenario === "cetus-quote" ? {} : { [draft.quote_type]: [[60, 3_000]] },
      bluefinOptions: async () => ({ status: "ready", min_tick: supported ? -443_636 : -10, max_tick: supported ? 443_636 : 10 }),
    });
    const created = await ok<CreateDraftResponse>(await routes.draft.PUT(request(ACCOUNTS.kai.did, path(id), { method: "PUT", json: { version: 0, draft } }), testClient()), 201, "create-draft-response");
    assert.deepEqual(created.issues, []);
    supported = false;
    const restored = await ok<CreateDraftResponse>(await routes.draft.GET(request(ACCOUNTS.kai.did, path(id)), testClient()), 200, "create-draft-response");
    assert.deepEqual(restored.draft, draft);
    const expectedIssue = scenario === "bluefin-range" ? { section: "raise", path: "pool_fee" } : { section: "launch", path: "venue" };
    assert.deepEqual(restored.issues.map(({ section, path }) => ({ section, path })), [expectedIssue]);
    await refusal(await routes.publish.POST(request(ACCOUNTS.kai.did, `${path(id)}/publish`, { method: "POST", json: { version: 1, step: "publish_coin", creator: ACCOUNTS.kai.wallet, fee: "wallet" } }), testClient()), 422, "draft_incomplete");
    assert.equal(bytecodeReads, 0);
  }));
}
