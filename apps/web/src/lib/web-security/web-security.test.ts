import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import { presaleConnectSources, readPresaleConfig } from "#web/components/presale/config.ts";

import { AdaptiveChallengeController, type AdaptiveDecisionAudit } from "@blast/server/lib/web-security/adaptive-challenge.ts";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, assertTrustedMutationRequest, csrfCookie, opaqueSessionCookie, withTrustedMutation } from "@blast/core/lib/web-security/mutation-guard.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { DEFAULT_RATE_POLICIES, createRatePolicyRegistry, RATE_POLICY_REGISTRY_VERSION, ratePolicyOptionsFromEnvironment, rateLimitSubjectKey, walletChallengeRateLimiter, type RateLimitSubject } from "@blast/core/lib/web-security/rate-limits.ts";
import { WebSecurityError } from "@blast/core/lib/web-security/errors.ts";
import { createContentSecurityPolicy, securityHeaders } from "#web/lib/web-security/browser-policy.ts";
import { SECURITY_FIXTURES } from "../../../test/fixtures/lib/web-security/fixtures.ts";

const ORIGIN = "https://blast.fun";
const TOKENS = [1, 2, 3].map((byte) =>
  Buffer.alloc(32, byte).toString("base64url"),
);

test("provider-compatible CSP is restrictive and nonce-bound", () => {
  const nonce = "a".repeat(32);
  const csp = createContentSecurityPolicy({ nonce });
  assert.match(csp, /script-src 'self' 'nonce-a{32}' 'strict-dynamic'/);
  assert.match(csp, /connect-src 'self' https:\/\/auth\.privy\.io https:\/\/api\.privy\.io/);
  assert.match(csp, /https:\/\/explorer-api\.walletconnect\.com/);
  // Privy's CSP guide: wallet relays, embedded-wallet RPC, verify frames and Turnstile.
  const directive = (name: string) =>
    csp.split("; ").find((part) => part.startsWith(`${name} `))?.split(" ").slice(1) ?? [];
  for (const source of [
    "wss://relay.walletconnect.com",
    "wss://relay.walletconnect.org",
    "wss://www.walletlink.org",
    "https://*.rpc.privy.systems",
    "https://challenges.cloudflare.com",
    // The browser's swap estimate (Cetus's aggregator).
    "https://api-sui.cetus.zone",
  ]) {
    assert.ok(directive("connect-src").includes(source), source);
  }
  for (const name of ["frame-src", "child-src"]) {
    assert.deepEqual(directive(name), [
      "https://auth.privy.io",
      "https://verify.walletconnect.com",
      "https://verify.walletconnect.org",
      "https://challenges.cloudflare.com",
    ]);
  }
  assert.ok(directive("script-src").includes("https://challenges.cloudflare.com"));
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /(?:^|\s)\*(?:\s|;|$)/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.match(
    createContentSecurityPolicy({ nonce, development: true }),
    /unsafe-eval/,
  );
  assert.equal(securityHeaders({ nonce })["X-Content-Type-Options"], "nosniff");
  assert.throws(
    () => createContentSecurityPolicy({ nonce: "predictable" }),
    /unguessable/,
  );
});

test("WP2: the CSP never admits blast-infra: the browser reads market data only from this app", () => {
  const nonce = "a".repeat(32);
  const connect = createContentSecurityPolicy({ nonce }).split("; ").find((part) => part.startsWith("connect-src "))!.split(" ");
  assert.ok(connect.includes("'self'"), "the same-origin /api/launchpad/market routes");
  assert.ok(!connect.some((source) => /infra|api\.blast\.fun|127\.0\.0\.1|localhost/.test(source)), connect.join(" "));
  const live = connectSources(createContentSecurityPolicy({ nonce, liveSocketOrigin: "wss://live.blast.fun" }));
  assert.deepEqual(live.filter((source) => !connect.includes(source)), ["wss://live.blast.fun"], "the direct socket's origin only");
  assert.throws(() => createContentSecurityPolicy({ nonce, liveSocketOrigin: "wss://*.blast.fun" }), /plain origin/);
  // The policy takes no market origin at all, whatever the environment holds.
  const environment = { BLAST_INFRA_ORIGIN: process.env.BLAST_INFRA_ORIGIN, NEXT_PUBLIC_BLAST_INFRA_ORIGIN: process.env.NEXT_PUBLIC_BLAST_INFRA_ORIGIN };
  process.env.BLAST_INFRA_ORIGIN = "https://infra.blast.test";
  process.env.NEXT_PUBLIC_BLAST_INFRA_ORIGIN = "https://infra.blast.test";
  try {
    assert.doesNotMatch(securityHeaders({ nonce })["Content-Security-Policy"], /infra\.blast\.test/);
  } finally {
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

function connectSources(csp: string): string[] {
  return csp.split("; ").find((part) => part.startsWith("connect-src "))!.split(" ").slice(1);
}

test("connect-src adds exactly the presale's mainnet origins, without wildcards", () => {
  const nonce = "a".repeat(32);
  const base = connectSources(createContentSecurityPolicy({ nonce }));
  const withPresale = (environment: Record<string, string>) => {
    const sources = presaleConnectSources(readPresaleConfig(environment));
    return { sources, csp: connectSources(createContentSecurityPolicy({ nonce, presaleConnectSources: sources })) };
  };

  const mainnet = withPresale({ BLAST_NETWORK: "mainnet" });
  assert.deepEqual(mainnet.sources, ["https://fullnode.mainnet.sui.io:443", "https://api-sui.cetus.zone"]);
  // The mainnet fullnode is already a base source; it is listed once.
  assert.deepEqual(mainnet.csp, [...base, ...mainnet.sources.filter((source) => !base.includes(source))]);

  // Swap without Cetus: no aggregator.
  assert.deepEqual(
    withPresale({ BLAST_NETWORK: "mainnet", NEXT_PUBLIC_PRESALE_SWAP_PROVIDERS: "AFTERMATH" }).sources,
    ["https://fullnode.mainnet.sui.io:443"],
  );
  // blast-infra is never a source: the presale adds only its own origins.
  assert.ok(!mainnet.csp.some((source) => /infra/.test(source)));
  // No network: nothing is added.
  assert.deepEqual(withPresale({}).csp, base);

  for (const source of mainnet.csp.slice(1)) {
    if (base.includes(source)) continue;
    assert.doesNotMatch(source, /\*/, source);
  }
});

test("presale connect sources must be plain origins", () => {
  const nonce = "a".repeat(32);
  for (const source of ["https://*.rpc.test", "*", "https://rpc.test/v2/key", "https://rpc.test?key=1", "https://user@rpc.test", "rpc.test"]) {
    assert.throws(() => createContentSecurityPolicy({ nonce, presaleConnectSources: [source] }), /plain origin/, source);
  }
  assert.doesNotThrow(() =>
    createContentSecurityPolicy({ nonce, presaleConnectSources: ["https://fullnode.mainnet.sui.io:443", "http://127.0.0.1:9000", "wss://rpc.test"] }),
  );
});

test("the CSP is byte-identical to the policy without a market origin, in every environment", () => {
  const nonce = "a".repeat(32);
  // Baseline policy with the approved inline styles in style-src.
  const withoutMarket =
    "default-src 'self'; script-src 'self' 'nonce-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' 'strict-dynamic' https://auth.privy.io https://challenges.cloudflare.com; style-src 'self' 'nonce-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' 'sha256-StEaX+se6YS7pqjzrzMIA0KaX9zF/8zAhvQXZAe5epY=' 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=' 'sha256-QlwpTd7Ve6xx/zCJuRcdEKxpvG41xq7uvysQt5tkwaY='; style-src-attr 'unsafe-hashes' 'sha256-zlqnbDt84zf1iSefLU/ImC54isoprH/MRiVZGskwexk='; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://auth.privy.io https://api.privy.io https://fullnode.mainnet.sui.io:443 https://api-sui.cetus.zone https://explorer-api.walletconnect.com wss://relay.walletconnect.com wss://relay.walletconnect.org wss://www.walletlink.org https://*.rpc.privy.systems https://challenges.cloudflare.com; frame-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org https://challenges.cloudflare.com; child-src https://auth.privy.io https://verify.walletconnect.com https://verify.walletconnect.org https://challenges.cloudflare.com; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; manifest-src 'self'; media-src 'self'; upgrade-insecure-requests";
  assert.equal(createContentSecurityPolicy({ nonce }), withoutMarket);
  const { VERCEL: vercel, VERCEL_ENV: vercelEnvironment } = process.env;
  process.env.VERCEL = "1";
  process.env.VERCEL_ENV = "production";
  try {
    assert.equal(createContentSecurityPolicy({ nonce }), withoutMarket, "production");
  } finally {
    if (vercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = vercel;
    if (vercelEnvironment === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = vercelEnvironment;
  }
});

test("prerendered pages get the same CSP with inline sources instead of a nonce", () => {
  const csp = createContentSecurityPolicy({ nonce: null });
  assert.match(csp, /script-src 'self' 'unsafe-inline' https:\/\/auth\.privy\.io/);
  assert.match(csp, /style-src 'self' 'unsafe-inline';/);
  assert.doesNotMatch(csp, /nonce-|strict-dynamic|unsafe-eval/);
  const nonceBound = createContentSecurityPolicy({ nonce: "a".repeat(32) });
  const others = (policy: string) =>
    policy.split("; ").filter((part) => !/^(script|style)-src(?:-attr)? /.test(part));
  assert.deepEqual(others(csp), others(nonceBound));
  // A hash beside 'unsafe-inline' would switch it off.
  assert.doesNotMatch(csp, /sha256-/);
  // The presale sources reach prerendered pages too (blast-infra is never a browser source: WP2).
  const sources = { presaleConnectSources: ["https://solana.rpc.test"] };
  assert.deepEqual(
    others(createContentSecurityPolicy({ nonce: null, ...sources })),
    others(createContentSecurityPolicy({ nonce: "a".repeat(32), ...sources })),
  );
  assert.match(createContentSecurityPolicy({ nonce: null, ...sources }), /https:\/\/solana\.rpc\.test/);
});

test("Origin and double-submit CSRF reject before cookie mutation", async () => {
  const csrf = TOKENS[0];
  const valid = new Request(`${ORIGIN}/api/profile`, {
    method: "POST",
    headers: {
      Cookie: `${CSRF_COOKIE_NAME}=${csrf}`,
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      [CSRF_HEADER_NAME]: csrf,
    },
  });
  assert.doesNotThrow(() => assertTrustedMutationRequest(valid, ORIGIN));
  let mutations = 0;
  const wrongOrigin = new Request(`${ORIGIN}/api/profile`, {
    method: "POST",
    headers: {
      Cookie: `${CSRF_COOKIE_NAME}=${csrf}`,
      Origin: "https://evil.example",
      [CSRF_HEADER_NAME]: csrf,
    },
  });
  await assert.rejects(
    withTrustedMutation(wrongOrigin, ORIGIN, async () => ++mutations),
    (error: unknown) =>
      error instanceof WebSecurityError && error.code === "ORIGIN_INVALID",
  );
  const missingCsrf = new Request(`${ORIGIN}/api/profile`, {
    method: "POST",
    headers: { Origin: ORIGIN },
  });
  await assert.rejects(
    withTrustedMutation(missingCsrf, ORIGIN, async () => ++mutations),
    (error: unknown) =>
      error instanceof WebSecurityError && error.code === "CSRF_INVALID",
  );
  assert.equal(mutations, 0);
  assert.match(csrfCookie(csrf), /Secure; SameSite=Strict/);
  assert.match(opaqueSessionCookie("z".repeat(32), 3_600), /HttpOnly; Secure/);
});

test("all named versioned rate policies publish exact defaults and scopes", () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(DEFAULT_RATE_POLICIES).map(([name, policy]) => [
        name,
        {
          scope: policy.subjectScope,
          version: policy.version,
          windows: policy.windows,
        },
      ]),
    ),
    {
      admin_login_ip: { scope: "ip", version: 1, windows: [{ limit: 5, windowSeconds: 60 }] },
      admin_login_global: { scope: "global", version: 1, windows: [{ limit: 100, windowSeconds: 60 }] },
      telegram: { scope: "admission_or_session", version: 1, windows: [{ limit: 3, windowSeconds: 60 }, { limit: 10, windowSeconds: 3600 }] },
      share: { scope: "admission_or_session", version: 1, windows: [{ limit: 3, windowSeconds: 60 }, { limit: 10, windowSeconds: 3600 }] },
      code: {
        scope: "ip",
        version: 1,
        windows: [
          { limit: 10, windowSeconds: 60 },
          { limit: 30, windowSeconds: 3_600 },
        ],
      },
      wallet: {
        scope: "ip_address",
        version: 2,
        windows: [{ limit: 5, windowSeconds: 600 }],
      },
      recovery: {
        scope: "ip_address",
        version: 1,
        windows: [{ limit: 5, windowSeconds: 600 }],
      },
      // Review L3: the client IP alone, beside `wallet`.
      wallet_ip: { scope: "ip", version: 1, windows: [{ limit: 30, windowSeconds: 600 }] },
      callsign: {
        scope: "attempt",
        version: 1,
        windows: [{ limit: 30, windowSeconds: 60 }],
      },
      completion: {
        scope: "attempt",
        version: 2,
        windows: [
          { limit: 5, windowSeconds: 60 },
          { limit: 30, windowSeconds: 600 },
        ],
      },
      telemetry: {
        scope: "admission_or_session",
        version: 1,
        windows: [{ limit: 12, windowSeconds: 60 }],
      },
      oauth: {
        scope: "ip",
        version: 1,
        windows: [{ limit: 10, windowSeconds: 600 }],
      },
      // Launchpad coin-view beacons: per client IP, apart from Mission Control's telemetry.
      launchpad_telemetry: {
        scope: "ip",
        version: 1,
        windows: [
          { limit: 30, windowSeconds: 60 },
          { limit: 300, windowSeconds: 3_600 },
        ],
      },
      // Verified-outcome reports: per client IP, a provisional copy of the
      // launchpad_telemetry values until the owner sets its own.
      launchpad_outcome: {
        scope: "ip",
        version: 1,
        windows: [
          { limit: 30, windowSeconds: 60 },
          { limit: 300, windowSeconds: 3_600 },
        ],
      },
      // Outcome digest commitments: a provisional copy of the `launchpad_telemetry` values, per client IP.
      launchpad_outcome_commitment: {
        scope: "ip",
        version: 1,
        windows: [
          { limit: 30, windowSeconds: 60 },
          { limit: 300, windowSeconds: 3_600 },
        ],
      },
      // Launch image uploads: a provisional copy of the `wallet` values, per client IP.
      launchpad_launch_asset: {
        scope: "ip",
        version: 1,
        windows: [{ limit: 5, windowSeconds: 600 }],
      },
      // Launchpad social posts: a provisional copy of the `wallet` values, per client IP.
      launchpad_social_post: {
        scope: "ip",
        version: 1,
        windows: [{ limit: 5, windowSeconds: 600 }],
      },
      // Launchpad Wallet Proofs: provisional copies of the `wallet` values,
      // counted apart from Mission Control's.
      launchpad_wallet_proof: {
        scope: "ip_address",
        version: 1,
        windows: [{ limit: 5, windowSeconds: 600 }],
      },
      launchpad_wallet_proof_issue: {
        scope: "ip",
        version: 1,
        windows: [{ limit: 5, windowSeconds: 600 }],
      },
      // WP3 (bot protection): routes outside the kits, per client IP.
      web_gate: { scope: "ip", version: 1, windows: [{ limit: 30, windowSeconds: 600 }] },
      launchpad_search: { scope: "ip", version: 1, windows: [{ limit: 60, windowSeconds: 60 }] },
      launchpad_discovery: { scope: "ip", version: 1, windows: [{ limit: 120, windowSeconds: 60 }] },
      defillama_read: { scope: "ip", version: 1, windows: [{ limit: 120, windowSeconds: 60 }] },
      defillama_public_global: { scope: "global", version: 1, windows: [{ limit: 300, windowSeconds: 60 }] },
      launchpad_wallet_launches: { scope: "ip", version: 1, windows: [{ limit: 120, windowSeconds: 60 }] },
      launchpad_theses_read: { scope: "ip", version: 1, windows: [{ limit: 240, windowSeconds: 60 }] },
      // Review M3: the public card image (outside /api), per client IP.
      mission_control_card_image: { scope: "ip", version: 1, windows: [{ limit: 300, windowSeconds: 60 }] },
      // Review L5: a member's own writes that had no bucket.
      // Presale web routes (T-008): account buckets are keyed by Privy DID.
      presale_sponsor: { scope: "account", version: 1, windows: [{ limit: 30, windowSeconds: 600 }] },
      presale_sponsor_exec: { scope: "account", version: 1, windows: [{ limit: 100, windowSeconds: 86_400 }] },
      presale_allowlist: { scope: "account_or_api_key", version: 1, windows: [{ limit: 20, windowSeconds: 3_600 }] },
      presale_allowlist_csv: { scope: "api_key", version: 1, windows: [{ limit: 10, windowSeconds: 60 }] },
      presale_proof: { scope: "ip", version: 1, windows: [{ limit: 120, windowSeconds: 60 }] },
      presale_bridge_quote: { scope: "ip", version: 1, windows: [{ limit: 60, windowSeconds: 60 }] },
      presale_bridge_register: { scope: "ip", version: 1, windows: [{ limit: 20, windowSeconds: 600 }] },
      presale_receipt: { scope: "ip", version: 1, windows: [{ limit: 60, windowSeconds: 60 }] },
      presale_settings: { scope: "account", version: 1, windows: [{ limit: 30, windowSeconds: 600 }] },
      presale_reward_proof: { scope: "ip", version: 1, windows: [{ limit: 120, windowSeconds: 60 }] },
      presale_outcome_commit: { scope: "ip", version: 1, windows: [{ limit: 60, windowSeconds: 60 }] },
      presale_outcome: { scope: "ip", version: 1, windows: [{ limit: 30, windowSeconds: 60 }] },
      presale_account_wallets: { scope: "account", version: 1, windows: [{ limit: 60, windowSeconds: 600 }] },
      // WP3: unlimited presale reads, and the sponsor routes' per-IP and platform-wide daily layers.
      presale_bridge_status: { scope: "ip", version: 1, windows: [{ limit: 120, windowSeconds: 60 }] },
      presale_allowlist_read: { scope: "account_or_api_key", version: 1, windows: [{ limit: 120, windowSeconds: 60 }] },
      presale_sponsor_ip: { scope: "ip", version: 1, windows: [{ limit: 120, windowSeconds: 600 }] },
      presale_sponsor_exec_ip: { scope: "ip", version: 1, windows: [{ limit: 60, windowSeconds: 3_600 }] },
      presale_sponsor_global: { scope: "global", version: 1, windows: [{ limit: 20_000, windowSeconds: 86_400 }] },
      presale_sponsor_exec_global: { scope: "global", version: 1, windows: [{ limit: 5_000, windowSeconds: 86_400 }] },
      // Review H1/H2: one account's share of the daily sponsor cap; wrong signatures per reservation.
      presale_sponsor_account_daily: { scope: "account", version: 1, windows: [{ limit: 100, windowSeconds: 86_400 }] },
      presale_sponsor_bad_signature: { scope: "attempt", version: 1, windows: [{ limit: 2, windowSeconds: 3_600 }] },
      // Review M2: agent API key lookups per client IP (in memory).
      presale_api_key_ip: { scope: "ip", version: 1, windows: [{ limit: 300, windowSeconds: 60 }] },
      // Social routes (social-feed T-002): account buckets are keyed by Privy DID.
      social_account_create: { scope: "ip_and_account", version: 1, windows: [{ limit: 5, windowSeconds: 3_600 }] },
      social_follow: { scope: "account", version: 1, windows: [{ limit: 120, windowSeconds: 60 }] },
      social_reaction: { scope: "account", version: 1, windows: [{ limit: 240, windowSeconds: 60 }] },
      social_why: { scope: "account", version: 1, windows: [{ limit: 20, windowSeconds: 3_600 }] },
      social_report: { scope: "account", version: 1, windows: [{ limit: 30, windowSeconds: 3_600 }] },
      social_intent: { scope: "account", version: 1, windows: [{ limit: 60, windowSeconds: 60 }] },
      social_wallet_link: { scope: "account", version: 1, windows: [{ limit: 10, windowSeconds: 3_600 }] },
      social_workspace_save: { scope: "account", version: 1, windows: [{ limit: 60, windowSeconds: 60 }] },
      social_account_update: { scope: "account", version: 1, windows: [{ limit: 30, windowSeconds: 600 }] },
      social_read: { scope: "ip", version: 1, windows: [{ limit: 600, windowSeconds: 60 }] },
      social_wallet_sign_in: { scope: "ip", version: 1, windows: [{ limit: 20, windowSeconds: 600 }] },
      social_notification: { scope: "account", version: 1, windows: [{ limit: 240, windowSeconds: 60 }] },
      social_picture_upload: { scope: "account", version: 1, windows: [{ limit: 10, windowSeconds: 3_600 }] },
      social_pnl_card_publish: { scope: "account", version: 1, windows: [{ limit: 30, windowSeconds: 3_600 }] },
      social_create: { scope: "account", version: 1, windows: [{ limit: 120, windowSeconds: 60 }] },
      social_create_logo: { scope: "account", version: 1, windows: [{ limit: 20, windowSeconds: 600 }] },
      social_watchlist: { scope: "account", version: 1, windows: [{ limit: 120, windowSeconds: 60 }] },
      social_transfer: { scope: "account", version: 1, windows: [{ limit: 60, windowSeconds: 600 }] },
      social_trade_quote: { scope: "account", version: 1, windows: [{ limit: 120, windowSeconds: 60 }] },
      social_claim: { scope: "account", version: 1, windows: [{ limit: 60, windowSeconds: 600 }] },
      social_commit: { scope: "account", version: 1, windows: [{ limit: 60, windowSeconds: 600 }] },
      social_deposit: { scope: "account", version: 1, windows: [{ limit: 120, windowSeconds: 600 }] },
      social_bridge_withdraw: { scope: "account", version: 1, windows: [{ limit: 30, windowSeconds: 600 }] },
      // The coin page's same-origin market routes (WP2), per client IP.
      launchpad_market_coin: { scope: "ip", version: 1, windows: [{ limit: 240, windowSeconds: 60 }] },
      launchpad_market_holders: { scope: "ip", version: 1, windows: [{ limit: 240, windowSeconds: 60 }] },
      launchpad_market_activity: { scope: "ip", version: 1, windows: [{ limit: 240, windowSeconds: 60 }] },
      launchpad_market_pool: { scope: "ip", version: 1, windows: [{ limit: 480, windowSeconds: 60 }] },
      launchpad_market_candles: { scope: "ip", version: 1, windows: [{ limit: 480, windowSeconds: 60 }] },
      launchpad_market_trades: { scope: "ip", version: 1, windows: [{ limit: 240, windowSeconds: 60 }] },
      launchpad_market_status: { scope: "ip", version: 1, windows: [{ limit: 120, windowSeconds: 60 }] },
      launchpad_market_rewards: { scope: "ip", version: 1, windows: [{ limit: 240, windowSeconds: 60 }] },
      launchpad_market_reward_rounds: { scope: "ip", version: 1, windows: [{ limit: 120, windowSeconds: 60 }] },
      launchpad_market_wallet_launch_rewards: { scope: "ip", version: 1, windows: [{ limit: 120, windowSeconds: 60 }] },
      launchpad_market_wallet_holder_rewards: { scope: "ip", version: 1, windows: [{ limit: 120, windowSeconds: 60 }] },
      launchpad_market_wallet_launches: { scope: "ip", version: 1, windows: [{ limit: 120, windowSeconds: 60 }] },
      launchpad_market_creator_claims: { scope: "ip", version: 1, windows: [{ limit: 120, windowSeconds: 60 }] },
      launchpad_market_partners: { scope: "ip", version: 1, windows: [{ limit: 120, windowSeconds: 60 }] },
      launchpad_market_partner: { scope: "ip", version: 1, windows: [{ limit: 120, windowSeconds: 60 }] },
      launchpad_market_partner_launches: { scope: "ip", version: 1, windows: [{ limit: 120, windowSeconds: 60 }] },
      launchpad_market_policy: { scope: "ip", version: 1, windows: [{ limit: 60, windowSeconds: 60 }] },
      // WP3: public reads split by family; anonymous quotes and the caller's own reads.
      social_read_search: { scope: "ip", version: 1, windows: [{ limit: 60, windowSeconds: 60 }] },
      social_read_presales: { scope: "ip", version: 1, windows: [{ limit: 300, windowSeconds: 60 }] },
      social_read_prices: { scope: "ip", version: 1, windows: [{ limit: 300, windowSeconds: 60 }] },
      social_read_trade_coins: { scope: "ip", version: 1, windows: [{ limit: 120, windowSeconds: 60 }] },
      social_read_portfolio: { scope: "ip", version: 1, windows: [{ limit: 60, windowSeconds: 60 }] },
      social_read_quote: { scope: "ip", version: 1, windows: [{ limit: 240, windowSeconds: 60 }] },
      social_trade_quote_anon: { scope: "ip", version: 1, windows: [{ limit: 20, windowSeconds: 60 }] },
      social_me_read: { scope: "account", version: 1, windows: [{ limit: 300, windowSeconds: 60 }] },
      // Review L6, L4: a deposit's new burn registration per IP; failed wallet-session lookups per IP.
      social_deposit_register: { scope: "ip", version: 1, windows: [{ limit: 20, windowSeconds: 600 }] },
      social_auth_failure: { scope: "ip", version: 1, windows: [{ limit: 60, windowSeconds: 600 }] },
      partner_auth_ip: { scope: "ip", version: 1, windows: [{ limit: 600, windowSeconds: 60 }] },
      partner_auth_global: { scope: "global", version: 1, windows: [{ limit: 3_000, windowSeconds: 60 }] },
      partner_read_global: { scope: "global", version: 1, windows: [{ limit: 600, windowSeconds: 60 }] },
      partner_read: { scope: "api_key", version: 1, windows: [{ limit: 300, windowSeconds: 60 }, { limit: 50_000, windowSeconds: 86_400 }] },
    },
  );
  assert.equal(
    RATE_POLICY_REGISTRY_VERSION,
    30,
    "adding the trade quote bucket (15), the claim transaction's bucket (16), the server-built commit's bucket (17), the deposit's bucket (18), the cross-chain withdrawal's bucket (19), the coin page's market route buckets with WP3's bot-protection buckets (20), the sponsor's per-account daily share and wrong-signature count (21), the API key lookup and card image buckets (22), and the security review's per-IP wallet, recovery, owner-write, deposit-registration and failed-session buckets (23), PnL card publishing (24), partner reads (25), partner key lookups (26), shared partner admission (28), distributed registry admission (29), and isolated admin login buckets (30) bump the registry version",
  );
  // A wrong-signature count is keyed by the reservation alone.
  assert.equal(rateLimitSubjectKey(DEFAULT_RATE_POLICIES.presale_sponsor_bad_signature, { attemptId: "r-1", ip: "203.0.113.7" }), "attempt:r-1");
  // A platform-wide bucket has one subject, whoever asks.
  assert.equal(rateLimitSubjectKey(DEFAULT_RATE_POLICIES.presale_sponsor_global, { ip: "203.0.113.7", accountId: "did:privy:a" }), "global");
  assert.equal(rateLimitSubjectKey(DEFAULT_RATE_POLICIES.presale_sponsor_exec_global, {}), "global");
  // The daily caps are configurable, within bounds; a malformed value refuses rather than run uncapped.
  const configured = createRatePolicyRegistry(ratePolicyOptionsFromEnvironment({ PRESALE_SPONSOR_DAILY_CAP: "1000", PRESALE_SPONSOR_EXEC_DAILY_CAP: "250" }));
  assert.deepEqual(configured.presale_sponsor_global.windows, [{ limit: 1_000, windowSeconds: 86_400 }]);
  assert.deepEqual(configured.presale_sponsor_exec_global.windows, [{ limit: 250, windowSeconds: 86_400 }]);
  assert.deepEqual(createRatePolicyRegistry(ratePolicyOptionsFromEnvironment({})).presale_sponsor_global.windows, [{ limit: 20_000, windowSeconds: 86_400 }]);
  for (const bad of ["0", "-5", "1e3", "ten", "100000000"]) {
    assert.throws(() => ratePolicyOptionsFromEnvironment({ PRESALE_SPONSOR_DAILY_CAP: bad }), /PRESALE_SPONSOR_DAILY_CAP/, bad);
  }
  // `ip_and_account` counts each part on its own: one part per subject.
  const create = DEFAULT_RATE_POLICIES.social_account_create;
  assert.equal(rateLimitSubjectKey(create, { ip: "203.0.113.7" }), "ip:203.0.113.7");
  assert.equal(rateLimitSubjectKey(create, { accountId: "did:privy:social-a" }), "account:did:privy:social-a");
  assert.throws(() => rateLimitSubjectKey(create, { accountId: "did:privy:social-a", ip: "203.0.113.7" }), /Missing ip_and_account/);
  assert.throws(() => rateLimitSubjectKey(create, {}), /Missing ip_and_account/);
  const did = "did:privy:presale-account";
  assert.equal(rateLimitSubjectKey(DEFAULT_RATE_POLICIES.presale_sponsor, { accountId: did, ip: "203.0.113.7" }), `account:${did}`);
  assert.equal(rateLimitSubjectKey(DEFAULT_RATE_POLICIES.presale_allowlist, { accountId: did }), `account:${did}`);
  assert.equal(rateLimitSubjectKey(DEFAULT_RATE_POLICIES.presale_allowlist, { apiKeyId: "agent-key-1" }), "api_key:agent-key-1");
  assert.throws(() => rateLimitSubjectKey(DEFAULT_RATE_POLICIES.presale_sponsor, { ip: "203.0.113.7" }), /Missing account/);
  assert.throws(() => rateLimitSubjectKey(DEFAULT_RATE_POLICIES.presale_sponsor, { apiKeyId: "agent-key-1" }), /Missing account/);
  assert.deepEqual(
    DEFAULT_RATE_POLICIES.launchpad_wallet_proof.windows,
    DEFAULT_RATE_POLICIES.wallet.windows,
    "the launchpad proof buckets reuse the wallet policy values",
  );
  assert.deepEqual(
    DEFAULT_RATE_POLICIES.launchpad_wallet_proof_issue.windows,
    DEFAULT_RATE_POLICIES.wallet.windows,
  );
  assert.equal(
    rateLimitSubjectKey(DEFAULT_RATE_POLICIES.launchpad_wallet_proof_issue, {
      ip: "203.0.113.7",
      address: `0x${"1".repeat(64)}`,
      operation: "issue",
    }),
    "ip:203.0.113.7",
    "issuance is keyed by client IP alone, so rotating addresses shares one budget",
  );
  assert.equal(
    rateLimitSubjectKey(DEFAULT_RATE_POLICIES.telemetry, SECURITY_FIXTURES.session),
    "session:session-fixture",
  );
  assert.equal(
    rateLimitSubjectKey(DEFAULT_RATE_POLICIES.launchpad_telemetry, { ip: "203.0.113.7" }),
    "ip:203.0.113.7",
  );
  assert.deepEqual(
    DEFAULT_RATE_POLICIES.launchpad_outcome.windows,
    DEFAULT_RATE_POLICIES.launchpad_telemetry.windows,
    "outcome reports provisionally reuse the coin-view beacon values",
  );
  assert.notEqual(
    rateLimitSubjectKey(DEFAULT_RATE_POLICIES.wallet, {
      ...SECURITY_FIXTURES.wallet,
      operation: "issue",
    }),
    rateLimitSubjectKey(DEFAULT_RATE_POLICIES.wallet, {
      ...SECURITY_FIXTURES.wallet,
      operation: "verify",
    }),
  );
  assert.deepEqual(createRatePolicyRegistry({ oauth: { limit: 7, windowSeconds: 300 } }).oauth.windows, [
    { limit: 7, windowSeconds: 300 },
  ]);
  assert.throws(
    () => createRatePolicyRegistry({ oauth: { limit: 101, windowSeconds: 300 } }),
    /outside/,
  );
});

const RATE_PEPPER = "web-security-unit-pepper-is-at-least-32-characters";

interface RecordedStatement {
  query_timeout?: number;
  text: string;
  values: unknown[];
}

/**
 * Stands in for PostgreSQL's upsert: keeps a count per (window, start) from the
 * statement's parameters, so decisions can be checked without a database.
 */
function fakeRatePool() {
  const counts = new Map<string, number>();
  const statements: RecordedStatement[] = [];
  const failures = new Set<"count" | "refund">();
  const client = {
    async query(config: RecordedStatement) {
      statements.push(config);
      const refund = /request_count - 1/.test(config.text);
      if (failures.delete(refund ? "refund" : "count")) throw new Error("offline");
      const windows = config.values.slice(3);
      const rows = [];
      for (let index = 0; index < windows.length; index += 3) {
        const key = `${String(windows[index])}@${(windows[index + 1] as Date).toISOString()}`;
        const current = counts.get(key) ?? 0;
        const next = !refund ? current + 1 : current === 0 ? 1 : Math.max(1, current - 1);
        counts.set(key, next);
        rows.push({ request_count: next, window_seconds: windows[index] });
      }
      return { rows };
    },
    on() {},
    release() {},
    removeListener() {},
  };
  return {
    counts,
    failures,
    pool: { connect: async () => client } as unknown as Pool,
    statements,
  };
}

test("rate limits count every window in one autocommit upsert", async () => {
  const fake = fakeRatePool();
  const now = new Date("2026-09-20T12:34:56.000Z");
  const limiter = new PostgresRateLimitEnforcer({
    clock: () => now,
    pool: fake.pool,
    subjectPepper: RATE_PEPPER,
  });

  assert.deepEqual(await limiter.consume("code", { ip: "203.0.113.5" }), {
    allowed: true,
    bucket: "code",
    policyVersion: 1,
    retryAfterSeconds: 0,
  });
  assert.equal(fake.statements.length, 1);
  const [statement] = fake.statements;
  assert.ok(statement);
  assert.doesNotMatch(statement.text, /\b(BEGIN|COMMIT|ROLLBACK)\b|SET LOCAL/);
  assert.match(statement.text, /^\s*INSERT INTO mission_control_rate_limit_windows/);
  assert.match(statement.text, /ON CONFLICT[\s\S]*request_count \+ 1[\s\S]*RETURNING window_seconds, request_count/);
  assert.equal(statement.query_timeout, undefined);
  assert.deepEqual(statement.values, [
    "code",
    1,
    createHmac("sha256", RATE_PEPPER).update("ip:203.0.113.5").digest("hex"),
    60,
    new Date("2026-09-20T12:34:00.000Z"),
    new Date("2026-09-20T12:35:00.000Z"),
    3_600,
    new Date("2026-09-20T12:00:00.000Z"),
    new Date("2026-09-20T13:00:00.000Z"),
  ]);
  assert.doesNotMatch(JSON.stringify(statement.values), /203\.0\.113/);
});

test("refused requests keep the same Retry-After and consume no budget", async () => {
  const fake = fakeRatePool();
  const hour = new Date("2026-09-20T12:00:00.000Z").getTime();
  let now = new Date(hour + 15_000);
  const limiter = new PostgresRateLimitEnforcer({
    clock: () => now,
    pool: fake.pool,
    subjectPepper: RATE_PEPPER,
  });
  const subject = { ip: "203.0.113.6" };

  for (let request = 0; request < 10; request += 1) {
    assert.equal((await limiter.consume("code", subject)).allowed, true);
  }
  const statementsBeforeRefusal = fake.statements.length;
  // The minute window is full: Retry-After runs to the end of the minute.
  assert.deepEqual(await limiter.consume("code", subject), {
    allowed: false,
    bucket: "code",
    policyVersion: 1,
    retryAfterSeconds: 45,
  });
  assert.equal(fake.statements.length, statementsBeforeRefusal + 2);
  assert.match(fake.statements.at(-1)?.text ?? "", /request_count - 1[\s\S]*request_count > 1/);

  // Refused attempts gave their hourly counts back: 10 more in each of the
  // next two minutes are allowed, and the hour trips at exactly 30.
  for (const minute of [1, 2]) {
    now = new Date(hour + minute * 60_000);
    for (let request = 0; request < 10; request += 1) {
      assert.equal((await limiter.consume("code", subject)).allowed, true);
    }
  }
  now = new Date(hour + 3 * 60_000 + 30_000);
  // Only the hour is full: Retry-After runs to the end of the hour, and the
  // refused request's minute count cannot move Retry-After to the minute.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    assert.deepEqual(await limiter.consume("code", subject), {
      allowed: false,
      bucket: "code",
      policyVersion: 1,
      retryAfterSeconds: 56 * 60 + 30,
    });
  }
});

test("single-window refusals need no refund and failures surface correctly", async () => {
  const fake = fakeRatePool();
  const now = new Date("2026-09-20T12:05:00.000Z");
  const limiter = new PostgresRateLimitEnforcer({
    clock: () => now,
    pool: fake.pool,
    subjectPepper: RATE_PEPPER,
  });

  for (let request = 0; request < 5; request += 1) {
    assert.equal((await limiter.consume("wallet", SECURITY_FIXTURES.wallet)).allowed, true);
  }
  const before = fake.statements.length;
  assert.deepEqual(await limiter.consume("wallet", SECURITY_FIXTURES.wallet), {
    allowed: false,
    bucket: "wallet",
    policyVersion: 2,
    retryAfterSeconds: 300,
  });
  assert.equal(fake.statements.length, before + 1);

  // A refund that fails leaves the refusal standing instead of failing the request.
  const codeSubject = { ip: "203.0.113.7" };
  for (let request = 0; request < 10; request += 1) {
    await limiter.consume("code", codeSubject);
  }
  fake.failures.add("refund");
  assert.equal((await limiter.consume("code", codeSubject)).allowed, false);

  // A failed count still fails the request, as the transaction did.
  fake.failures.add("count");
  await assert.rejects(limiter.consume("code", codeSubject), /offline/);

  assert.throws(
    () =>
      new PostgresRateLimitEnforcer({
        pool: fake.pool,
        policies: {
          ...DEFAULT_RATE_POLICIES,
          code: {
            ...DEFAULT_RATE_POLICIES.code,
            windows: [
              { limit: 1, windowSeconds: 60 },
              { limit: 2, windowSeconds: 60 },
            ],
          },
        },
        subjectPepper: RATE_PEPPER,
      }),
    /distinct/,
  );
});

test("multi-window policies must nest: each longer window a whole multiple of the shorter ones", () => {
  const fake = fakeRatePool();
  const withCodeWindows = (seconds: number[]) =>
    new PostgresRateLimitEnforcer({
      pool: fake.pool,
      policies: {
        ...DEFAULT_RATE_POLICIES,
        code: {
          ...DEFAULT_RATE_POLICIES.code,
          windows: seconds.map((windowSeconds, index) => ({ limit: index + 1, windowSeconds })),
        },
      },
      subjectPepper: RATE_PEPPER,
    });

  // A 60 s window straddles a 45 s boundary, so a refund could not rely on nesting.
  assert.throws(() => withCodeWindows([45, 60]), /nested/);
  assert.throws(() => withCodeWindows([60, 45]), /nested/);
  // 900 is a multiple of 60 but not of 600.
  assert.throws(() => withCodeWindows([60, 600, 900]), /nested/);
  assert.throws(() => withCodeWindows([]), /non-empty/);
  assert.ok(withCodeWindows([3_600, 60, 600]));

  // Every policy the codebase ships nests.
  assert.ok(new PostgresRateLimitEnforcer({ pool: fake.pool, subjectPepper: RATE_PEPPER }));
  assert.ok(new PostgresRateLimitEnforcer({
    pool: fake.pool,
    policies: createRatePolicyRegistry({ oauth: { limit: 10, windowSeconds: 600 } }),
    subjectPepper: RATE_PEPPER,
  }));
  for (const policy of Object.values(DEFAULT_RATE_POLICIES)) {
    const seconds = policy.windows.map((window) => window.windowSeconds);
    for (const shorter of seconds) {
      for (const longer of seconds) {
        if (longer > shorter) assert.equal(longer % shorter, 0, `${policy.bucket}: ${longer} s over ${shorter} s`);
      }
    }
  }
});

test("wallet challenge issue and verification use independent allowances", async () => {
  const subjects: RateLimitSubject[] = [];
  const perIp: RateLimitSubject[] = [];
  const limiter = walletChallengeRateLimiter(
    {
      async consume(bucket, subject) {
        // Review L3: the client IP alone (`wallet_ip`), then IP, address and operation (`wallet`).
        assert.ok(bucket === "wallet" || bucket === "wallet_ip", bucket);
        (bucket === "wallet" ? subjects : perIp).push(subject);
        return {
          allowed: true,
          bucket,
          policyVersion: DEFAULT_RATE_POLICIES.wallet.version,
          retryAfterSeconds: 0,
        };
      },
    },
  );

  assert.deepEqual(
    await limiter.consume({ operation: "issue", subject: SECURITY_FIXTURES.wallet }),
    { allowed: true, retryAfterSeconds: 0 },
  );
  assert.deepEqual(
    await limiter.consume({ operation: "verify", subject: SECURITY_FIXTURES.wallet }),
    { allowed: true, retryAfterSeconds: 0 },
  );
  assert.deepEqual(subjects.map(({ operation }) => operation), ["issue", "verify"]);
  assert.deepEqual(perIp, [{ ip: SECURITY_FIXTURES.wallet.ip }, { ip: SECURITY_FIXTURES.wallet.ip }]);
});

test("review L3: a full per-IP wallet budget refuses before the address bucket counts", async () => {
  const calls: string[] = [];
  const limiter = walletChallengeRateLimiter(
    {
      async consume(bucket) {
        calls.push(bucket);
        const allowed = bucket !== "wallet_ip";
        return { allowed, bucket, policyVersion: 1, retryAfterSeconds: allowed ? 0 : 77 };
      },
    },
  );
  const subject = { ip: "203.0.113.7", address: `0x${"1".repeat(64)}` };
  assert.deepEqual(await limiter.consume({ operation: "issue", subject }), { allowed: false, retryAfterSeconds: 77 });
  assert.deepEqual(calls, ["wallet_ip"]);
  assert.equal(rateLimitSubjectKey(DEFAULT_RATE_POLICIES.wallet_ip, { ip: "203.0.113.7", address: "0xabc", operation: "issue" }), "ip:203.0.113.7");
});

test("adaptive challenge is risk-triggered, ephemeral, and not identity", async () => {
  const audits: AdaptiveDecisionAudit[] = [];
  const controller = new AdaptiveChallengeController({
    audit: { async record(decision) { audits.push(decision); } },
    verifier: { async verify({ token }) { return token === "pass"; } },
    clock: () => new Date("2026-09-20T12:00:00.000Z"),
  });
  await controller.enforce({ bucket: "oauth", recentFailures: 0 });
  await controller.enforce({ bucket: "callsign", recentFailures: 999 });
  await assert.rejects(
    controller.enforce({ bucket: "oauth", recentFailures: 3 }),
    (error: unknown) =>
      error instanceof WebSecurityError &&
      error.code === "BOT_CHALLENGE_REQUIRED",
  );
  await controller.enforce({
    bucket: "oauth",
    challengeToken: "pass",
    recentFailures: 3,
  });
  await assert.rejects(
    controller.enforce({
      bucket: "oauth",
      challengeToken: "fail",
      recentFailures: 3,
    }),
    (error: unknown) =>
      error instanceof WebSecurityError && error.code === "BOT_CHALLENGE_FAILED",
  );
  assert.deepEqual(
    audits.map(({ decision }) => decision),
    [
      "ordinary",
      "ordinary",
      "challenge_required",
      "challenge_passed",
      "challenge_failed",
    ],
  );
  assert.doesNotMatch(JSON.stringify(audits), /ip|device|user|address|session/i);
});

test("review L5: readBoundedText reads at most maxBytes, refusing a larger declared or streamed body", async () => {
  const { readBoundedText } = await import("@blast/server/lib/web-security/request-body.ts");
  const body = (text: string, headers: Record<string, string> = {}) => new Request("https://www.blast.fun/x", { method: "PATCH", body: text, headers });
  assert.equal(await readBoundedText(body('{"displayName":"Ada"}'), 1_024), '{"displayName":"Ada"}');
  assert.equal(await readBoundedText(body("x".repeat(1_025)), 1_024), null);
  assert.equal(await readBoundedText(body("small", { "content-length": "999999" }), 1_024), null, "a declared length over the limit is refused unread");
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(512).fill(97));
      if (pulled > 100) controller.close();
    },
  });
  const streamed = new Request("https://www.blast.fun/x", { method: "PATCH", body: stream, duplex: "half" } as RequestInit);
  assert.equal(await readBoundedText(streamed, 1_024), null);
  assert.ok(pulled <= 4, `stopped after the limit (${pulled} chunks)`);
  assert.equal(await readBoundedText(new Request("https://www.blast.fun/x"), 1_024), "");

  const endless = () => new Request("https://www.blast.fun/x", { method: "PATCH", body: new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }), duplex: "half" } as RequestInit);
  await assert.rejects(readBoundedText(endless(), 1_024, { signal: AbortSignal.abort() }), { name: "AbortError" });
  await assert.rejects(readBoundedText(endless(), 1_024, { signal: AbortSignal.timeout(20) }), { name: "TimeoutError" }, "an abort mid-read ends a stalled body");
  const invalidUtf8 = () => new Request("https://www.blast.fun/x", { method: "PATCH", body: new Uint8Array([0x7b, 0xff, 0x7d]) });
  await assert.rejects(readBoundedText(invalidUtf8(), 1_024, { fatal: true }), TypeError);
  assert.equal(await readBoundedText(invalidUtf8(), 1_024), "{�}");
});

test("review L11: the memory limiter evicts to 90% of its bound, so a full sweep runs once per tenth of the bound", async () => {
  const { MemoryRateLimiter } = await import("@blast/core/modules/web-security/route-limits.ts");
  // One request per window: a subject whose window is kept is refused, a forgotten one is allowed again.
  const policies = { ...DEFAULT_RATE_POLICIES, web_gate: { ...DEFAULT_RATE_POLICIES.web_gate, windows: [{ limit: 1, windowSeconds: 600 }] } };
  const limiter = new MemoryRateLimiter({ maxEntries: 100, policies, clock: () => new Date("2026-10-07T12:00:00.000Z") });
  const kept = async (ips: readonly string[]) => {
    const decisions = await Promise.all(ips.map((ip) => limiter.peek("web_gate", { ip })));
    return ips.filter((_, index) => !decisions[index]!.allowed);
  };
  const first = Array.from({ length: 101 }, (_, n) => `203.0.113.${n}`);
  for (const ip of first) await limiter.consume("web_gate", { ip });
  assert.deepEqual(await kept(first), first.slice(11), "over the bound: the oldest go, down to the low-water mark");
  const next = Array.from({ length: 10 }, (_, n) => `198.51.100.${n}`);
  for (const ip of next) await limiter.consume("web_gate", { ip });
  assert.deepEqual(await kept([...first, ...next]), [...first.slice(11), ...next], "the next tenth of new windows fits without a sweep");
});

test("a non-ASCII CSRF header is refused instead of crashing timingSafeEqual", () => {
  const request = new Request(`${ORIGIN}/api/mission-control/completion`, {
    method: "POST",
    headers: { origin: ORIGIN, cookie: `${CSRF_COOKIE_NAME}=${TOKENS[0]}`, [CSRF_HEADER_NAME]: "é".repeat(43) },
  });
  assert.throws(() => assertTrustedMutationRequest(request, ORIGIN), (error) => error instanceof WebSecurityError && error.code === "CSRF_INVALID");
});

test("dynamic CSP permits only Next/image's exact style attribute", () => {
  const hash = createHash("sha256").update("color:transparent").digest("base64");
  const csp = createContentSecurityPolicy({ nonce: "a".repeat(32) });
  assert.equal(csp.split("; ").find((part) => part.startsWith("style-src-attr ")),
    `style-src-attr 'unsafe-hashes' 'sha256-${hash}'`);
  assert.doesNotMatch(csp, /'unsafe-inline'/);
  assert.match(createContentSecurityPolicy({ nonce: null }), /style-src-attr 'unsafe-inline';/);
});
