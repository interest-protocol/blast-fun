import assert from "node:assert/strict";
import test from "node:test";

import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "@blast/core/lib/web-security/mutation-guard.ts";
import { MemberSessionError } from "@blast/server/modules/mission-control/member-sessions/index.ts";
import type {
  DisplayNameDto,
  OwnerProfileDto,
  OwnerRecruitPageDto,
} from "@blast/core/modules/mission-control/owner-profile/contracts.ts";
import { OwnerRecruitCursorCodec } from "@blast/server/modules/mission-control/owner-profile/cursor.server.ts";
import { OwnerProfileError } from "@blast/server/modules/mission-control/owner-profile/errors.ts";
import { createOwnerRouteHandlers } from "@blast/server/modules/mission-control/owner-profile/route.ts";
import { normalizeOwnerDisplayName } from "@blast/server/modules/mission-control/owner-profile/service.ts";

const ORIGIN = "https://blast.fun";
const PROFILE_ID = "4cd44a35-f169-4a44-8ed7-255de22102bb";
const CSRF = "c".repeat(43);

const OWNER: OwnerProfileDto = {
  callsignPath: "/crew/pilot_one",
  profile: {
    avatarReference: null,
    callsign: "pilot_one",
    displayName: "Pilot One",
    resolvedDisplayName: "Pilot One",
  },
  social: {
    avatarReference: "https://pbs.twimg.com/pilot.png",
    handle: "pilot",
    verified: true,
  },
  wallet: {
    address: `0x${"12".repeat(32)}`,
    kind: "embedded",
    state: "verified",
  },
  wallets: [{
    id: "4cd44a35-f169-4a44-8ed7-255de22102bb",
    address: `0x${"12".repeat(32)}`,
    kind: "embedded",
    primary: true,
    state: "verified",
  }],
  membership: {
    crewNumber: 7,
    fleet: "Recon",
    fleetTitle: "Recon Fleet",
    gold: true,
    ownerTitle: "Zero Fleet Commando",
    zeroFleet: true,
  },
  card: { id: "card-safe" },
  recruitTotal: 31,
  codeTotal: 2,
  rewards: { followedBlast: true, rewarded: true, sharedOnX: true, telegramUsername: null },
};

function harness(options: { cardError?: unknown; signedIn?: boolean } = {}) {
  let updated: unknown = Symbol("unchanged");
  let cardReads = 0;
  const recruits: OwnerRecruitPageDto = { items: [], nextCursor: null };
  const handlers = createOwnerRouteHandlers({
    expectedOrigin: ORIGIN,
    async authenticate() {
      if (options.signedIn === false) throw new MemberSessionError("SESSION_INVALID");
      return {
        expiresAt: new Date("2026-09-21T00:00:00.000Z"),
        profileId: PROFILE_ID,
        scope: "member" as const,
        sessionId: "session-id",
      };
    },
    service: {
      async getCardImage() {
        cardReads++;
        if (options.cardError) throw options.cardError;
        return {
          callsign: OWNER.profile.callsign,
          image: {
            bytes: Buffer.from("png-fixture"),
            cardId: OWNER.card.id,
            contentType: "image/png" as const,
            height: 1500 as const,
            width: 2100 as const,
          },
        };
      },
      async getOwner() { return OWNER; },
      async getRecruits() { return recruits; },
      async updateDisplayName(_profileId, value) {
        updated = value;
        return {
          callsign: OWNER.profile.callsign,
          displayName: value as string | null,
          resolvedDisplayName: (value as string | null) ?? OWNER.profile.callsign,
        } satisfies DisplayNameDto;
      },
    },
  });
  return { handlers, updated: () => updated, cardReads: () => cardReads };
}

test("recruit cursors are opaque, authenticated, and round-trip the keyset position", () => {
  const codec = new OwnerRecruitCursorCodec(Buffer.alloc(32, 7), () => Buffer.alloc(12, 3));
  const position = {
    completedAt: "2026-09-20T12:00:00.000Z",
    profileId: PROFILE_ID,
  };
  const encoded = codec.encode(position);
  assert.doesNotMatch(encoded, /2026|4cd44a35|profileId|completedAt/);
  assert.deepEqual(codec.decode(encoded), position);
  assert.equal(codec.decode(`${encoded.slice(0, -1)}x`), null);
});

test("display names normalize whitespace, clear to callsign, and reject unsafe input", () => {
  assert.equal(normalizeOwnerDisplayName("  Pilot   One  "), "Pilot One");
  assert.equal(normalizeOwnerDisplayName("   "), null);
  assert.equal(normalizeOwnerDisplayName(null), null);
  assert.throws(() => normalizeOwnerDisplayName("Pilot\u0000One"), OwnerProfileError);
  assert.throws(() => normalizeOwnerDisplayName("x".repeat(101)), OwnerProfileError);
});

test("owner routes require a member session and expose only owner-safe data", async () => {
  const signedOut = harness({ signedIn: false });
  const unknown = await signedOut.handlers.owner(new Request(`${ORIGIN}/api/mission-control/owner`));
  assert.equal(unknown.status, 401);
  assert.deepEqual(await unknown.json(), {
    error: {
      code: "SESSION_INVALID",
      message: "The member session is invalid or expired.",
    },
  });

  const { handlers } = harness();
  const response = await handlers.owner(new Request(`${ORIGIN}/api/mission-control/owner`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const payload = await response.json() as { owner: OwnerProfileDto };
  assert.deepEqual(payload.owner.wallet, OWNER.wallet);
  assert.equal(payload.owner.wallet.address.length, 66);
  assert.equal(payload.owner.social.verified, true);
  const body = JSON.stringify(payload);
  assert.match(body, /pilot_one/);
  assert.doesNotMatch(
    body,
    /privy|providerWallet|foundryLaunchMethod|signature|session-id|raw.*code|secret/i,
  );
});

test("card image route is owner-authorized, no-store, and download-safe", async () => {
  const signedOut = harness({ signedIn: false });
  assert.equal(
    (await signedOut.handlers.card(new Request(`${ORIGIN}/api/mission-control/owner/card`))).status,
    401,
  );

  assert.equal(signedOut.cardReads(), 0, "authentication fails before the renderer service is called");

  const { handlers } = harness();
  const inline = await handlers.card(new Request(`${ORIGIN}/api/mission-control/owner/card`));
  assert.equal(inline.status, 200);
  assert.equal(inline.headers.get("content-type"), "image/png");
  assert.equal(inline.headers.get("content-length"), String(Buffer.byteLength("png-fixture")));
  assert.equal(inline.headers.get("cache-control"), "private, no-store");
  assert.match(inline.headers.get("content-disposition") ?? "", /^inline;/);
  assert.equal(Buffer.from(await inline.arrayBuffer()).toString(), "png-fixture");

  const download = await handlers.card(new Request(
    `${ORIGIN}/api/mission-control/owner/card?download=1`,
  ));
  assert.match(download.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.doesNotMatch(download.headers.get("content-disposition") ?? "", /[\r\n]/);

  const unavailable = createOwnerRouteHandlers({
    expectedOrigin: ORIGIN,
    async authenticate() {
      return {
        expiresAt: new Date("2026-09-21T00:00:00.000Z"),
        profileId: PROFILE_ID,
        scope: "member" as const,
        sessionId: "session-id",
      };
    },
    service: {
      async getCardImage() {
        throw new OwnerProfileError("CARD_UNAVAILABLE");
      },
      async getOwner() { return OWNER; },
      async getRecruits() { return { items: [], nextCursor: null }; },
      async updateDisplayName() {
        return { callsign: "pilot_one", displayName: null, resolvedDisplayName: "pilot_one" };
      },
    },
  });
  const failed = await unavailable.card(new Request(`${ORIGIN}/api/mission-control/owner/card`));
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("retry-after"), "5");
  assert.deepEqual(await failed.json(), {
    error: {
      code: "CARD_UNAVAILABLE",
      message: "The saved card could not be rendered. Please retry.",
    },
  });
});

test("a shed card render answers 503 no-store with Retry-After", async () => {
  const { handlers } = harness({ cardError: new OwnerProfileError("CARD_BUSY") });
  const busy = await handlers.card(new Request(`${ORIGIN}/api/mission-control/owner/card?format=share`));
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get("retry-after"), "5");
  assert.equal(busy.headers.get("cache-control"), "no-store");
  assert.deepEqual(await busy.json(), {
    error: {
      code: "CARD_BUSY",
      message: "Cards are busy rendering. Please retry in a few seconds.",
    },
  });
});

test("display-name mutation is CSRF protected and accepts only its one public field", async () => {
  const { handlers, updated } = harness();
  const untrusted = await handlers.displayName(new Request(
    `${ORIGIN}/api/mission-control/owner/display-name`,
    {
      body: JSON.stringify({ displayName: "New Name" }),
      headers: { "content-type": "application/json", origin: ORIGIN },
      method: "PATCH",
    },
  ));
  assert.equal(untrusted.status, 403);
  assert.equal(typeof updated(), "symbol");

  const response = await handlers.displayName(new Request(
    `${ORIGIN}/api/mission-control/owner/display-name`,
    {
      body: JSON.stringify({ displayName: null }),
      headers: {
        cookie: `${CSRF_COOKIE_NAME}=${CSRF}`,
        "content-type": "application/json",
        origin: ORIGIN,
        [CSRF_HEADER_NAME]: CSRF,
      },
      method: "PATCH",
    },
  ));
  assert.equal(response.status, 200);
  assert.equal(updated(), null);
  assert.deepEqual(await response.json(), {
    profile: {
      callsign: "pilot_one",
      displayName: null,
      resolvedDisplayName: "pilot_one",
    },
  });

  const extraField = await handlers.displayName(new Request(
    `${ORIGIN}/api/mission-control/owner/display-name`,
    {
      body: JSON.stringify({ callsign: "changed", displayName: "Pilot" }),
      headers: {
        cookie: `${CSRF_COOKIE_NAME}=${CSRF}`,
        "content-type": "application/json",
        origin: ORIGIN,
        [CSRF_HEADER_NAME]: CSRF,
      },
      method: "PATCH",
    },
  ));
  assert.equal(extraField.status, 400);
});
