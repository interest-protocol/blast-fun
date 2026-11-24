import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

import { PRESALE_ERRORS, type PresaleErrorCode } from "@blast/core/modules/presale/contracts/errors.ts";
import { createPresaleValidator } from "@blast/core/modules/presale/contracts/validate.ts";
import { installRuntimeConfig } from "../../../../test/fixtures/config/runtime-config.ts";

/**
 * T-010 R-001 B-001: the production route module without a usable database.
 * A missing `DATABASE_URL` must fail a request inside the kit, as a published
 * answer: 401 for an anonymous caller, `service_unavailable` for a signed-in
 * one, never a throw (which Next serves as a bare 500).
 */

// `server-only` is a bundler marker with no Node entry; outside Next it is empty.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
    return next(specifier, context);
  },
});

const APP_ID = "presale-settings-runtime-app";
const NOW = Math.floor(Date.now() / 1_000);
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createPresaleValidator();

installRuntimeConfig({
  DATABASE_URL: undefined,
  PRIVY_APP_ID: APP_ID,
  PRIVY_JWT_VERIFICATION_KEY: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
});

function token(): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: NOW + 3_600, iat: NOW - 60, iss: "privy.io", sid: "s-1", sub: "did:privy:runtime-user" });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

async function assertError(response: Response, code: PresaleErrorCode): Promise<void> {
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, code, JSON.stringify(body));
  assert.equal(response.status, PRESALE_ERRORS[code].status);
  assert.deepEqual(validator.validate(`errors/${code}`, body).errors, []);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(response.headers.get("x-request-id"));
}

test("without DATABASE_URL the settings route answers 401 anonymously and service_unavailable when signed in", async () => {
  const { presaleAccountSettingsRoutes } = await import("@blast/server/modules/presale/settings/runtime.ts");
  const { GET, PUT } = presaleAccountSettingsRoutes();
  const url = "https://www.blast.fun/api/account/settings";
  const signedIn = { authorization: `Bearer ${token()}` };
  const body = JSON.stringify({ explorer: "suiscan", theme: "dark" });
  const json = { "content-type": "application/json" };

  await assertError(await GET(new Request(url), testClient()), "unauthorized");
  await assertError(await PUT(new Request(url, { method: "PUT", body, headers: json }), testClient()), "unauthorized");
  await assertError(await GET(new Request(url, { headers: signedIn }), testClient()), "service_unavailable");
  await assertError(await PUT(new Request(url, { method: "PUT", body, headers: { ...signedIn, ...json } }), testClient()), "service_unavailable");
  // Not cached: the next request answers the same way.
  await assertError(await GET(new Request(url), testClient()), "unauthorized");
});
