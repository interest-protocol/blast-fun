import assert from "node:assert/strict";
import test from "node:test";

import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, OPAQUE_SESSION_COOKIE_NAME } from "@blast/core/lib/web-security/mutation-guard.ts";
import {
  clearMemberSessionCookie,
  createMemberSessionLogoutHandler,
  MemberSessionError,
  memberSessionErrorResponse,
  readMemberSessionToken,
} from "@blast/server/modules/mission-control/member-sessions/index.ts";

const ORIGIN = "https://blast.fun";
const CSRF = "c".repeat(43);
const TOKEN = "t".repeat(43);

function request(token = TOKEN, csrf = CSRF): Request {
  return new Request(`${ORIGIN}/api/auth/logout`, {
    method: "POST",
    headers: {
      Cookie: `${OPAQUE_SESSION_COOKIE_NAME}=${token}; ${CSRF_COOKIE_NAME}=${csrf}`,
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      [CSRF_HEADER_NAME]: csrf,
    },
  });
}

test("member cookie parsing is strict and duplicate-safe", () => {
  assert.equal(readMemberSessionToken(request()), TOKEN);
  assert.equal(
    readMemberSessionToken(
      new Request(ORIGIN, {
        headers: {
          Cookie: `${OPAQUE_SESSION_COOKIE_NAME}=${TOKEN}; ${OPAQUE_SESSION_COOKIE_NAME}=${"z".repeat(43)}`,
        },
      }),
    ),
    null,
  );
  assert.match(
    clearMemberSessionCookie(),
    /^__Host-blast_session=; Path=\/; Max-Age=0; HttpOnly; Secure; SameSite=Lax$/,
  );
});

test("logout rejects untrusted mutation before revocation", async () => {
  let revoked = 0;
  const handler = createMemberSessionLogoutHandler({
    expectedOrigin: ORIGIN,
    service: { async revoke() { revoked += 1; return true; } },
  });
  const untrusted = new Request(`${ORIGIN}/api/auth/logout`, {
    method: "POST",
    headers: {
      Cookie: `${OPAQUE_SESSION_COOKIE_NAME}=${TOKEN}`,
      Origin: ORIGIN,
    },
  });
  const response = await handler(untrusted);
  assert.equal(response.status, 403);
  assert.equal(revoked, 0);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.deepEqual(await response.json(), {
    error: {
      code: "CSRF_INVALID",
      message: "The request could not be verified.",
    },
  });
});

test("logout revokes and clears without returning the session token", async () => {
  let received: Request | undefined;
  const handler = createMemberSessionLogoutHandler({
    expectedOrigin: ORIGIN,
    service: { async revoke(value) { received = value; return true; } },
  });
  const response = await handler(request());
  assert.equal(response.status, 204);
  assert.equal(received?.headers.get("cookie")?.includes(TOKEN), true);
  assert.equal(await response.text(), "");
  assert.doesNotMatch(response.headers.get("set-cookie") ?? "", new RegExp(TOKEN));
  assert.equal(response.headers.get("set-cookie"), clearMemberSessionCookie());
});

test("session errors are safe and never echo raw input", async () => {
  const response = memberSessionErrorResponse(
    new MemberSessionError("SESSION_INVALID"),
  );
  assert.equal(response.status, 401);
  const body = JSON.stringify(await response.json());
  assert.doesNotMatch(body, new RegExp(TOKEN));
  assert.match(body, /SESSION_INVALID/);
});
