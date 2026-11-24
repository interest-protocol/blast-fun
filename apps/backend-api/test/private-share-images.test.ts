import assert from "node:assert/strict";
import test from "node:test";
import { privateRoute } from "@blast/core/modules/backend-api/private-routes.ts";
import { signPrivateRequest } from "@blast/core/modules/backend-api/private-gateway.ts";

const sale = "0x" + "a1".repeat(32);
test("share image capabilities preserve public GET/HEAD and zero-body bounded lifetimes", () => {
  for (const [path, id] of [
    [`/presale/${sale}/share-image`, "presale.share.image"],
    ["/referral/new_friend/image", "social.referral.image"],
  ]) {
    for (const method of ["GET", "HEAD"]) {
      const contract = privateRoute(method, path, "browser");
      assert.equal(contract?.id, id);
      assert.equal(contract.maxBodyBytes, 0);
      assert.equal(contract.workBudgetMs, 90_000);
      assert.equal(privateRoute(method, path, "ssr-read"), null);
      const options = {
        namespace: "c".repeat(64),
        purpose: "browser" as const,
        siteOrigin: "https://frontend.test",
        ip: "192.0.2.11",
      };
      assert.throws(() =>
        signPrivateRequest(
          new Request("https://frontend.test" + path, { method }),
          new Uint8Array(1),
          "synthetic-share-gateway-secret-0123456789",
          options,
        ),
      );
    }
    for (const method of ["POST", "PUT", "DELETE"]) {
      assert.equal(privateRoute(method, path, "browser"), null);
    }
  }
});

test("public inviter metadata is available only to one bounded SSR GET capability", () => {
  const path = "/api/social/referral-inviter/new_friend";
  assert.equal(privateRoute("GET", path, "ssr-read")?.id, "social.referral.context");
  assert.equal(privateRoute("GET", path, "ssr-read")?.maxBodyBytes, 0);
  assert.equal(privateRoute("GET", path, "browser"), null);
  for (const method of ["HEAD", "POST", "PUT", "DELETE"]) {
    assert.equal(privateRoute(method, path, "ssr-read"), null);
  }
});
