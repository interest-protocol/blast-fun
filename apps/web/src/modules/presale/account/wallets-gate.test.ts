import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";

import { PRESALE_ERRORS } from "@blast/core/modules/presale/contracts/errors.ts";
import { createPresaleValidator } from "@blast/core/modules/presale/contracts/validate.ts";
import { RUNTIME_TEST_ENVIRONMENT } from "../../../../../../packages/server/test/fixtures/config/runtime-config.ts";

const WEB_ROOT = new URL("../../../../", import.meta.url);
const HOOKS = new URL("../../scripts/test-tsx-hooks.mjs", WEB_ROOT);
const PROXY = new URL("src/proxy.ts", WEB_ROOT);
const BACKEND_RUNTIME = new URL("../../packages/server/src/modules/presale/account/runtime.ts", WEB_ROOT);
const URL_PATH = "https://www.blast.fun/api/account/wallets";
const validator = createPresaleValidator();
const verificationKey = generateKeyPairSync("ec", { namedCurve: "P-256" })
  .publicKey.export({ format: "pem", type: "spki" })
  .toString();

type Answer = Readonly<{ status: number; cacheControl: string | null; body: string }>;
type Outcome = Readonly<{ proxy: Answer & { next: boolean }; route: Answer | null }>;

// Runs in the child: `server-only` is a bundler marker with no Node entry.
const CHILD = `
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
    return next(specifier, context);
  },
});
const { NextRequest } = await import("next/server");
const { proxy } = await import(${JSON.stringify(PROXY.href)});
const { gateCookieHeader } = await import(${JSON.stringify(new URL("test/fixtures/lib/web-security/api-gate-fixtures.ts", WEB_ROOT).href)});
// A browser's call carries the API gate cookie (WP3); the gate is not what this checks.
const headers = { authorization: "Bearer not-a-privy-token", cookie: gateCookieHeader(${JSON.stringify(URL_PATH)}) };
const answer = async (response) => ({
  status: response.status,
  cacheControl: response.headers.get("cache-control"),
  body: await response.text(),
});
const gate = await proxy(new NextRequest(${JSON.stringify(URL_PATH)}, { headers }));
const next = gate.headers.get("x-middleware-next") === "1";
let route = null;
if (next) {
  const { presaleAccountWalletsRoutes } = await import(${JSON.stringify(BACKEND_RUNTIME.href)});
  const { GET } = presaleAccountWalletsRoutes();
  route = await answer(await GET(new Request(${JSON.stringify(URL_PATH)}, { headers })));
}
process.stdout.write(JSON.stringify({ proxy: { ...(await answer(gate)), next }, route }));
`;

async function throughProxy(): Promise<Outcome> {
  const environment: NodeJS.ProcessEnv = {
    // The backend route boots from runtime config.
    ...RUNTIME_TEST_ENVIRONMENT,
    PATH: process.env.PATH,
    NODE_ENV: "test",
    MISSION_CONTROL_METRICS: "off",
    PRIVY_APP_ID: "presale-wallets-gate-app",
    PRIVY_JWT_VERIFICATION_KEY: verificationKey,
  };
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--no-warnings", "--import", HOOKS.href, "--experimental-strip-types", "--input-type=module", "--eval", CHILD],
    { cwd: WEB_ROOT, env: environment, timeout: 60_000 },
  );
  return JSON.parse(stdout) as Outcome;
}

test("wallet reads reach the route and require valid account credentials", async () => {
  const outcome = await throughProxy();
  assert.equal(outcome.proxy.next, true);
  assert.ok(outcome.route);
  assert.equal(outcome.route.status, PRESALE_ERRORS.unauthorized.status);
  assert.equal(outcome.route.cacheControl, "no-store");
  const body: unknown = JSON.parse(outcome.route.body);
  assert.deepEqual(validator.validate("errors/unauthorized", body).errors, []);
  assert.equal((body as { error: { code: string } }).error.code, "unauthorized");
});
