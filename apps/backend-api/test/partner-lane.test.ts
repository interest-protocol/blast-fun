import assert from "node:assert/strict";
import test from "node:test";
import { PARTNER_KEY_HEADER } from "@blast/core/modules/backend-api/partner-http.ts";
import { partnerCapacity } from "@blast/server/modules/partner-api-keys/capacity.ts";
import type { PartnerGrant } from "@blast/server/modules/partner-api-keys/contracts.ts";
import {
  PartnerRecognitionStore,
  type RecognitionDecision,
} from "@blast/server/modules/partner-api-keys/recognition-store.ts";
import type { PartnerRecognition } from "@blast/server/modules/partner-api-keys/recognition.ts";
import type { PartnerV1Handlers } from "@blast/server/modules/partner-api/v1/route.ts";
import { createBackendApi } from "../src/app/api/routing.ts";
import { capacityFixture } from "./capacity-fixture.ts";
import { testClient } from "../../../packages/core/test/fixtures/lib/web-security/client-address.ts";

const NAMESPACE = "a".repeat(64);
const PEPPER = "p".repeat(32);
const ORIGIN = "https://partner.example";
const KEY = `blast_pk_${"a".repeat(43)}`;
const GRANT: PartnerGrant = {
  id: "acme",
  keyId: "11111111-1111-4111-8111-111111111111",
  origins: [ORIGIN],
  policy: { tier: "standard" },
};

/** Partner admission with scripted recognition and an always-allowing quota store. */
function partnerLane(classify: RecognitionDecision, read: PartnerV1Handlers["presales"]) {
  const lookups: string[] = [];
  const redis = {
    async execute(command: string[]) {
      return command[0] === "EVALSHA" ? [1, 0, 0] : null;
    },
    connectionEpoch: () => 0,
    executeAtEpoch(command: string[]) {
      return redis.execute(command);
    },
  };
  const store = new PartnerRecognitionStore(
    redis,
    NAMESPACE,
    PEPPER,
    partnerCapacity(capacityFixture(["acme"])),
  );
  const recognition = {
    store,
    classify: async () => classify,
    responseWindow: (input: { tenant: string; internal: boolean }) =>
      store.responseWindow(input, 0),
    invalidate() {
      assert.fail("Recognition and the primary grant agree.");
    },
  } as unknown as PartnerRecognition;
  const handlers: PartnerV1Handlers = {
    market: read,
    prices: read,
    presales: read,
    featured: read,
    presale: read,
    discovery: read,
    search: read,
    defillama: read,
    wallet_launches: read,
    presale_proof: read,
    coin_metadata: read,
  };
  const api = createBackendApi({
    redis,
    namespace: NAMESPACE,
    subjectPepper: PEPPER,
    handlers: () => handlers,
    recognition,
    keys: {
      async verify() {
        lookups.push("verify");
        return GRANT;
      },
      async allowsOrigin() {
        lookups.push("allowsOrigin");
        return true;
      },
    },
  });

  return { lookups, send };

  async function send(request: Request): Promise<Response> {
    const prepared = await api.preparePartner(request, testClient("198.18.0.1"));
    assert.ok(prepared, "A versioned path reaches partner admission.");
    if (prepared.response) {
      return prepared.response;
    }
    try {
      return await prepared.handle();
    } finally {
      prepared.release();
    }
  }
}

function assertNoStore(response: Response) {
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("vercel-cdn-cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

test("partner preflights permit only read methods and the partner key header from an enabled origin", async () => {
  let reads = 0;
  const read = async () => {
    reads++;
    return Response.json({ public: true });
  };
  const preflight = (headers: Record<string, string>) =>
    new Request("https://backend.test/api/v1/presales", {
      method: "OPTIONS",
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "GET",
        "access-control-request-headers": "X-Blast-Partner-Key",
        ...headers,
      },
    });
  const enabled = partnerLane({ kind: "origin" }, read);

  const allowed = await enabled.send(preflight({}));
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(allowed.headers.get("access-control-allow-methods"), "GET, HEAD");
  assert.equal(allowed.headers.get("access-control-allow-headers"), PARTNER_KEY_HEADER);
  assertNoStore(allowed);

  for (const override of [
    { "access-control-request-method": "POST" },
    { "access-control-request-headers": "x-blast-partner-key,authorization" },
    { "access-control-request-headers": "" },
  ] as Record<string, string>[]) {
    const denied = await enabled.send(preflight(override));
    assert.equal(denied.status, 403, JSON.stringify(override));
    assert.equal((await denied.json()).error.code, "partner_origin_forbidden");
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
    assertNoStore(denied);
  }
  const unregistered = partnerLane({ kind: "unknown" }, read);
  const denied = await unregistered.send(preflight({ origin: "https://evil.example" }));
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);

  assert.equal(reads, 0, "A preflight never runs a read handler.");
  assert.deepEqual(
    [...enabled.lookups, ...unregistered.lookups],
    [],
    "Preflights are classified in Redis, never by a primary lookup.",
  );
});

test("the partner lane strips credentials and caller context before the public handler", async () => {
  let reads = 0;
  const lane = partnerLane(
    { kind: "known", identity: { tenant: GRANT.id, keyId: GRANT.keyId } },
    async (anonymous, client) => {
      reads++;
      assert.equal(client.address, "198.18.0.1");
      for (const name of [
        "cookie",
        "authorization",
        "x-blast-api-key",
        PARTNER_KEY_HEADER,
        "x-blast-home-rewrite",
        "x-blast-profile-rewrite",
        "x-blast-internal-user",
        "x-blast-gateway-signature",
        "origin",
      ]) {
        assert.equal(anonymous.headers.get(name), null, name);
      }
      assert.equal(new URL(anonymous.url).search, "?coin=a&coin=b&cursor=a%2Bb");
      return Response.json({ public: true }, { headers: { Vary: "Accept" } });
    },
  );

  for (const method of ["GET", "HEAD"]) {
    const response = await lane.send(
      new Request("https://backend.test/api/v1/presales?coin=a&coin=b&cursor=a%2Bb", {
        method,
        headers: {
          [PARTNER_KEY_HEADER]: KEY,
          origin: ORIGIN,
          cookie: "team=private",
          authorization: "Bearer private",
          "x-blast-api-key": "private",
          "x-blast-home-rewrite": "1",
          "x-blast-profile-rewrite": "1",
          "x-blast-internal-user": "spoofed",
          "x-blast-gateway-signature": "spoofed",
        },
      }),
    );
    assert.equal(response.status, 200, method);
    assert.equal(response.headers.get("access-control-allow-origin"), ORIGIN);
    assert.ok(response.headers.get("vary")?.includes("Accept"));
    assert.ok(response.headers.get("vary")?.includes("Origin"));
    assert.equal(response.headers.get("set-cookie"), null);
    assertNoStore(response);
    if (method === "HEAD") {
      assert.equal(await response.text(), "");
    }
  }
  assert.equal(reads, 2);
  assert.deepEqual(lane.lookups, ["verify", "verify"], "Every read takes one fresh primary grant.");
});
