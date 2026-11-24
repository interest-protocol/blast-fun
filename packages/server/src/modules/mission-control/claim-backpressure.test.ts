import assert from "node:assert/strict";
import test from "node:test";

import { UNAVAILABLE_RETRY_AFTER_SECONDS } from "@blast/core/modules/database/availability.ts";
import { MemberSessionError } from "@blast/server/modules/mission-control/member-sessions/index.ts";
import { createOwnerRouteHandlers } from "@blast/server/modules/mission-control/owner-profile/route.ts";

const ORIGIN = "https://www.blast.fun";
/** What pg-pool rejects with when every client stays busy past connectionTimeoutMillis. */
function poolTimeout(): Error {
  return new Error("timeout exceeded when trying to connect");
}

function ownerRoutes(
  authenticate: () => Promise<never>,
  getOwner: () => Promise<never>,
) {
  return createOwnerRouteHandlers({
    authenticate,
    expectedOrigin: ORIGIN,
    service: {
      getOwner,
      async getCardImage() {
        throw new Error("unused");
      },
      async getRecruits() {
        throw new Error("unused");
      },
      async updateDisplayName() {
        throw new Error("unused");
      },
    },
  });
}

async function assertBackpressure(
  name: string,
  response: Response,
  code: string,
): Promise<void> {
  assert.equal(response.status, 503, name);
  assert.equal(
    response.headers.get("retry-after"),
    String(UNAVAILABLE_RETRY_AFTER_SECONDS),
    name,
  );
  assert.equal(response.headers.get("cache-control"), "no-store", name);
  const body = (await response.json()) as { error: unknown };
  const reported =
    typeof body.error === "string"
      ? body.error
      : (body.error as { code: string }).code;
  assert.equal(reported, code, name);
  assert.doesNotMatch(
    JSON.stringify(body),
    /timeout exceeded|trying to connect/,
    name,
  );
}

test("owner reads answer a saturated pool with 503 and Retry-After", async () => {
  const ownerRequest = () => new Request(`${ORIGIN}/api/mission-control/owner`);
  await assertBackpressure(
    "owner session",
    await ownerRoutes(
      async () => {
        throw new MemberSessionError("SESSION_UNAVAILABLE");
      },
      async () => {
        throw new Error("unused");
      },
    ).owner(ownerRequest()),
    "SESSION_UNAVAILABLE",
  );
  await assertBackpressure(
    "owner profile",
    await ownerRoutes(
      async () => ({ profileId: "profile", scope: "member" }) as never,
      async () => {
        throw poolTimeout();
      },
    ).owner(ownerRequest()),
    "OWNER_UNAVAILABLE",
  );
});
