import assert from "node:assert/strict";
import test from "node:test";
import type { VerifiedPrivateProof } from "@blast/core/modules/backend-api/private-gateway.ts";
import { cardHandlers } from "./cards.ts";
import { testClient } from "../../../core/test/fixtures/lib/web-security/client-address.ts";

test("both SSR card page owners consume the card budget for the attested client", async () => {
  for (const id of ["mission-control.card.page", "social.pnl-card.page"] as const) {
    const proof: VerifiedPrivateProof = {
      route: { id, method: "GET", path: "/", maxBodyBytes: 0 }, purpose: "ssr-read",
      namespace: "cards-test", siteOrigin: "https://blast.example", ip: "203.0.113.17",
      issued: "1", nonce: "test", bodySha256: "0".repeat(64),
    };
    const client = testClient(proof.ip);
    let calls = 0;
    const response = await cardHandlers(async (limited, buckets) => {
      calls++;
      assert.equal(limited, client);
      assert.deepEqual(buckets, ["mission_control_card_image"]);
      return new Response(null, { status: 429 });
    })[id](new Request("https://blast.example/card/unknown"), { proof, client });
    assert.equal(response.status, 429);
    assert.equal(calls, 1);
  }
});
