import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import {
  FIXTURE_CANCELLED_PRESALE_ID,
  FIXTURE_PRESALE_ID,
  FIXTURE_QUOTE_TYPE,
  rebuildChainRead,
  seedChainRead,
} from "../../../../../../packages/core/test/fixtures/modules/database/chain-read-rows.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../../packages/core/test/fixtures/modules/database/template.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { SOCIAL_CONFIG_DEFAULTS } from "@blast/core/modules/social/contracts/config.ts";
import type { SocialPresaleDetail, SocialPresaleListPage } from "@blast/core/modules/social/contracts/presales.ts";
import type { SocialSaleMetadataResponse } from "@blast/core/modules/social/contracts/sales.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { SOCIAL_WALLET_SESSION_COOKIE } from "@blast/core/modules/social/contracts/wallet-sign-in.ts";
import { readPresaleListPage, readPresalePage } from "@blast/server/modules/social/presales/route.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import type { SaleCoverStore } from "@blast/server/modules/social/sales/cover.ts";
import { createSocialSaleRoutes } from "@blast/server/modules/social/sales/route.ts";
import { uuid } from "../../../../../../packages/core/test/kit.ts";

/**
 * R3-24: the sale details routes over migration 0090 as the web runtime role
 * `blast_web`, with a real Privy token verifier over a fixture ES256 key, a
 * wallet session for a Slush-only creator, the Postgres rate limiter, the
 * fixture `chain_read_v1`, an injected editor (the cap holder per sale) and
 * an injected cover store standing in for the Blob store, whose token
 * (`LAUNCH_ASSET_BLOB_READ_WRITE_TOKEN`) does not exist here. The public
 * reads run as `blast_replica`; the operator commands run through the CLI.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
/** The running test's own database; `withFixture` sets it. */
let testDatabaseUrl: string | null = null;
const ORIGIN = "https://blast.fun";
const APP_ID = "social-sales-app";
const PEPPER = "social-sales-fixture-pepper-0123456789abcdef";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const verificationKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 8, statementTimeoutMs: 5_000 };
const PRIVATE = "private, no-store";

const wallet = (tag: string) => `0x${tag.padStart(64, "0")}`;
const ACCOUNTS = {
  kai: { id: uuid(0x24a1), did: "did:privy:sales-kai", callsign: "sales_kai", wallet: wallet("24a1") },
  mira: { id: uuid(0x24a2), did: "did:privy:sales-mira", callsign: "sales_mira", wallet: wallet("24a2") },
} as const;
/** A Slush-only account: its wallet is its sign-in (OA-16). */
const SLY = { id: uuid(0x24a3), callsign: "sales_sly", wallet: wallet("24a3") };
const SLY_COOKIE = "s".repeat(43);
/** An open sale Sly created, and one whose coin metadata blast-infra has not seen (not shown). */
const SLY_PRESALE = wallet("51e5a1e");
const HIDDEN_PRESALE = wallet("41dde4");
/** Who holds each sale's cap. */
const EDITORS: Readonly<Record<string, string>> = {
  [FIXTURE_PRESALE_ID]: ACCOUNTS.kai.wallet,
  [FIXTURE_CANCELLED_PRESALE_ID]: ACCOUNTS.kai.wallet,
  [HIDDEN_PRESALE]: ACCOUNTS.kai.wallet,
  [SLY_PRESALE]: SLY.wallet,
};
const BLOCKED = "rugpull";

const NOW_S = Math.floor(Date.now() / 1_000);
function bearer(did: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: NOW_S + 3_600, iat: NOW_S - 60, iss: "privy.io", sid: "s-1", sub: did });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `Bearer ${header}.${payload}.${signature.toString("base64url")}`;
}

type Who = "kai" | "mira" | "sly" | null;

function authHeaders(who: Who): Record<string, string> {
  if (who === "sly") return { cookie: `${SOCIAL_WALLET_SESSION_COOKIE}=${SLY_COOKIE}`, "sec-fetch-site": "same-origin", origin: ORIGIN };
  return who ? { authorization: bearer(ACCOUNTS[who].did) } : {};
}

type Routes = ReturnType<typeof createSocialSaleRoutes>;
type Fixture = Readonly<{
  admin: Pool;
  replica: Pool;
  objects: Map<string, Buffer>;
  removed: string[];
  put(who: Who, presaleId: string, body: unknown): Promise<Response>;
  get(who: Who, presaleId: string): Promise<Response>;
  upload(who: Who, presaleId: string, bytes: Uint8Array, type: string): Promise<Response>;
  remove(who: Who, presaleId: string): Promise<Response>;
  storeless: Routes;
}>;

async function multipart(url: string, headers: Record<string, string>, bytes: Uint8Array, type: string): Promise<Request> {
  const form = new FormData();
  form.set("cover", new File([new Uint8Array(bytes)], "cover", { type }));
  const encoded = new Response(form);
  const body = new Uint8Array(await encoded.arrayBuffer());
  return new Request(url, {
    method: "POST",
    body,
    headers: { ...headers, "content-type": encoded.headers.get("content-type")!, "content-length": String(body.byteLength) },
  });
}

async function withFixture(run: (fixture: Fixture) => Promise<void>, options: Readonly<{ metricSampleRate?: number }> = {}): Promise<void> {
  const database = await freshTestDatabase();
  const { url } = database;
  testDatabaseUrl = url;
  const admin = createPool(url, { max: 4 });
  await rebuildChainRead(admin);
  const sale = (presaleId: string, symbol: string, metadata: boolean) => ({
    presale_id: presaleId, sale_token: `${presaleId}::coin::${symbol}`, quote_type: FIXTURE_QUOTE_TYPE,
    sale_symbol: metadata ? symbol : null, sale_name: metadata ? symbol : null, sale_icon_url: metadata ? `https://i/${symbol}.png` : null,
    sale_decimals: metadata ? 9 : null, quote_symbol: "SUI", quote_decimals: 9, lifecycle: "open" as const,
    start_ms: Date.now() - 3_600_000, end_ms: Date.now() + 86_400_000, raise_target: "1000000000000", min_commitment: "1000000000",
    wallet_cap: "100000000000", total_commitments: "0", participants: 0, venue: "cetus" as const, pool_id: null, updated_checkpoint: 1_000,
  });
  await seedChainRead(admin, { presales: [sale(SLY_PRESALE, "SLY", true), sale(HIDDEN_PRESALE, "HID", false)] });
  for (const account of Object.values(ACCOUNTS)) {
    await admin.query(
      `INSERT INTO social_accounts (account_id, privy_did, callsign, onboarding_shown_at, onboarded_at, privacy, sharing_since)
       VALUES ($1, $2, $3, now(), now(), 'public', now())`,
      [account.id, account.did, account.callsign],
    );
    await admin.query("INSERT INTO social_account_wallets (address, account_id, kind, verified_at) VALUES ($1, $2, 'external', now())", [account.wallet, account.id]);
  }
  await admin.query(
    `INSERT INTO social_accounts (account_id, sui_address, callsign, onboarding_shown_at, onboarded_at, privacy, sharing_since)
     VALUES ($1, $2, $3, now(), now(), 'public', now())`,
    [SLY.id, SLY.wallet, SLY.callsign],
  );
  await admin.query("INSERT INTO social_account_wallets (address, account_id, kind, verified_at) VALUES ($1, $2, 'slush', now())", [SLY.wallet, SLY.id]);
  const web = createRuntimePool(urlAs(url, "blast_web"), POOL, "social-sales-web");
  const replica = createRuntimePool(urlAs(url, "blast_replica"), POOL, "social-sales-replica");
  try {
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey }),
      limiter: new PostgresRateLimitEnforcer({ pool: web, subjectPepper: PEPPER }),
      accounts: new PostgresSocialAccounts(() => web),
      walletSessions: { live: async (token) => (token === SLY_COOKIE ? { address: SLY.wallet } : null) },
      primary: () => web,
      metricSampleRate: options.metricSampleRate ?? 0,
    });
    const objects = new Map<string, Buffer>();
    const removed: string[] = [];
    const store: SaleCoverStore = {
      async write(pathname, bytes) {
        objects.set(pathname, bytes);
        return { url: `https://blob.example/${pathname}` };
      },
      async remove(url) {
        removed.push(url);
        objects.delete(url.replace("https://blob.example/", ""));
      },
    };
    const routes = (target: SaleCoverStore | null) => createSocialSaleRoutes({
      kit,
      findBlockedTerm: async (text) => (text.toLowerCase().includes(BLOCKED) ? BLOCKED : null),
      editor: async (presaleId) => EDITORS[presaleId] ?? null,
      store: () => target,
      database: () => autocommitReader(web, "social", { label: "social.sales-test" }),
    });
    const withStore = routes(store);
    const base = { "x-forwarded-for": "203.0.113.24" };
    const url = (presaleId: string, part: "metadata" | "cover") => `${ORIGIN}/api/social/sales/${presaleId}/${part}`;
    await run({
      admin,
      replica,
      objects,
      removed,
      storeless: routes(null),
      put: (who, presaleId, body) => withStore.metadata.PUT(new Request(url(presaleId, "metadata"), {
        method: "PUT",
        headers: { ...base, origin: ORIGIN, ...authHeaders(who), "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }), testClient()),
      get: (who, presaleId) => withStore.metadata.GET(new Request(url(presaleId, "metadata"), { headers: { ...base, ...authHeaders(who) } }), testClient()),
      upload: async (who, presaleId, bytes, type) =>
        withStore.cover.POST(await multipart(url(presaleId, "cover"), { ...base, origin: ORIGIN, ...authHeaders(who) }, bytes, type), testClient()),
      remove: (who, presaleId) => withStore.cover.DELETE(new Request(url(presaleId, "cover"), {
        method: "DELETE",
        headers: { ...base, origin: ORIGIN, ...authHeaders(who) },
      }), testClient()),
    });
  } finally {
    await Promise.all([web.end(), replica.end(), admin.end()]);
    await database.drop();
    testDatabaseUrl = null;
  }
}

async function answer(response: Response, status: number): Promise<SocialSaleMetadataResponse> {
  const body: unknown = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.deepEqual(validator.validate("sale-metadata-response", body).errors, []);
  assert.equal(response.headers.get("cache-control"), PRIVATE);
  return body as SocialSaleMetadataResponse;
}

async function refused(response: Response, status: number, code: string): Promise<Record<string, unknown>> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error.code, code);
  assert.deepEqual(validator.validate("error", body).errors, []);
  assert.equal(response.headers.get("cache-control"), PRIVATE);
  return body.error;
}

async function edits(db: Pool, presaleId: string): Promise<{ account_id: string | null; operator_id: string | null; before: Record<string, unknown> }[]> {
  return (await db.query(
    "SELECT account_id::text, operator_id, before FROM social_sale_metadata_edits WHERE presale_id = $1 ORDER BY edit_id",
    [presaleId],
  )).rows;
}

const TAGLINE = "🚀".repeat(120);
const FULL = {
  tagline: TAGLINE,
  site: "meridian.finance",
  x_handle: "https://x.com/@meridianfx",
  telegram: "t.me/meridianfx",
  docs_url: "https://docs.meridian.finance/intro#top",
  audit_url: "http://audits.example/meridian.pdf",
};
const STORED = {
  tagline: TAGLINE,
  site: "https://meridian.finance",
  x_handle: "meridianfx",
  telegram: "meridianfx",
  docs_url: "https://docs.meridian.finance/intro",
  audit_url: "https://audits.example/meridian.pdf",
  cover: null,
  launch_at_ms: null,
};

async function image(width: number, height: number, format: "png" | "jpeg" | "webp", colour = "#d61b70"): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp({ create: { width, height, channels: 3, background: colour } })[format]().toBuffer();
}

test("R3-24-AC-1: the creator writes every field and reads them back on the sale payloads; the same write twice stores one edit", { skip }, () =>
  withFixture(async ({ admin, replica, put, get }) => {
    // A sale without a row: nothing stored, the public payloads say null, the creator may edit.
    const empty = await answer(await get("kai", FIXTURE_PRESALE_ID), 200);
    assert.deepEqual(empty, { presale_id: FIXTURE_PRESALE_ID, metadata: { ...STORED, ...Object.fromEntries(Object.keys(FULL).map((key) => [key, null])) }, editable: true });
    const replicaDb = autocommitReader(replica, "social", { label: "social.sales-replica" });
    const read = () => readPresalePage(replicaDb, FIXTURE_PRESALE_ID, { nowMs: Date.now(), config: SOCIAL_CONFIG_DEFAULTS, terms: async () => null });
    assert.equal((await read())!.presale.metadata, null);

    const first = await answer(await put("kai", FIXTURE_PRESALE_ID, FULL), 200);
    assert.deepEqual(first, { presale_id: FIXTURE_PRESALE_ID, metadata: STORED, editable: true });
    const again = await answer(await put("kai", FIXTURE_PRESALE_ID, FULL), 200);
    assert.deepEqual(again, first);
    const log = await edits(admin, FIXTURE_PRESALE_ID);
    assert.equal(log.length, 1, "the identical retry wrote nothing");
    assert.equal(log[0]!.account_id, ACCOUNTS.kai.id);
    assert.equal(log[0]!.before.tagline, null);

    // The public reads, on the replica, carry the details and never who wrote them.
    const detail = (await read()) as SocialPresaleDetail;
    assert.deepEqual(detail.presale.metadata, STORED);
    assert.deepEqual(validator.validate("presale-detail", detail).errors, []);
    const list = await readPresaleListPage(replicaDb, { status: "ended", sort: "recent", cursor: null, limit: 20 }, Date.now()) as SocialPresaleListPage;
    assert.deepEqual(list.presales.find((row) => row.presale_id === FIXTURE_PRESALE_ID)?.metadata, STORED);
    assert.equal(list.presales.find((row) => row.presale_id === FIXTURE_CANCELLED_PRESALE_ID)?.metadata, null);
    assert.deepEqual(validator.validate("presale-list-page", list).errors, []);
    for (const body of [detail, list]) {
      const text = JSON.stringify(body);
      assert.ok(!text.includes(ACCOUNTS.kai.id) && !text.includes("updated_by") && !text.includes("sale-covers/"));
    }

    // Each field alone; an absent field is kept, an empty one clears.
    const partial = await answer(await put("kai", FIXTURE_PRESALE_ID, { telegram: "", tagline: "Fixed-rate lending on Sui" }), 200);
    assert.deepEqual(partial.metadata, { ...STORED, telegram: null, tagline: "Fixed-rate lending on Sui" });
    assert.equal((await edits(admin, FIXTURE_PRESALE_ID)).length, 2);
    assert.deepEqual((await answer(await put("kai", FIXTURE_PRESALE_ID, { site: null }), 200)).metadata.site, null);
    // Another account reads the details but may not edit them.
    assert.equal((await answer(await get("mira", FIXTURE_PRESALE_ID), 200)).editable, false);
  }));

test("R3-24-AC-2: a non-creator is 403, a visitor 401, an unknown or unshown sale 404, a cancelled sale 409; nothing is written", { skip }, () =>
  withFixture(async ({ admin, put, get, upload, remove }) => {
    await refused(await put("mira", FIXTURE_PRESALE_ID, FULL), 403, "not_sale_creator");
    await refused(await put(null, FIXTURE_PRESALE_ID, FULL), 401, "unauthorized");
    await refused(await get(null, FIXTURE_PRESALE_ID), 401, "unauthorized");
    await refused(await put("kai", wallet("404"), FULL), 404, "not_found");
    await refused(await put("kai", HIDDEN_PRESALE, FULL), 404, "not_found");
    await refused(await get("kai", HIDDEN_PRESALE), 404, "not_found");
    await refused(await put("kai", FIXTURE_CANCELLED_PRESALE_ID, FULL), 409, "sale_cancelled");
    await refused(await put("kai", "0xnot-a-sale", FULL), 400, "invalid_parameter");
    // A cancelled sale offers no editing, even to its creator.
    assert.equal((await answer(await get("kai", FIXTURE_CANCELLED_PRESALE_ID), 200)).editable, false);
    const png = await image(1_536, 512, "png");
    await refused(await upload("mira", FIXTURE_PRESALE_ID, png, "image/png"), 403, "not_sale_creator");
    await refused(await upload("kai", FIXTURE_CANCELLED_PRESALE_ID, png, "image/png"), 409, "sale_cancelled");
    await refused(await remove("mira", FIXTURE_PRESALE_ID), 403, "not_sale_creator");
    await refused(await remove(null, FIXTURE_PRESALE_ID), 401, "unauthorized");
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_sale_metadata_edits")).rows[0].n, 0);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_sale_metadata")).rows[0].n, 0);
    // A Slush-only creator edits through its wallet session (OA-16), and Kai is not Sly's sale's creator.
    const sly = await answer(await put("sly", SLY_PRESALE, { x_handle: "@slyfx" }), 200);
    assert.equal(sly.metadata.x_handle, "slyfx");
    assert.equal((await answer(await get("sly", SLY_PRESALE), 200)).editable, true);
    await refused(await put("kai", SLY_PRESALE, { x_handle: "kai" }), 403, "not_sale_creator");
  }));

test("R3-24-AC-3 / AC-7: each refused field has its code, a pasted X URL is stored bare, and a term is 400 with nothing written", { skip }, () =>
  withFixture(async ({ admin, put }) => {
    const cases: [Record<string, unknown>, string, string][] = [
      [{ tagline: "a".repeat(121) }, "tagline_too_long", "tagline"],
      [{ tagline: "The best launch on blast.fun" }, "tagline_has_link", "tagline"],
      [{ tagline: "one\ntwo" }, "tagline_invalid", "tagline"],
      [{ tagline: `A total ${BLOCKED.toUpperCase()} of a sale` }, "blocked_term", "tagline"],
      [{ site: "ftp://x" }, "invalid_link", "site"],
      [{ docs_url: "https://user@host.example" }, "invalid_link", "docs_url"],
      [{ audit_url: "https://audits.example:8443/a.pdf" }, "invalid_link", "audit_url"],
      [{ x_handle: "a".repeat(16) }, "invalid_x_handle", "x_handle"],
      [{ telegram: "abcd" }, "invalid_telegram", "telegram"],
    ];
    for (const [body, code, field] of cases) {
      const error = await refused(await put("kai", FIXTURE_PRESALE_ID, body), 422, code);
      assert.equal(error.field, field, code);
    }
    for (const body of [{ raise_target: "1" }, { tagline: "x", wallet_cap: 5 }, { cover_key: "x" }, { launch_at_ms: 1 }, { tagline: 5 }, "[]", "not json"]) {
      await refused(await put("kai", FIXTURE_PRESALE_ID, body), 400, "invalid_request");
    }
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_sale_metadata_edits")).rows[0].n, 0);
    const stored = await answer(await put("kai", FIXTURE_PRESALE_ID, { x_handle: "https://x.com/@meridianfx" }), 200);
    assert.equal(stored.metadata.x_handle, "meridianfx");
  }));

test("R3-24-AC-4: a cover is re-encoded to 1536 × 512 WebP; over 4 MB and non-images are refused; replacing deletes the old object", { skip }, () =>
  withFixture(async ({ admin, objects, removed, upload, remove, storeless }) => {
    const { default: sharp } = await import("sharp");
    const first = await answer(await upload("kai", FIXTURE_PRESALE_ID, await image(3_000, 1_000, "png"), "image/png"), 201);
    assert.ok(first.metadata.cover);
    assert.deepEqual([first.metadata.cover.width, first.metadata.cover.height], [1_536, 512]);
    const firstKey = first.metadata.cover.url.replace("https://blob.example/", "");
    assert.match(firstKey, new RegExp(`^sale-covers/${FIXTURE_PRESALE_ID}/[0-9a-f]{64}\\.webp$`));
    const meta = await sharp(objects.get(firstKey)!).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ["webp", 1_536, 512]);

    // The same image again changes nothing; a JPEG and then a WebP each replace it, deleting the one before.
    await answer(await upload("kai", FIXTURE_PRESALE_ID, await image(3_000, 1_000, "png"), "image/png"), 201);
    assert.deepEqual(removed, []);
    const second = await answer(await upload("kai", FIXTURE_PRESALE_ID, await image(1_200, 800, "jpeg", "#123456"), "image/jpeg"), 201);
    assert.deepEqual(removed, [first.metadata.cover.url]);
    const third = await answer(await upload("kai", FIXTURE_PRESALE_ID, await image(2_000, 700, "webp", "#00aa44"), "image/webp"), 201);
    assert.deepEqual(removed, [first.metadata.cover.url, second.metadata.cover!.url]);
    assert.deepEqual([...objects.keys()], [third.metadata.cover!.url.replace("https://blob.example/", "")]);
    assert.equal((await edits(admin, FIXTURE_PRESALE_ID)).length, 3);

    // Refusals: over 4 MB (refused unread), not an image, an SVG, a tiny one, no store.
    await refused(await upload("kai", FIXTURE_PRESALE_ID, new Uint8Array(5 * 1_024 * 1_024), "image/png"), 413, "body_too_large");
    const atLimit = Buffer.alloc(4_000_001, 0xff);
    await refused(await upload("kai", FIXTURE_PRESALE_ID, atLimit, "image/jpeg"), 413, "body_too_large");
    assert.equal((await refused(await upload("kai", FIXTURE_PRESALE_ID, Buffer.from("not an image"), "image/png"), 422, "invalid_cover")).reason, "type");
    assert.equal((await refused(await upload("kai", FIXTURE_PRESALE_ID, Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/svg+xml"), 422, "invalid_cover")).reason, "type");
    assert.equal((await refused(await upload("kai", FIXTURE_PRESALE_ID, await image(300, 100, "png"), "image/png"), 422, "invalid_cover")).reason, "dimensions");
    const form = new FormData();
    form.set("cover", new File([new Uint8Array(await image(1_536, 512, "png"))], "c", { type: "image/png" }));
    const encoded = new Response(form);
    const body = new Uint8Array(await encoded.arrayBuffer());
    await refused(await storeless.cover.POST(new Request(`${ORIGIN}/api/social/sales/${FIXTURE_PRESALE_ID}/cover`, {
      method: "POST",
      body,
      headers: { origin: ORIGIN, authorization: bearer(ACCOUNTS.kai.did), "content-type": encoded.headers.get("content-type")!, "content-length": String(body.byteLength) },
    }), testClient()), 503, "cover_upload_unavailable");
    assert.equal((await edits(admin, FIXTURE_PRESALE_ID)).length, 3, "no refusal wrote an edit");

    // Removing it: 204, the object deleted, an edit; a repeat is 204 and writes nothing.
    const gone = await remove("kai", FIXTURE_PRESALE_ID);
    assert.equal(gone.status, 204);
    assert.equal(gone.headers.get("cache-control"), PRIVATE);
    assert.deepEqual(removed.at(-1), third.metadata.cover!.url);
    assert.equal(objects.size, 0);
    assert.equal((await remove("kai", FIXTURE_PRESALE_ID)).status, 204);
    assert.equal((await edits(admin, FIXTURE_PRESALE_ID)).length, 4);
    const row = (await admin.query("SELECT cover_key, cover_url, cover_width, cover_height FROM social_sale_metadata WHERE presale_id = $1", [FIXTURE_PRESALE_ID])).rows[0];
    assert.deepEqual(row, { cover_key: null, cover_url: null, cover_width: null, cover_height: null });
  }));

test("R3-24-AC-5 (AC-130): no log line of a write, a refusal, an upload or an operator clear carries the tagline or the reason", { skip }, () =>
  withFixture(async ({ put, upload }) => {
    const secret = "secret-tagline-24ab";
    const reason = "secret-reason-24cd";
    const lines: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((method) => console[method]);
    for (const method of methods) {
      console[method] = (...args: unknown[]) => {
        lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg) ?? String(arg))).join(" "));
      };
    }
    let cli: CliResult;
    try {
      await answer(await put("kai", FIXTURE_PRESALE_ID, { tagline: `${secret} stored` }), 200);
      await refused(await put("kai", FIXTURE_PRESALE_ID, { tagline: `${secret} https://x.example` }), 422, "tagline_has_link");
      await refused(await put("kai", FIXTURE_PRESALE_ID, { tagline: `${secret} ${BLOCKED}` }), 422, "blocked_term");
      await refused(await put("mira", FIXTURE_PRESALE_ID, { tagline: `${secret} not mine` }), 403, "not_sale_creator");
      await answer(await upload("kai", FIXTURE_PRESALE_ID, await image(1_536, 512, "png"), "image/png"), 201);
      cli = await operator(["sale", "metadata", "clear", FIXTURE_PRESALE_ID, "--reason", reason]);
    } finally {
      methods.forEach((method, n) => {
        console[method] = originals[n] as (typeof console)[typeof method];
      });
    }
    assert.equal(cli.code, 0, cli.stderr);
    assert.ok(lines.some((line) => line.includes("social.route")), "the route's metric lines were captured");
    assert.deepEqual(lines.filter((line) => line.includes(secret) || line.includes(reason)), []);
    assert.ok(!cli.stdout.includes(secret) && !cli.stderr.includes(secret) && !cli.stderr.includes(reason));
  }, { metricSampleRate: 1 }));

test("R3-24-AC-6: an edit cannot be updated, deleted or truncated by any role, the owner login included", { skip }, () =>
  withFixture(async ({ admin, put }) => {
    await answer(await put("kai", FIXTURE_PRESALE_ID, { tagline: "First line" }), 200);
    for (const write of [
      "UPDATE social_sale_metadata_edits SET before = '{}'::jsonb",
      "UPDATE social_sale_metadata_edits SET at_ms = at_ms",
      "DELETE FROM social_sale_metadata_edits",
      "TRUNCATE social_sale_metadata_edits",
    ]) {
      await assert.rejects(admin.query(write), { code: "23514", constraint: "social_sale_metadata_edits_insert_only" }, write);
    }
    assert.equal((await edits(admin, FIXTURE_PRESALE_ID)).length, 1);
  }));

test("R3-24-AC-8 (AC-126): the 31st write in ten minutes is 429 with Retry-After", { skip }, () =>
  withFixture(async ({ put }) => {
    // The limiter's windows are fixed: start with at least a minute of this one left.
    const window = 600_000;
    const left = window - (Date.now() % window);
    if (left < 60_000) await new Promise((resolve) => setTimeout(resolve, left + 1_000));
    for (let n = 0; n < 30; n += 1) {
      const response = await put("kai", FIXTURE_PRESALE_ID, { tagline: `Line ${n}` });
      assert.equal(response.status, 200, `write ${n}`);
      await response.body?.cancel();
    }
    const limited = await put("kai", FIXTURE_PRESALE_ID, { tagline: "One too many" });
    await refused(limited, 429, "rate_limited");
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    // Another account has its own bucket.
    await refused(await put("mira", FIXTURE_PRESALE_ID, { tagline: "x" }), 403, "not_sale_creator");
  }));

const execute = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const OPERATOR_ID = "ops.sales-test";
const TOKEN = "social-sales-operator-token-32-characters";
type CliResult = { code: number; stdout: string; stderr: string };

/** `npm run social:operator -- <args>` as an operator runs it, against the disposable database, without a Blob token. */
async function operator(args: readonly string[]): Promise<CliResult> {
  assert.ok(testDatabaseUrl);
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    PATH: process.env.PATH,
    DATABASE_URL: testDatabaseUrl,
    MISSION_CONTROL_OPERATOR_ALLOWED_ID: OPERATOR_ID,
    MISSION_CONTROL_OPERATOR_TOKEN_SHA256: createHash("sha256").update(TOKEN).digest("hex"),
    BLAST_OPERATOR_ID: OPERATOR_ID,
    BLAST_OPERATOR_TOKEN: TOKEN,
  };
  try {
    const { stdout, stderr } = await execute(process.execPath, ["--no-warnings", "--experimental-strip-types", "scripts/social-operator.ts", ...args], { cwd: ROOT, env });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

const result = (cli: CliResult) => (JSON.parse(cli.stdout.trim()) as { result: Record<string, unknown>; cover?: string });

test("R3-24 (OA-25 Q5, Q7): the operator lists, clears, reverts and sets the launch date; each is logged with its reason and never the text", { skip }, () =>
  withFixture(async ({ admin, replica, put, upload }) => {
    await answer(await put("kai", FIXTURE_PRESALE_ID, FULL), 200);
    await answer(await put("kai", FIXTURE_PRESALE_ID, { tagline: "An abusive line" }), 200);
    await answer(await upload("kai", FIXTURE_PRESALE_ID, await image(1_536, 512, "png"), "image/png"), 201);

    const history = await operator(["sale", "metadata", "history", FIXTURE_PRESALE_ID]);
    assert.equal(history.code, 0, history.stderr);
    const listed = result(history).result.edits as { editId: string; by: Record<string, string>; changed: string[] }[];
    assert.deepEqual(listed.map((edit) => edit.changed), [["cover"], ["tagline"], ["tagline", "site", "x_handle", "telegram", "docs_url", "audit_url"]]);
    assert.deepEqual(listed[0]!.by, { account: ACCOUNTS.kai.id });
    assert.ok(!history.stdout.includes("abusive") && !history.stdout.includes("meridian"));

    // Revert the tagline edit: the line before it comes back, nothing else moves.
    const revert = await operator(["sale", "metadata", "revert", FIXTURE_PRESALE_ID, listed[1]!.editId, "--reason", "abusive tagline"]);
    assert.equal(revert.code, 0, revert.stderr);
    assert.deepEqual(result(revert).result.changed, ["tagline"]);
    const replicaDb = autocommitReader(replica, "social", { label: "social.sales-replica" });
    const page = () => readPresalePage(replicaDb, FIXTURE_PRESALE_ID, { nowMs: Date.now(), config: SOCIAL_CONFIG_DEFAULTS, terms: async () => null });
    const reverted = (await page())!.presale.metadata!;
    assert.equal(reverted.tagline, FULL.tagline);
    assert.ok(reverted.cover);

    // The launch date (Q5) is the operator's: set, then withdrawn; never an estimate.
    const at = "2026-11-02T18:00:00Z";
    const launch = await operator(["sale", "metadata", "launch-at", FIXTURE_PRESALE_ID, at, "--reason", "creator announced it"]);
    assert.equal(launch.code, 0, launch.stderr);
    assert.equal((await page())!.presale.metadata!.launch_at_ms, Date.parse(at));
    assert.equal((await operator(["sale", "metadata", "launch-at", FIXTURE_PRESALE_ID, "none", "--reason", "postponed"])).code, 0);
    assert.equal((await page())!.presale.metadata!.launch_at_ms, null);

    // Clear: every field and the cover go; without a Blob token here the object is kept, and the result says so.
    const clear = await operator(["sale", "metadata", "clear", FIXTURE_PRESALE_ID, "--reason", "moderation"]);
    assert.equal(clear.code, 0, clear.stderr);
    assert.equal(result(clear).cover, "kept");
    assert.equal((await page())!.presale.metadata, null);
    // A reason is required for every change, and a bad sale id or edit id is refused.
    for (const args of [
      ["sale", "metadata", "clear", FIXTURE_PRESALE_ID],
      ["sale", "metadata", "revert", FIXTURE_PRESALE_ID, "999", "--reason", "x"],
      ["sale", "metadata", "launch-at", FIXTURE_PRESALE_ID, "2026-11-02", "--reason", "x"],
      ["sale", "metadata", "clear", "0xnope", "--reason", "x"],
    ]) {
      const refusedCli = await operator(args);
      assert.notEqual(refusedCli.code, 0, args.join(" "));
      assert.match(refusedCli.stderr, /OPERATOR_INPUT_INVALID/);
    }
    const log = (await admin.query("SELECT action, target, before, after, reason FROM social_operator_log WHERE action LIKE 'sale.metadata.%' ORDER BY acted_at, log_id")).rows;
    assert.deepEqual(log.map((row) => [row.action, row.reason]), [
      ["sale.metadata.history", null],
      ["sale.metadata.revert", "abusive tagline"],
      ["sale.metadata.launch_at", "creator announced it"],
      ["sale.metadata.launch_at", "postponed"],
      ["sale.metadata.clear", "moderation"],
    ]);
    assert.ok(!JSON.stringify(log).includes("abusive line") && !JSON.stringify(log).includes("Lending"));
    const operatorEdits = (await edits(admin, FIXTURE_PRESALE_ID)).filter((edit) => edit.operator_id === OPERATOR_ID);
    assert.equal(operatorEdits.length, 4);
  }));
