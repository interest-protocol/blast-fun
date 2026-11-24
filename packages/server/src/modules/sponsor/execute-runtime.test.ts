import { testClient } from "../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  PRESALE_ERRORS,
  type PresaleErrorCode,
} from "@blast/core/modules/presale/contracts/errors.ts";
import { createPresaleValidator } from "@blast/core/modules/presale/contracts/validate.ts";
import { installRuntimeConfig } from "../../../test/fixtures/config/runtime-config.ts";

/**
 * T-018 R-001 Q-009: the production execute route module and its wiring,
 * without a database, a pool or a node. Every request is answered inside the
 * kit with a published code, never a throw, and the digest lookup refuses
 * without a configured presale node.
 */

const APP_ID = "presale-execute-runtime-app";
const NOW = Math.floor(Date.now() / 1_000);
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createPresaleValidator();
const RESERVATION = "00000000-0000-4000-8000-000000000001";

// The test environment names no released presale identity, so the node lookup is never ready.
installRuntimeConfig({
  DATABASE_URL: undefined,
  PRESALE_GAS_POOL_URL: undefined,
  PRIVY_APP_ID: APP_ID,
  PRIVY_JWT_VERIFICATION_KEY: keys.publicKey
    .export({ format: "pem", type: "spki" })
    .toString(),
});

function token(): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({
    aud: APP_ID,
    exp: NOW + 3_600,
    iat: NOW - 60,
    iss: "privy.io",
    sid: "s-1",
    sub: "did:privy:runtime-user",
  });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
    dsaEncoding: "ieee-p1363",
    key: keys.privateKey,
  });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

async function assertError(
  response: Response,
  code: PresaleErrorCode,
): Promise<void> {
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, code, JSON.stringify(body));
  assert.equal(response.status, PRESALE_ERRORS[code].status);
  assert.deepEqual(validator.validate(`errors/${code}`, body).errors, []);
  assert.equal(response.headers.get("cache-control"), "no-store");
}

function execute(id: string, headers: Record<string, string> = {}): Request {
  return new Request(
    `https://www.blast.fun/api/presale/sponsor/${id}/execute`,
    {
      method: "POST",
      body: JSON.stringify({ user_signature: "AAEC" }),
      headers: { "content-type": "application/json", ...headers },
    },
  );
}

test("the canonical execute owner answers inside the kit without a database", async () => {
  const { presaleSponsorExecuteRoute } = await import("./runtime.ts");
  const route = { POST: presaleSponsorExecuteRoute() };
  const signedIn = { authorization: `Bearer ${token()}` };
  await assertError(await route.POST(execute(RESERVATION), testClient()), "unauthorized");
  await assertError(
    await route.POST(execute("r-1", signedIn), testClient()),
    "invalid_parameter",
  );
  // The store is resolved per call: no database is a published 503, not a throw.
  await assertError(
    await route.POST(execute(RESERVATION, signedIn), testClient()),
    "service_unavailable",
  );
  await assertError(
    await route.POST(execute(RESERVATION, signedIn), testClient()),
    "service_unavailable",
  );
});

test("the runtime digest lookup refuses without a configured presale node", async () => {
  const { presaleSponsorTransactionLookup } = await import("./runtime.ts");
  const lookup = presaleSponsorTransactionLookup();
  await assert.rejects(
    lookup.effects("4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"),
    /presale node is not configured/,
  );
});
