import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import { quotaNamespace } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createSocialMeRoute } from "@blast/server/modules/social/accounts/me-route.ts";
import { privateBackendRelay } from "@blast/server/private/relay.ts";
import { parseRelayConfig } from "@blast/server/private/relay-config.ts";
import { createBackendHttp } from "../src/app/server.ts";
import { bcs } from "@mysten/sui/bcs";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";
import { verifyDigestProvenance } from "@blast/server/modules/social/transactions/digest-provenance.ts";

const origin = "https://frontend.test";
const secret = "synthetic-private-gateway-secret-0123456789";
const walletToken = "w".repeat(43);
const account = {
  account_id: "retained-account",
  kind: "new" as const,
  callsign: "retained",
  display_name: "Retained",
  avatar_url: null,
  x_handle: null,
  verified: false,
  onboarding: { shown: true, completed: true },
  privacy: "private" as const,
  sharing_since_ms: null,
  wallets: [],
};
const environment = {
  BLAST_REDIS_NAMESPACE: "synthetic-mainnet-local-identity",
  BLAST_BACKEND_API_ORIGIN: "https://backend.test",
  BLAST_BACKEND_GATEWAY_SECRET: secret,
  NEXT_PUBLIC_SITE_URL: origin,
  BLAST_DEPLOYMENT_TARGET: "preview",
  BLAST_DEPLOYMENT_BRANCH: "local-private-test",
};

function fixture() {
  const seenNonces = new Set<string>();
  let sessionReads = 0;
  let accountReads = 0;
  let observed: Request | undefined;
  let attested: string | undefined;
  const kit = createSocialRouteKit({
    tradingVisible: () => true,
    expectedOrigin: origin,
    verifyAccessToken: async () => {
      throw new Error("No Privy credential in wallet test");
    },
    accounts: {
      async resolve() {
        assert.fail("Use compound me read");
      },
      async resolveWallet() {
        assert.fail("Use compound me read");
      },
    },
    walletSessions: {
      async live(token) {
        sessionReads++;
        return token === walletToken ? { address: "0xretained" } : null;
      },
    },
    limiter: {
      async consume(bucket) {
        return {
          allowed: true,
          bucket,
          policyVersion: 1,
          retryAfterSeconds: 0,
        };
      },
    },
    primary() {
      assert.fail("A me read must not create/recreate accounts");
    },
    metricSampleRate: 0,
  });
  const me = createSocialMeRoute({
    kit,
    accounts: {
      async resolveWithWallets() {
        assert.fail("Wallet session cannot become Privy");
      },
      async resolveWalletWithWallets() {
        accountReads++;
        return account;
      },
    },
  });
  const backend = createBackendHttp({
    namespace: quotaNamespace(environment.BLAST_REDIS_NAMESPACE, deploymentIdentity(environment)),
    gatewaySecret: secret,
    ready: async () => true,
    redis: {
      async execute(args) {
        assert.deepEqual([args[0], args[3], args[4], args[5]], ["SET", "NX", "EX", "30"]);
        assert.match(args[1]!, /:private-replay:/);
        if (seenNonces.has(args[1]!)) {
          return null;
        }
        seenNonces.add(args[1]!);
        return "OK";
      },
    },
    handle: async () => {
      assert.fail("Private requests cannot enter public/partner dispatch");
    },
    privateApi: {
      siteOrigin: origin,
      async handle(request, { proof, client }) {
        assert.equal(client.address, proof.ip);
        observed = request;
        attested = client.address;
        return me.GET(request, client);
      },
    },
  });
  let transport: Request | undefined;
  const relay = privateBackendRelay(parseRelayConfig(environment), {
    clientAddress: () => "192.0.2.1",
    async fetch(input, init) {
      transport = new Request(input, init);
      return backend.fetch(transport, "127.0.0.1");
    },
  });
  const browser = (headers: Record<string, string> = {}, method = "GET") =>
    new Request(origin + "/api/social/me", {
      method,
      headers: {
        cookie: `__Host-blast_wallet=${walletToken}`,
        origin,
        "sec-fetch-site": "same-origin",
        ...headers,
      },
    });
  return {
    backend,
    relay,
    browser,
    transport: () => transport!,
    observed: () => observed!,
    attested: () => attested,
    counts: () => ({ sessionReads, accountReads }),
  };
}

test("existing wallet session and account load through the frontend adapter and Bun business kit", async () => {
  const f = fixture();
  const response = await f.relay(f.browser());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { account });
  assert.equal(f.observed().url, origin + "/api/social/me");
  assert.equal(f.observed().headers.get("cookie"), `__Host-blast_wallet=${walletToken}`);
  assert.equal(f.observed().headers.get("x-forwarded-for"), null);
  assert.equal(f.observed().headers.get("x-real-ip"), null);
  assert.equal(f.attested(), "192.0.2.1");
  assert.deepEqual(f.counts(), { sessionReads: 1, accountReads: 1 });
  const replay = new Request(f.transport().url, {
    headers: f.transport().headers,
  });
  assert.equal((await f.backend.fetch(replay, "127.0.0.1")).status, 403);
  assert.deepEqual(f.counts(), { sessionReads: 1, accountReads: 1 });
});

test("private relay transport does not bypass session authentication or original browser CSRF", async () => {
  const rejectedHeaders: Record<string, string>[] = [
    { origin: "https://attacker.test", "sec-fetch-site": "cross-site" },
    { cookie: "__Host-blast_wallet=" + "z".repeat(43) },
  ];
  for (const headers of rejectedHeaders) {
    const f = fixture();
    const response = await f.relay(f.browser(headers));
    assert.ok([401, 403].includes(response.status));
    assert.equal(f.counts().accountReads, 0);
  }
  const f = fixture();
  assert.equal((await f.backend.fetch(f.browser(), "127.0.0.1")).status, 403);
  assert.equal((await f.relay(f.browser({ "x-blast-partner-key": "synthetic-key" }))).status, 403);
  assert.deepEqual(f.counts(), { sessionReads: 0, accountReads: 0 });
});

test("SSR has a separately signed read capability and HEAD retains GET headers without a body", async () => {
  const f = fixture();
  const hardRefresh = new Request(origin + "/api/social/me", {
    headers: {
      cookie: `__Host-blast_wallet=${walletToken}`,
      "sec-fetch-site": "none",
    },
  });
  assert.equal((await f.relay(hardRefresh, "ssr-read")).status, 200);
  assert.equal(f.observed().headers.get("sec-fetch-site"), "same-origin");
  const head = await f.relay(f.browser({}, "HEAD"));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.match(head.headers.get("content-type") ?? "", /application\/json/);
});

test("private digest mutations forward full transaction proofs above 4 KiB and reject bodies above 192 KiB", async () => {
  const sender = normalizeSuiAddress("0x1");
  const bytes = bcs.TransactionData.serialize({
    V1: {
      kind: {
        ProgrammableTransaction: {
          inputs: [{ Pure: { bytes: new Uint8Array(5_000) } }],
          commands: [],
        },
      },
      sender,
      gasData: { owner: sender, payment: [], price: "1000", budget: "2000000" },
      expiration: { None: true },
    },
  }).toBytes();
  const payload = JSON.stringify({
    digest: TransactionDataBuilder.getDigestFromBytes(bytes),
    transaction_bytes: toBase64(bytes),
  });
  assert.ok(Buffer.byteLength(payload) > 4096);
  let ownerCalls = 0;
  const backend = createBackendHttp({
    namespace: quotaNamespace(environment.BLAST_REDIS_NAMESPACE, deploymentIdentity(environment)),
    gatewaySecret: secret,
    ready: async () => true,
    redis: {
      async execute() {
        return "OK";
      },
    },
    handle: async () => {
      assert.fail("Private mutations cannot use public dispatch");
    },
    privateApi: {
      siteOrigin: origin,
      async handle(request) {
        assert.equal(await request.text(), payload);
        const value = JSON.parse(payload);
        await verifyDigestProvenance(
          { digest: value.digest, transactionBytes: value.transaction_bytes, sender },
          async () => {
            assert.fail("Pending proof needs no chain lookup");
          },
        );
        ownerCalls++;
        return new Response(null, { status: 204 });
      },
    },
  });
  let forwarded: Request | undefined;
  const relay = privateBackendRelay(parseRelayConfig(environment), {
    clientAddress: () => "192.0.2.1",
    async fetch(input, init) {
      forwarded = new Request(input, init);
      return backend.fetch(forwarded, "127.0.0.1");
    },
  });
  for (const [method, path] of [
    ["PUT", "/api/social/me/transfers/11111111-1111-4111-8111-111111111111"],
    ["PUT", "/api/social/me/claims/11111111-1111-4111-8111-111111111111"],
    ["POST", "/api/social/intents"],
  ]) {
    const browser = (body: string) =>
      new Request(origin + path, {
        method,
        headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin" },
        body,
      });
    assert.equal((await relay(browser(payload))).status, 204, path);
    const signed = forwarded!;
    const before = ownerCalls;
    const oversized = "x".repeat(192 * 1024 + 1);
    assert.equal((await relay(browser(oversized))).status, 413, "frontend body cap");
    assert.equal(
      (
        await backend.fetch(
          new Request(signed.url, { method, headers: signed.headers, body: oversized }),
          "127.0.0.1",
        )
      ).status,
      413,
      "backend body cap",
    );
    assert.equal(ownerCalls, before, "Oversized requests never reach financial owners");
  }
  assert.equal(ownerCalls, 3);
});
