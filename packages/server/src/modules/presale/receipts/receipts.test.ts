import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before, type TestContext } from "node:test";

import sharp from "sharp";

import type { RateBucket, RateLimitDecision, RateLimitPort, RateLimitSubject } from "@blast/core/lib/web-security/rate-limits.ts";
import {
  createPresaleReceiptLogo,
  PRESALE_RECEIPT_LOGO_SIZE,
  renderPresaleReceiptPng,
  type PresaleReceiptRecord,
} from "@blast/server/modules/mission-control/card-renderer/index.ts";
import { CardImageBusyError, CardImageService } from "@blast/server/modules/mission-control/card-images/index.ts";
import type { PresaleErrorCode } from "@blast/core/modules/presale/contracts/errors.ts";
import type { PresaleProjectionPayload, PresaleWalletResponse } from "@blast/core/modules/presale/contracts/read-path.ts";
import { PRESALE_EXAMPLES } from "@blast/core/modules/presale/contracts/examples.ts";
import { createPresaleValidator } from "@blast/core/modules/presale/contracts/validate.ts";
import { fixtureChainNode, SUI_MAINNET_CHAIN_IDENTIFIER } from "../../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { createPresaleDeploymentGate } from "@blast/core/modules/presale/deployment/service.ts";
import { createPresaleRouteKit } from "@blast/core/modules/presale/route-kit/route.ts";
import { fetchCoinLogo, isPublicAddress, type CoinLogoOutcome } from "@blast/server/modules/presale/receipts/logo.ts";
import { createPresaleReadPath } from "@blast/server/modules/presale/receipts/read-path.ts";
import {
  createPresaleReceiptRoute,
  PRESALE_RECEIPT_CLOSED_CACHE_CONTROL,
  PRESALE_RECEIPT_OPEN_CACHE_CONTROL,
  type CoinMetadataSource,
  type PresaleReceiptDependencies,
} from "@blast/server/modules/presale/receipts/routes.ts";

/**
 * T-012 (AC-097..AC-101, AC-107 support): `GET
 * /api/presale/receipts/{presale_id}/{wallet}/image` as a Request -> Response
 * handler over the presale route kit, a fixture blast-infra (a local HTTP
 * server answering schema-valid presale and wallet views), a fixture node for
 * `Currency` metadata, a fixture crew directory, and the real card image
 * service and receipt renderer (in memory, no Blob store).
 */

const ORIGIN = "https://blast.fun";
const validator = createPresaleValidator();
const PROJECTION = PRESALE_EXAMPLES["presale-projection"];
const PRESALE = PROJECTION.presale_id;
const SALE_TOKEN = PROJECTION.sale_token;
const USDC = PROJECTION.quote;
const hex = (byte: string) => `0x${byte.repeat(32)}`;
const CREW_WALLET = hex("7d");
const PLAIN_WALLET = hex("7e");
const EMPTY_WALLET = hex("7f");
const UNKNOWN_PRESALE = hex("a9");
const CLOSED_PRESALE = hex("a8");
const NOT_READY_PRESALE = hex("a7");

/** The wallet view blast-infra answers for `wallet`, with its commits. */
function walletView(presaleId: string, wallet: string, commits: PresaleWalletResponse["commits"]): PresaleWalletResponse {
  const example = PRESALE_EXAMPLES["presale-wallet"];
  return { ...example, address: wallet, presale_id: presaleId, commits, commitment: commits.length ? example.commitment : null };
}

const commit = (amount: `${bigint}`, total: `${bigint}`, timestamp: number) => ({
  digest: "4tP9gGnU2VZ7ZxCcrQvX7gB1u5Yt2ZbqZzUuXdFh3ry5",
  timestamp_ms: timestamp,
  quote: amount,
  wallet_commitment: total,
});

/** The fixture blast-infra: every body is checked against the published schema before it is served. */
let infra: Server;
let infraOrigin = "";
const infraHits: string[] = [];

function infraBody(path: string): { status: number; body: unknown } {
  const notFound = { status: 404, body: { error: { code: "not_found", message: "Not found." } } };
  const match = path.match(/^\/v1\/presales\/(0x[0-9a-f]{64})(?:\/wallets\/(0x[0-9a-f]{64}))?$/);
  if (!match) return notFound;
  const [, presaleId, wallet] = match;
  if (presaleId === UNKNOWN_PRESALE) return notFound;
  if (presaleId === NOT_READY_PRESALE) return { status: 503, body: { error: { code: "not_ready", message: "The data is not ready yet." } } };
  if (!wallet) {
    const lifecycle: PresaleProjectionPayload["lifecycle"] = presaleId === CLOSED_PRESALE ? "migrated" : "open";
    return { status: 200, body: { ...PROJECTION, presale_id: presaleId, lifecycle } };
  }
  const commits = wallet === EMPTY_WALLET ? [] : [
    commit("1000000000", "1000000000", 1_790_235_000_000),
    // The latest commit's running total is the receipt's amount, whatever the array order.
    commit("1500000000", "2500000000", 1_790_235_061_218),
    commit("500000000", "1500000000", 1_790_235_030_000),
  ];
  return { status: 200, body: walletView(presaleId, wallet, commits) };
}

before(async () => {
  infra = createServer((request, response) => {
    infraHits.push(request.url ?? "");
    const { status, body } = infraBody(request.url ?? "");
    if (status === 200) {
      const schema = request.url?.includes("/wallets/") ? "presale-wallet" : "presale-projection";
      assert.deepEqual(validator.validate(schema, body).errors, [], request.url);
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => infra.listen(0, "127.0.0.1", resolve));
  infraOrigin = `http://127.0.0.1:${(infra.address() as AddressInfo).port}`;
});

after(async () => {
  infra.closeAllConnections();
  await new Promise((resolve) => infra.close(resolve));
});

/** The fixture node's `Currency` metadata, by coin type. */
const METADATA: Record<string, Awaited<ReturnType<CoinMetadataSource>>> = {
  [SALE_TOKEN]: { name: "Froggy", symbol: "FROGGY", decimals: 9, iconUrl: "https://logo.test/froggy.png" },
  [USDC]: { name: "USD Coin", symbol: "USDC", decimals: 6, iconUrl: null },
};

class MemoryLimiter implements RateLimitPort {
  readonly calls: { bucket: RateBucket; subject: RateLimitSubject }[] = [];
  allowed = true;
  async consume(bucket: RateBucket, subject: RateLimitSubject): Promise<RateLimitDecision> {
    this.calls.push({ bucket, subject });
    return { allowed: this.allowed, bucket, policyVersion: 1, retryAfterSeconds: this.allowed ? 0 : 17 };
  }
}

const GREEN_LOGO = createPresaleReceiptLogo(await sharp({
  create: { width: PRESALE_RECEIPT_LOGO_SIZE, height: PRESALE_RECEIPT_LOGO_SIZE, channels: 4, background: "#00ff00" },
}).png().toBuffer());

type Harness = {
  handler: ReturnType<typeof createPresaleReceiptRoute>;
  limiter: MemoryLimiter;
  renders: PresaleReceiptRecord[];
  logoUrls: (string | null)[];
};

function harness(t: TestContext, overrides: Partial<PresaleReceiptDependencies> & {
  logo?: (url: string | null) => Promise<CoinLogoOutcome>;
  origin?: string;
} = {}): Harness {
  t.mock.method(console, "info", () => {});
  const { logo, origin, ...dependencies } = overrides;
  const limiter = new MemoryLimiter();
  const renders: PresaleReceiptRecord[] = [];
  const logoUrls: (string | null)[] = [];
  const kit = createPresaleRouteKit({
    expectedOrigin: ORIGIN,
    verifyAccessToken: async () => { throw new Error("receipts never read a token"); },
    limiter,
    deployment: createPresaleDeploymentGate({ environment: {}, node: async () => fixtureChainNode(SUI_MAINNET_CHAIN_IDENTIFIER) }),
  });
  const images = new CardImageService({
    memoryCacheBytes: 32 * 1024 * 1024,
    persistence: null,
    render: async () => { throw new Error("no season-zero card here"); },
    renderReceipt: async (record, format) => {
      renders.push(record);
      return (await renderPresaleReceiptPng(record, format)).bytes;
    },
  });
  const handler = createPresaleReceiptRoute({
    kit,
    readPath: createPresaleReadPath({ origin: origin ?? infraOrigin, fetch: globalThis.fetch, timeoutMs: 2_000 }),
    metadata: async (coinType) => METADATA[coinType] ?? null,
    crew: async (wallet) => (wallet === CREW_WALLET ? 1042 : null),
    logo: async (url) => {
      logoUrls.push(url);
      return logo ? logo(url) : { logo: GREEN_LOGO, transient: false };
    },
    images,
    ...dependencies,
  });
  return { handler, limiter, renders, logoUrls };
}

function request(presaleId: string, wallet: string, format: string | null = "card", headers: Record<string, string> = {}): Request {
  const query = format === null ? "" : `?format=${encodeURIComponent(format)}`;
  return new Request(`${ORIGIN}/api/presale/receipts/${presaleId}/${wallet}/image${query}`, {
    headers: { "x-forwarded-for": "203.0.113.7", ...headers },
  });
}

async function png(response: Response): Promise<{ bytes: Buffer; width: number; height: number }> {
  assert.equal(response.status, 200, response.status === 200 ? "" : await response.clone().text());
  assert.equal(response.headers.get("content-type"), "image/png");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.headers.get("content-length"), String(bytes.length));
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.format, "png");
  return { bytes, width: metadata.width ?? 0, height: metadata.height ?? 0 };
}

/** An error response: its code, after checking the body against that code's published schema. */
async function errorCode(response: Response, status: number): Promise<PresaleErrorCode> {
  const body = (await response.json()) as { error: { code: PresaleErrorCode } };
  assert.equal(response.status, status, JSON.stringify(body));
  assert.deepEqual(validator.validate(`errors/${body.error.code}`, body).errors, [], JSON.stringify(body));
  assert.equal(response.headers.get("cache-control"), "no-store");
  return body.error.code;
}

async function pixel(bytes: Buffer, x: number, y: number) {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return { red: data[offset], green: data[offset + 1], blue: data[offset + 2] };
}

test("T-012-AC-1: a committed crew member's card shows the logo, the amount in Quote units and the crew number", async (t) => {
  const { handler, renders, logoUrls } = harness(t);
  const image = await png(await handler(request(PRESALE, CREW_WALLET), testClient()));
  assert.deepEqual([image.width, image.height], [2100, 1500]);
  assert.equal(renders.length, 1);
  const [record] = renders;
  assert.deepEqual({ ...record, logo: record.logo?.sha256 }, {
    schema: "blast.presale-receipt",
    version: 1,
    presaleId: PRESALE,
    wallet: CREW_WALLET,
    saleToken: SALE_TOKEN,
    quote: USDC,
    amountCommitted: "2500000000",
    quoteSymbol: "USDC",
    quoteDecimals: 6,
    coinName: "Froggy",
    coinSymbol: "FROGGY",
    logo: GREEN_LOGO.sha256,
    crew: 1042,
  });
  assert.deepEqual(logoUrls, ["https://logo.test/froggy.png"], "the sale coin's Currency icon URL");
  const { red, green, blue } = await pixel(image.bytes, 584, 712);
  assert.ok(green > 150 && red < 90 && blue < 90, "the monitor shows the coin logo");
});

test("a wallet outside any crew gets a receipt without a crew number", async (t) => {
  const { handler, renders } = harness(t);
  await png(await handler(request(PRESALE, PLAIN_WALLET, "post"), testClient()));
  assert.equal(renders[0].crew, null);
  assert.equal(renders[0].amountCommitted, "2500000000");
});

test("T-012-AC-2: card is 2100x1500, post is 1200x675, anything else is invalid_parameter", async (t) => {
  const { handler, renders } = harness(t);
  const card = await png(await handler(request(PRESALE, CREW_WALLET, "card"), testClient()));
  const post = await png(await handler(request(PRESALE, CREW_WALLET, "post"), testClient()));
  assert.deepEqual([card.width, card.height, post.width, post.height], [2100, 1500, 1200, 675]);

  for (const format of ["share", "CARD", "png", "", null]) {
    assert.equal(await errorCode(await handler(request(PRESALE, CREW_WALLET, format), testClient()), 400), "invalid_parameter", String(format));
  }
  const repeated = new Request(`${ORIGIN}/api/presale/receipts/${PRESALE}/${CREW_WALLET}/image?format=card&format=post`);
  assert.equal(await errorCode(await handler(repeated, testClient()), 400), "invalid_parameter");
  for (const [presaleId, wallet] of [["0x1", CREW_WALLET], [PRESALE, "0x7d"], [`${PRESALE}00`, CREW_WALLET], [PRESALE, "wallet"]]) {
    assert.equal(await errorCode(await handler(request(presaleId, wallet), testClient()), 400), "invalid_parameter", `${presaleId}/${wallet}`);
  }
  assert.equal(renders.length, 2);
});

test("an upper-case wallet path is read as the same lower-case address", async (t) => {
  const { handler, renders } = harness(t);
  await png(await handler(request(PRESALE.toUpperCase().replace("0X", "0x"), CREW_WALLET.toUpperCase().replace("0X", "0x")), testClient()));
  assert.equal(renders[0].wallet, CREW_WALLET);
  assert.equal(renders[0].presaleId, PRESALE);
});

test("T-012-AC-3: a wallet with no commitment in the sale, or an unknown sale, is not_found", async (t) => {
  const { handler, renders, logoUrls } = harness(t);
  assert.equal(await errorCode(await handler(request(PRESALE, EMPTY_WALLET), testClient()), 404), "not_found");
  assert.equal(await errorCode(await handler(request(UNKNOWN_PRESALE, CREW_WALLET), testClient()), 404), "not_found");
  assert.deepEqual([renders.length, logoUrls.length], [0, 0]);
});

test("T-012-AC-4: a logo the guard refuses renders the monogram mark with 200", async (t) => {
  const { handler, renders } = harness(t, { logo: async () => ({ logo: null, transient: false }) });
  const image = await png(await handler(request(PRESALE, CREW_WALLET), testClient()));
  assert.equal(renders[0].logo, null);
  const { red, green, blue } = await pixel(image.bytes, 584, 712);
  assert.ok(!(green > 150 && red < 90 && blue < 90));
});

test("T-012-AC-4: private-address and non-https icon URLs never leave the server and still render", async (t) => {
  const refused: string[] = [];
  const guard = async (url: string | null) => {
    const result = await fetchCoinLogo(url, {
      resolve: async () => ["10.0.0.9"],
      addressAllowed: isPublicAddress,
    });
    if ("reason" in result) refused.push(result.reason);
    return { logo: result.logo, transient: "transient" in result && result.transient };
  };
  for (const iconUrl of ["https://internal.example/logo.png", "http://logo.test/logo.png", "https://169.254.169.254/latest", null]) {
    const { handler, renders } = harness(t, {
      logo: guard,
      metadata: async (coinType) => (coinType === SALE_TOKEN ? { ...METADATA[SALE_TOKEN]!, iconUrl } : METADATA[coinType] ?? null),
    });
    await png(await handler(request(PRESALE, CREW_WALLET), testClient()));
    assert.equal(renders[0].logo, null);
  }
  assert.deepEqual(refused, ["private_address", "not_https", "private_address", "absent"]);
});

test("T-012-AC-5: identical record content returns byte-identical images and renders once", async (t) => {
  const { handler, renders } = harness(t);
  const first = await png(await handler(request(PRESALE, CREW_WALLET), testClient()));
  const second = await png(await handler(request(PRESALE, CREW_WALLET, "card", { "x-forwarded-for": "198.51.100.4" }), testClient("198.51.100.4")));
  assert.ok(first.bytes.equals(second.bytes));
  assert.equal(renders.length, 1, "the second request is served from the digest cache");
  await png(await handler(request(PRESALE, CREW_WALLET, "post"), testClient()));
  await png(await handler(request(PRESALE, PLAIN_WALLET), testClient()));
  assert.equal(renders.length, 3, "another format or record renders once more each");
});

test("cache headers follow the sale: short while open, long after it closes", async (t) => {
  const { handler } = harness(t);
  const open = await handler(request(PRESALE, CREW_WALLET), testClient());
  assert.equal(open.headers.get("cache-control"), "public, max-age=30, s-maxage=60");
  assert.equal(PRESALE_RECEIPT_OPEN_CACHE_CONTROL, "public, max-age=30, s-maxage=60");
  await png(open);
  const closed = await handler(request(CLOSED_PRESALE, CREW_WALLET), testClient());
  assert.equal(closed.headers.get("cache-control"), "public, max-age=3600, s-maxage=86400");
  assert.equal(PRESALE_RECEIPT_CLOSED_CACHE_CONTROL, "public, max-age=3600, s-maxage=86400");
  await png(closed);
});

test("a fallback logo from a transient failure keeps the short cache after the sale closes; a permanent refusal may not", async (t) => {
  for (const [presaleId, transient, expected] of [
    [CLOSED_PRESALE, true, PRESALE_RECEIPT_OPEN_CACHE_CONTROL],
    [CLOSED_PRESALE, false, PRESALE_RECEIPT_CLOSED_CACHE_CONTROL],
    [PRESALE, true, PRESALE_RECEIPT_OPEN_CACHE_CONTROL],
    [PRESALE, false, PRESALE_RECEIPT_OPEN_CACHE_CONTROL],
  ] as const) {
    const { handler, renders } = harness(t, { logo: async () => ({ logo: null, transient }) });
    const response = await handler(request(presaleId, CREW_WALLET), testClient());
    assert.equal(response.headers.get("cache-control"), expected, `${presaleId} transient=${transient}`);
    await png(response);
    assert.equal(renders[0].logo, null);
  }
});

test("blast-infra not_ready or unreachable is service_unavailable with Retry-After", async (t) => {
  const ready = harness(t);
  const notReady = await ready.handler(request(NOT_READY_PRESALE, CREW_WALLET), testClient());
  assert.equal(notReady.headers.get("retry-after"), "5");
  assert.equal(await errorCode(notReady, 503), "service_unavailable");

  const unreachable = harness(t, { origin: "http://127.0.0.1:9" });
  const response = await unreachable.handler(request(PRESALE, CREW_WALLET), testClient());
  assert.ok(Number(response.headers.get("retry-after")) > 0);
  assert.equal(await errorCode(response, 503), "service_unavailable");
});

test("a busy renderer is service_unavailable with Retry-After 5", async (t) => {
  const { handler } = harness(t, {
    images: { receiptImage: async () => { throw new CardImageBusyError("queue_full"); } },
  });
  const response = await handler(request(PRESALE, CREW_WALLET), testClient());
  assert.equal(response.headers.get("retry-after"), "5");
  assert.equal(await errorCode(response, 503), "service_unavailable");
});

test("missing Currency metadata or a failing node or crew directory is service_unavailable", async (t) => {
  for (const overrides of [
    { metadata: async () => null },
    { metadata: async () => { throw new Error("node down"); } },
    { crew: async () => { throw Object.assign(new Error("db"), { code: "57P01" }); } },
  ] satisfies Partial<PresaleReceiptDependencies>[]) {
    const { handler } = harness(t, overrides);
    assert.equal(await errorCode(await handler(request(PRESALE, CREW_WALLET), testClient()), 503), "service_unavailable");
  }
});

test("the route is public and counts every request in presale_receipt per client IP", async (t) => {
  const { handler, limiter } = harness(t);
  await png(await handler(request(PRESALE, CREW_WALLET, "card", { authorization: "Bearer not-a-token" }), testClient()));
  assert.deepEqual(limiter.calls, [{ bucket: "presale_receipt", subject: { ip: "203.0.113.7" } }]);
  limiter.allowed = false;
  const limited = await handler(request(PRESALE, CREW_WALLET), testClient());
  assert.equal(limited.headers.get("retry-after"), "17");
  assert.equal(await errorCode(limited, 429), "rate_limited");
  const foreign = await handler(request(PRESALE, CREW_WALLET, "card", { origin: "https://evil.example" }), testClient());
  assert.equal(await errorCode(foreign, 403), "origin_invalid");
});

test("a successful image carries the request id and is never a JSON body", async (t) => {
  const { handler } = harness(t);
  const response = await handler(request(PRESALE, CREW_WALLET), testClient());
  assert.match(response.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
  await png(response);
});
