import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import type { Pool, QueryResult, QueryResultRow } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import type { RateBucket, RateLimitDecision, RateLimitPort, RateLimitSubject } from "@blast/core/lib/web-security/rate-limits.ts";
import { createCachedCircleWithdraw, createCircleWithdrawIris, type CircleWithdrawIris } from "@blast/server/modules/presale/bridge/circle-withdraw.ts";
import { SUI_CCTP_V2_MAINNET } from "@blast/core/modules/presale/bridge/sui-burn.ts";
import type { BridgeWithdrawState } from "@blast/server/modules/presale/bridge/withdraw-activation.ts";
import { fixtureWithdrawIris, FIXTURE_PLAIN_FEES } from "../../../../../core/test/fixtures/modules/presale/bridge/withdraw-fixtures.ts";
import {
  bridgeWithdrawMaxFee,
  SOCIAL_BRIDGE_WITHDRAW_PATH,
  SOCIAL_BRIDGE_WITHDRAW_QUOTE_PATH,
  socialBridgeWithdrawSettlePath,
  type SocialBridgeWithdrawQuote,
} from "@blast/core/modules/social/contracts/bridge-withdraw.ts";
import { SOCIAL_ERRORS, type SocialErrorCode } from "@blast/core/modules/social/contracts/errors.ts";
import type { SocialAccount } from "@blast/core/modules/social/contracts/me.ts";
import { SOCIAL_WALLET_SESSION_COOKIE } from "@blast/core/modules/social/contracts/wallet-sign-in.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { bridgeWithdrawalBody, bridgeWithdrawalLogEntry, createSocialBridgeWithdrawRoutes, usdcAtomsToUsd, type BridgeWithdrawalRow } from "@blast/server/modules/social/bridge-withdraw/route.ts";

/**
 * Withdraw to another chain, the routes' boundary without a database: sign-in,
 * each route's rate bucket, the closed body and its refusals, the activation
 * gate per destination (a dark bridge never asks Circle), Circle's fee rule,
 * the published schemas, and the signer boundary (the server signs nothing).
 * The database paths are `bridge-withdraw.integration.test.ts`.
 */

const NOW = 1_791_000_000_000;
const ORIGIN = "https://blast.fun";
const APP_ID = "social-bridge-withdraw-app";
const DID = "did:privy:bridge-withdraw-caller";
const EMBEDDED = `0x${"e3".repeat(32)}`;
const SESSION = "s".repeat(43);
const SESSION_WALLET = `0x${"5e".repeat(32)}`;
const EVM = `0x${"1e".repeat(20)}`;
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();

function bearer(): string {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: now + 3_600, iat: now - 60, iss: "privy.io", sid: "s-1", sub: DID });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `Bearer ${header}.${payload}.${signature.toString("base64url")}`;
}

const ACCOUNT: SocialAccount = {
  account_id: "00000000-0000-4000-8000-0000000b0001",
  kind: "new",
  callsign: "bridge_pilot",
  display_name: null,
  avatar_url: null,
  x_handle: null,
  verified: false,
  onboarding: { shown: true, completed: true },
  privacy: "public",
  sharing_since_ms: null,
};

class MemoryLimiter implements RateLimitPort {
  readonly buckets: RateBucket[] = [];
  refuse = false;
  async consume(bucket: RateBucket, subject: RateLimitSubject): Promise<RateLimitDecision> {
    void subject;
    this.buckets.push(bucket);
    return { allowed: !this.refuse, bucket, policyVersion: 1, retryAfterSeconds: this.refuse ? 42 : 0 };
  }
}

const DARK: BridgeWithdrawState = { active: false, reason: "no_record", live: [] };
const live = (...destinations: ("base" | "arbitrum" | "ethereum" | "solana")[]): BridgeWithdrawState =>
  ({ active: true, recordId: "1", ids: SUI_CCTP_V2_MAINNET, live: destinations });

function harness(options: { state?: BridgeWithdrawState; circle?: CircleWithdrawIris } = {}) {
  const limiter = new MemoryLimiter();
  const iris = fixtureWithdrawIris();
  let state = options.state ?? DARK;
  const reads: string[] = [];
  const claimPool = {
    async connect() {
      return {
        on() {}, removeListener() {}, release() {},
        async query(text: string, values: readonly unknown[] = []) {
          const rows = /^INSERT INTO social_bridge_withdraw_claims/.test(text)
            ? [{ withdrawal_id: values[3], owner_token: values[4] }] : [];
          return { rows, rowCount: rows.length, command: "COMMIT", oid: 0, fields: [] };
        },
      };
    },
  } as unknown as Pool;
  const kit = createSocialRouteKit({
    tradingVisible: () => true,
    expectedOrigin: ORIGIN,
    verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString() }),
    limiter,
    accounts: {
      async resolve(did) { return did === DID ? ACCOUNT : null; },
      async resolveWallet(address) { return address === SESSION_WALLET ? { ...ACCOUNT, account_id: "00000000-0000-4000-8000-0000000b0002" } : null; },
    },
    walletSessions: { async live(token) { return token === SESSION ? { address: SESSION_WALLET } : null; } },
    primary: () => claimPool,
    metricSampleRate: 0,
  });
  const circle = createCachedCircleWithdraw(createCircleWithdrawIris({ fetch: iris.fetch, timeoutMs: 100 }));
  const routes = createSocialBridgeWithdrawRoutes({
    kit,
    database: () => ({
      async read<Row extends QueryResultRow>(text: string): Promise<QueryResult<Row>> {
        reads.push(text);
        return { rows: [] as Row[], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
      },
    }),
    gate: () => ({ current: async () => state }),
    circle: () => options.circle ?? circle,
    chain: () => { throw new Error("no fullnode in this test"); },
    sponsor: () => ({ async sponsor() { throw new Error("no sponsor in this test"); }, async recoverBridgeWithdrawal() { return null; } }),
    now: () => NOW,
    burnIds: () => SUI_CCTP_V2_MAINNET,
    burns: () => { throw new Error("no fullnode in this test"); },
    blastWallet: async (caller) => (caller.kind === "privy" ? EMBEDDED : caller.address),
  });
  const auth = (as: "embedded" | "session" | "none"): Record<string, string> =>
    as === "embedded" ? { authorization: bearer() } : as === "session" ? { cookie: `${SOCIAL_WALLET_SESSION_COOKIE}=${SESSION}`, "sec-fetch-site": "same-origin" } : {};
  return {
    limiter,
    iris,
    reads,
    setState: (next: BridgeWithdrawState) => { state = next; },
    quote: (as: "embedded" | "session" | "none" = "embedded") =>
      routes.quote.GET(new Request(`${ORIGIN}${SOCIAL_BRIDGE_WITHDRAW_QUOTE_PATH}`, { headers: { origin: ORIGIN, ...auth(as) } }), testClient()),
    create: (body: unknown, as: "embedded" | "session" | "none" = "embedded") =>
      routes.create.POST(new Request(`${ORIGIN}${SOCIAL_BRIDGE_WITHDRAW_PATH}`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json", ...auth(as) },
        body: JSON.stringify(body),
      }), testClient()),
    settle: (path: string, as: "embedded" | "session" | "none" = "embedded") =>
      routes.settle.POST(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { origin: ORIGIN, ...auth(as) } }), testClient()),
  };
}

async function assertError(response: Response, code: SocialErrorCode): Promise<Record<string, unknown>> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(body.error.code, code, JSON.stringify(body));
  assert.equal(response.status, SOCIAL_ERRORS[code].status);
  assert.ok(validator.validate("error", body).valid, JSON.stringify(body));
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  const retryAfter = response.headers.get("retry-after");
  if (SOCIAL_ERRORS[code].retryAfter) assert.match(retryAfter ?? "", /^[1-9][0-9]*$/, `${code} carries Retry-After`);
  else assert.equal(retryAfter, null, `${code} carries no Retry-After`);
  return body.error;
}

async function quoteOf(response: Response): Promise<SocialBridgeWithdrawQuote> {
  const body = (await response.json()) as SocialBridgeWithdrawQuote;
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const checked = validator.validate("bridge-withdraw-quote-response", body);
  assert.ok(checked.valid, JSON.stringify(checked.errors));
  return body;
}

const request = (overrides: Record<string, unknown> = {}) => ({
  idempotency_key: randomUUID(),
  destination: "base",
  recipient: EVM,
  amount: "100000000",
  max_fee: bridgeWithdrawMaxFee(100_000_000n, "0", 54_800n).toString(),
  ...overrides,
});

test("every route needs a signed-in account and counts in its own bucket: the quote social_read, a withdrawal social_bridge_withdraw, a settle social_transfer", async () => {
  const h = harness();
  await assertError(await h.quote("none"), "unauthorized");
  await assertError(await h.create(request(), "none"), "unauthorized");
  await assertError(await h.settle(socialBridgeWithdrawSettlePath(randomUUID()), "none"), "unauthorized");
  h.limiter.buckets.length = 0;
  await h.quote();
  await h.create(request());
  await h.settle(socialBridgeWithdrawSettlePath("not-a-uuid"));
  assert.deepEqual(h.limiter.buckets, ["social_read", "social_bridge_withdraw", "social_transfer"]);
  h.limiter.refuse = true;
  await assertError(await h.quote(), "rate_limited");
  await assertError(await h.create(request()), "rate_limited");
  await assertError(await h.settle(socialBridgeWithdrawSettlePath(randomUUID())), "rate_limited");
});

test("while the bridge is dark every destination is not_live, Circle is never asked, and a withdrawal is bridge_unavailable", async () => {
  const h = harness();
  const quote = await quoteOf(await h.quote());
  assert.deepEqual(quote.destinations.map((option) => [option.destination, option.available, option.unavailable_reason, option.fee_bps, option.forward_fee]), [
    ["base", false, "not_live", null, null],
    ["arbitrum", false, "not_live", null, null],
    ["ethereum", false, "not_live", null, null],
    ["solana", false, "not_live", null, null],
  ]);
  assert.deepEqual(quote.network_fee, { payer: "blast", label: "Paid by Blast" }, "an embedded wallet's burn is sponsored");
  assert.deepEqual((await quoteOf(await h.quote("session"))).network_fee, { payer: "blast", label: "Paid by Blast" }, "a wallet session's burn is sponsored too");
  await assertError(await h.create(request()), "bridge_unavailable");
  assert.deepEqual(h.iris.requests, [], "nothing asked Circle");
});

test("a live destination offers Circle's Standard fees (the forwarding fee at its high level); Circle down or not forwarding keeps it off", async () => {
  const h = harness({ state: live("base", "solana") });
  const quote = await quoteOf(await h.quote());
  assert.deepEqual(quote.destinations.map((option) => [option.destination, option.available, option.unavailable_reason, option.fee_bps, option.forward_fee]), [
    ["base", true, null, "0", "54800"],
    ["arbitrum", false, "not_live", null, null],
    ["ethereum", false, "not_live", null, null],
    ["solana", true, null, "0", "344900"],
  ]);
  assert.deepEqual(h.iris.requests.sort(), ["/v2/burn/USDC/fees/8/5?forward=true&includeRecipientSetup=true", "/v2/burn/USDC/fees/8/6?forward=true"]);

  const down = harness({ state: live("base") });
  down.iris.state.status = 500;
  assert.equal((await quoteOf(await down.quote())).destinations[0]!.unavailable_reason, "circle_unavailable");
  const error = await assertError(await down.create(request()), "bridge_unavailable");
  assert.equal(error.code, "bridge_unavailable");

  const plain = harness({ state: live("arbitrum") });
  plain.iris.state.fees["3"] = FIXTURE_PLAIN_FEES.arbitrum;
  assert.equal((await quoteOf(await plain.quote())).destinations[1]!.unavailable_reason, "not_forwarded");
  await assertError(await plain.create(request({ destination: "arbitrum" })), "bridge_unavailable");
});

test("the body is closed and exact: a UUID v4 key, a destination, positive atoms, a recipient that is an address there", async () => {
  const h = harness({ state: live("base", "solana") });
  for (const body of [
    request({ idempotency_key: "not-a-uuid" }),
    request({ idempotency_key: "00000000-0000-1000-8000-000000000001" }),
    request({ destination: "sui" }),
    request({ amount: "0" }),
    request({ amount: "01" }),
    request({ amount: 100 }),
    request({ amount: "18446744073709551616" }),
    request({ max_fee: "-1" }),
    request({ recipient: 7 }),
    { ...request(), extra: true },
    Object.fromEntries(Object.entries(request()).filter(([key]) => key !== "max_fee")),
  ]) {
    await assertError(await h.create(body), "invalid_request");
  }
  for (const body of [
    request({ recipient: `0x${"ab".repeat(32)}` }),
    request({ recipient: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD" }),
    request({ recipient: `0x${"0".repeat(40)}` }),
    request({ destination: "solana", recipient: EVM }),
    request({ recipient: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" }),
  ]) {
    await assertError(await h.create(body), "invalid_recipient");
  }
  assert.deepEqual(h.reads, [], "nothing was read for a refused body");
  assert.deepEqual(h.iris.requests, []);
  await assertError(await h.settle(socialBridgeWithdrawSettlePath("not-a-uuid")), "invalid_parameter");
  await assertError(await h.settle(`${SOCIAL_BRIDGE_WITHDRAW_PATH}/${randomUUID()}/settled`), "invalid_parameter");
});

test("Circle keeps all of max_fee: a fee that takes the amount is invalid_amount, and one below today's is bridge_fee_changed with today's", async () => {
  const h = harness({ state: live("base") });
  await assertError(await h.create(request({ amount: "54800", max_fee: "54800" })), "invalid_amount");
  // The forwarding fee equals the full amount.
  await assertError(await h.create(request({ amount: "54800", max_fee: "0" })), "invalid_amount");
  const changed = await assertError(await h.create(request({ max_fee: "54799" })), "bridge_fee_changed");
  assert.equal(changed.max_fee, "54800");
});

test("a withdrawal's answer: what reaches the recipient is amount − max_fee, the bytes only while built; its log row is the USDC that leaves", () => {
  const row: BridgeWithdrawalRow = {
    withdrawal_id: "00000000-0000-4000-8000-0000000b0a01",
    account_id: ACCOUNT.account_id,
    idempotency_key: randomUUID(),
    sender: EMBEDDED,
    destination: "base",
    recipient: EVM,
    mint_recipient: `0x${EVM.slice(2).padStart(64, "0")}`,
    amount: "100000000",
    max_fee: "54800",
    hook: Buffer.alloc(32),
    fee_payer: "blast",
    reservation_id: "00000000-0000-4000-8000-0000000b0a02",
    tx_bytes: Buffer.from([1, 2, 3]),
    digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
    expires_at_ms: "1791000110000",
    state: "built",
    failure_code: null,
    destination_tx_hash: null,
    created_at_ms: "1791000000000",
    burned_at_ms: null,
    delivered_at_ms: null,
  };
  const body = bridgeWithdrawalBody(row, NOW);
  assert.equal(body.receive, "99945200");
  assert.equal(body.transaction_bytes, "AQID");
  assert.deepEqual(body.network_fee, { payer: "blast", label: "Paid by Blast" });
  assert.ok(validator.validate("bridge-withdraw-response", body).valid);
  const burned = bridgeWithdrawalBody({ ...row, state: "burned", burned_at_ms: "1791000002000" });
  assert.equal(burned.transaction_bytes, null, "nothing left to sign");
  assert.ok(validator.validate("bridge-withdraw-response", burned).valid);
  const refused = bridgeWithdrawalBody({ ...row, state: "failed", failure_code: "insufficient_balance", fee_payer: null, reservation_id: null, tx_bytes: null, digest: null, expires_at_ms: null });
  assert.equal(refused.network_fee, null);
  assert.ok(validator.validate("bridge-withdraw-response", refused).valid);
  assert.deepEqual(bridgeWithdrawalLogEntry(row, SUI_CCTP_V2_MAINNET.usdcType), {
    accountId: ACCOUNT.account_id,
    kind: "withdraw",
    idempotencyKey: `bridge_withdraw:${row.withdrawal_id}`,
    txId: row.withdrawal_id,
    coinType: SUI_CCTP_V2_MAINNET.usdcType,
    amount: "100000000",
    usdValue: "100.00",
  });
  assert.equal(usdcAtomsToUsd("1234567"), "1.23");
  assert.equal(usdcAtomsToUsd("5"), "0.00");
});

test("the request schema matches what the route takes", () => {
  assert.ok(validator.validate("bridge-withdraw-request", request()).valid);
  assert.ok(validator.validate("bridge-withdraw-request", request({ destination: "solana", recipient: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" })).valid);
  assert.ok(!validator.validate("bridge-withdraw-request", request({ amount: "0" })).valid);
  assert.ok(!validator.validate("bridge-withdraw-request", { ...request(), accept_fee: true }).valid);
  assert.deepEqual(SOCIAL_ERRORS.bridge_unavailable, { status: 503, retryAfter: true });
  assert.deepEqual(SOCIAL_ERRORS.bridge_withdraw_conflict, { status: 409, retryAfter: false });
  assert.deepEqual(SOCIAL_ERRORS.bridge_fee_changed, { status: 409, retryAfter: false });
});

test("the server's withdrawal code holds no key and signs nothing: it builds bytes for the wallet", () => {
  const dir = new URL("./", import.meta.url);
  const sources = readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  assert.ok(sources.includes("route.ts") && sources.includes("runtime.ts"));
  for (const name of sources) {
    const source = readFileSync(new URL(name, dir), "utf8");
    for (const pattern of [/keypairs/i, /Keypair/, /fromSecretKey/, /signTransaction\(/, /signAndExecute/, /executeTransaction\(/, /PRIVATE_KEY|SECRET_KEY|MNEMONIC/]) {
      assert.doesNotMatch(source, pattern, `${name} must not ${pattern}`);
    }
  }
});


test("an unexpected quote failure joins every already-started destination before returning", async () => {
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const h = harness({state: live("base", "solana"), circle: {
    async forwardFees(destination) {
      if (destination === "base") throw new Error("synthetic unexpected Circle failure");
      started(); await pending; return [];
    },
    async message() { return null; },
  }});
  let returned = false;
  const quote = h.quote().then((response) => { returned = true; return response; });
  try {
    await entered; await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(returned, false, "A rejected sibling must not detach the live Circle operation");
  } finally { release(); }
  await assertError(await quote, "service_unavailable");
});
