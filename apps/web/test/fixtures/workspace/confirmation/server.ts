import { readFileSync } from "node:fs";
import { sign } from "node:crypto";
import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createSocialMeRoute } from "@blast/server/modules/social/accounts/me-route.ts";
import { createSocialSettingsRoute } from "@blast/server/modules/social/accounts/settings-route.ts";
import { createSocialWorkspaceRoute } from "@blast/server/modules/social/workspace/route.ts";
const url = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
if (!url?.includes(":35276/") || !process.env.T014_CONFIG_DIR)
  throw new Error("T014 assigned fixture only");
const authentication = JSON.parse(
  readFileSync(`${process.env.T014_CONFIG_DIR}/auth.json`, "utf8"),
);
const runtime = new URL(url);
runtime.searchParams.set("options", "-c role=blast_web");
const pool = createRuntimePool(runtime.toString(), {
  max: 4,
  connectionTimeoutMs: 3000,
  idleInTransactionMs: 3000,
  idleTimeoutMs: 1000,
  lockTimeoutMs: 1000,
  statementTimeoutMs: 3000,
});
const accounts = new PostgresSocialAccounts(() => pool);
const kit = createSocialRouteKit({
  tradingVisible: () => true,
  expectedOrigin: "http://127.0.0.1:42930",
  verifyAccessToken: createPrivyTokenVerifier({
    appId: "t014-browser",
    verificationKey: authentication.publicKey,
  }),
  limiter: new PostgresRateLimitEnforcer({
    pool,
    subjectPepper: "t014-fixture-pepper-01234567890123456789",
  }),
  accounts,
  primary: () => pool,
  metricSampleRate: 0,
});
export const workspaceRoute = createSocialWorkspaceRoute({
  kit,
  database: () => autocommitReader(pool, "social"),
});
export const meRoute = createSocialMeRoute({ kit, accounts });
export function fixtureToken(n: number, expired: boolean) {
  if (!Number.isInteger(n) || n < 1 || n > 2)
    throw new Error("Unknown fixture account");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = `${encode({ alg: "ES256", typ: "JWT" })}.${encode({ aud: "t014-browser", exp: now + (expired ? -1 : 3600), iat: now - 60, iss: "privy.io", sid: "t014-browser", sub: `did:privy:t014-${n}` })}`;
  return `${payload}.${sign("sha256", Buffer.from(payload), { dsaEncoding: "ieee-p1363", key: authentication.privateKey }).toString("base64url")}`;
}

export const settingsRoute = createSocialSettingsRoute({
  kit,
  database: () => autocommitReader(pool, "social"),
});
