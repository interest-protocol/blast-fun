import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { privateRoute } from "@blast/core/modules/backend-api/private-routes.ts";
import { signPrivateRequest } from "@blast/core/modules/backend-api/private-gateway.ts";
import { quotaNamespace } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { createPresaleDeploymentGate } from "@blast/core/modules/presale/deployment/service.ts";
import { createPresaleRouteKit } from "@blast/core/modules/presale/route-kit/route.ts";
import { CardImageService } from "@blast/server/modules/mission-control/card-images/service.ts";
import { renderPresaleReceiptPng } from "@blast/server/modules/mission-control/card-renderer/presale-receipt-svg.ts";
import { createPresaleReceiptRoute } from "@blast/server/modules/presale/receipts/routes.ts";
import { privateBackendRelay } from "@blast/server/private/relay.ts";
import { parseRelayConfig } from "@blast/server/private/relay-config.ts";
import { createBackendServer } from "../src/app/server.ts";

const origin = "https://frontend.test";
const environment = {
  NEXT_PUBLIC_SITE_URL: origin + "/",
  BLAST_REDIS_NAMESPACE: "local-native-receipt",
  BLAST_BACKEND_GATEWAY_SECRET: "synthetic-receipt-transport-secret-0123456789",
};
const sale = "0x" + "a1".repeat(32);
const wallet = "0x" + "b2".repeat(32);
const path = `/api/presale/receipts/${sale}/${wallet}/image`;

test(
  "native signed receipt transport preserves PNG formats, HEAD, public owner bucket and errors",
  { timeout: 30_000 },
  async () => {
    let committed = true;
    let available = true;
    let calls = 0;
    const buckets: string[] = [];
    const kit = createPresaleRouteKit({
      expectedOrigin: origin,
      verifyAccessToken: async () => {
        throw new Error("public receipt does not read account tokens");
      },
      limiter: {
        async consume(bucket) {
          buckets.push(bucket);
          return { allowed: true, bucket, policyVersion: 1, retryAfterSeconds: 0 };
        },
      },
      deployment: createPresaleDeploymentGate({
        environment: {},
        node: async () => {
          throw new Error("unverified receipt does not query a chain node");
        },
      }),
    });
    const images = new CardImageService({
      memoryCacheBytes: 8 * 1024 * 1024,
      persistence: null,
      render: async () => {
        throw new Error("receipt does not render a season card");
      },
      renderReceipt: async (record, format) =>
        (await renderPresaleReceiptPng(record, format)).bytes,
    });
    const handler = createPresaleReceiptRoute({
      kit,
      readPath: {
        async commits() {
          return committed ? [{ timestampMs: 1, walletCommitment: "1234567890" }] : [];
        },
        async sale() {
          return {
            saleToken: "0x" + "c3".repeat(32) + "::coin::COIN",
            quote: "0x" + "d4".repeat(32) + "::quote::QUOTE",
            lifecycle: "open",
          };
        },
      },
      metadata: async () => {
        if (!available) {
          throw new Error("synthetic unavailable metadata");
        }
        return { name: "Fixture", symbol: "FIX", decimals: 9, iconUrl: null };
      },
      crew: async () => 42,
      logo: async () => ({ logo: null, transient: false }),
      images,
    });
    const runtime = createBackendServer({
      namespace: quotaNamespace(environment.BLAST_REDIS_NAMESPACE, deploymentIdentity(environment)),
      gatewaySecret: environment.BLAST_BACKEND_GATEWAY_SECRET,
      redis: { execute: async () => "OK" },
      ready: async () => true,
      handle: async () => {
        assert.fail("private receipts never use partner admission");
      },
      privateApi: {
        siteOrigin: origin,
        async handle(request, { client }) {
          calls++;
          return handler(request, client);
        },
      },
    });
    const relay = privateBackendRelay(
      parseRelayConfig({
        ...environment,
        BLAST_BACKEND_API_ORIGIN: `http://127.0.0.1:${runtime.server.port}`,
      }),
      { clientAddress: () => "192.0.2.19" },
    );
    const request = (suffix = "?format=card", options: RequestInit = {}) =>
      relay(new Request(origin + path + suffix, options));
    try {
      for (const [format, width, height] of [
        ["card", 2100, 1500],
        ["post", 1200, 675],
      ] as const) {
        const response = await request("?format=" + format);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "image/png");
        assert.equal(
          response.headers.get("content-length"),
          null,
          "existing relay intentionally strips entity length",
        );
        const image = Buffer.from(await response.arrayBuffer());
        const metadata = await sharp(image).metadata();
        assert.deepEqual(
          [metadata.format, metadata.width, metadata.height],
          ["png", width, height],
        );
        assert.ok(response.headers.get("cache-control"));
      }
      const head = await request("?format=card", { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
      const bad = await request("?format=invalid");
      assert.equal(bad.status, 400);
      assert.equal((await bad.json()).error.code, "invalid_parameter");
      committed = false;
      const absent = await request();
      assert.equal(absent.status, 404);
      assert.equal((await absent.json()).error.code, "not_found");
      committed = true;
      available = false;
      const unavailable = await request();
      assert.equal(unavailable.status, 503);
      assert.equal((await unavailable.json()).error.code, "service_unavailable");
      const beforeBody = calls;
      assert.equal(privateRoute("GET", path, "browser")?.maxBodyBytes, 0);
      assert.throws(() =>
        signPrivateRequest(
          new Request(origin + path),
          new Uint8Array(1),
          environment.BLAST_BACKEND_GATEWAY_SECRET,
          {
            namespace: quotaNamespace(
              environment.BLAST_REDIS_NAMESPACE,
              deploymentIdentity(environment),
            ),
            purpose: "browser",
            siteOrigin: origin,
            ip: "192.0.2.19",
          },
        ),
      );
      assert.equal(calls, beforeBody);
      assert.ok(buckets.length >= 6);
      assert.ok(buckets.every((bucket) => bucket === "presale_receipt"));
    } finally {
      await runtime.drain();
    }
  },
);
