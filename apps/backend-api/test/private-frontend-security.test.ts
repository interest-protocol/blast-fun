import assert from "node:assert/strict";
import test from "node:test";
import { privateRoute } from "@blast/core/modules/backend-api/private-routes.ts";
import { signPrivateRequest } from "@blast/core/modules/backend-api/private-gateway.ts";

test("bootstrap capabilities accept only exact browser methods and reviewed body bounds", () => {
  for (const [path, method, id, bytes] of [
    ["/api/gate", "GET", "frontend.gate.refresh", 0],
  ] as const) {
    const contract = privateRoute(method, path, "browser");
    assert.equal(contract?.id, id);
    assert.equal(contract.maxBodyBytes, bytes);
    assert.equal(contract.workBudgetMs, 30_000);
    for (const other of ["GET", "HEAD", "POST", "PUT", "DELETE"]) {
      if (method !== other) {
        assert.equal(privateRoute(other, path, "browser"), null);
      }
    }
    assert.equal(privateRoute(method, path, "ssr-read"), null);
    assert.equal(privateRoute(method, path + "/extra", "browser"), null);
    assert.throws(() =>
      signPrivateRequest(
        new Request("https://frontend.test" + path, { method }),
        new Uint8Array(bytes + 1),
        "synthetic-bootstrap-gateway-secret-0123456789",
        {
          namespace: "c".repeat(64),
          purpose: "browser",
          siteOrigin: "https://frontend.test",
          ip: "192.0.2.1",
        },
      ),
    );
  }
});
