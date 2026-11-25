import assert from "node:assert/strict";
import test from "node:test";
import { ingressAddress, ingressTrust } from "@blast/core/lib/web-security/ingress.ts";

test("explicit ingress modes reject implicit or broad proxy trust", () => {
  for (const environment of [
    {},
    { BLAST_BACKEND_INGRESS_MODE: "proxy" },
    { BLAST_BACKEND_INGRESS_MODE: "trusted-proxy" },
    { BLAST_BACKEND_INGRESS_MODE: "direct", BLAST_BACKEND_TRUSTED_PROXY_CIDRS: "127.0.0.1/32" },
  ]) {
    assert.throws(() => ingressTrust(environment));
  }
  for (const cidr of [
    "0.0.0.0/0",
    "::/0",
    "10.0.0.0/8",
    "10.0.0.0/12",
    "8.0.0.0/13",
    "192.168.0.0/16",
    "172.16.0.0/12",
    "fc00::/7",
    "::ffff:0:0/96",
    "bad/32",
  ]) {
    assert.throws(
      () =>
        ingressTrust({
          BLAST_BACKEND_INGRESS_MODE: "trusted-proxy",
          BLAST_BACKEND_TRUSTED_PROXY_CIDRS: cidr,
        }),
      cidr,
    );
  }
});

test("a private 10/8 proxy range may be as wide as /13", () => {
  const trust = ingressTrust({
    BLAST_BACKEND_INGRESS_MODE: "trusted-proxy",
    BLAST_BACKEND_TRUSTED_PROXY_CIDRS: "10.24.0.0/13",
  });
  const request = new Request("https://backend.test", {
    headers: { "x-forwarded-for": "198.51.100.7" },
  });
  assert.equal(ingressAddress(request, "10.31.155.4", trust), "198.51.100.7");
  assert.equal(ingressAddress(request, "10.32.0.1", trust), null, "outside the /13");
});

test("proxy CIDRs normalize mapped IPv6 and key on the entry the proxy appended", () => {
  const trust = ingressTrust({
    BLAST_BACKEND_INGRESS_MODE: "trusted-proxy",
    BLAST_BACKEND_TRUSTED_PROXY_CIDRS: "127.0.0.0/24,2001:db8:feed::/64,::ffff:192.0.2.0/120",
  });
  const request = (ip: string) =>
    new Request("https://backend.test", { headers: { "x-forwarded-for": ip } });
  for (const peer of ["127.0.0.2", "::ffff:127.0.0.2", "2001:db8:feed::a", "192.0.2.3"]) {
    assert.equal(ingressAddress(request("::ffff:198.51.100.7"), peer, trust), "198.51.100.7");
  }
  assert.equal(ingressAddress(request("198.51.100.7"), "127.0.1.1", trust), null);
  // A client-sent X-Forwarded-For arrives first; the proxy appends the real client last.
  for (const forged of [
    "203.0.113.1, 198.51.100.7",
    "203.0.113.1,::ffff:198.51.100.7",
    "junk, 198.51.100.7",
  ]) {
    assert.equal(ingressAddress(request(forged), "127.0.0.2", trust), "198.51.100.7", forged);
  }
  for (const ip of [
    "",
    "198.51.100.7, ",
    "203.0.113.1, 198.51.100.7:90",
    "198.51.100.7:90",
    "unavailable",
    "fe80::1%eth0",
  ]) {
    assert.equal(ingressAddress(request(ip), "127.0.0.2", trust), null, ip);
  }
  const duplicate = new Headers();
  duplicate.append("x-forwarded-for", "203.0.113.1");
  duplicate.append("x-forwarded-for", "198.51.100.7");
  assert.equal(
    ingressAddress(new Request("https://backend.test", { headers: duplicate }), "127.0.0.2", trust),
    "198.51.100.7",
    "repeated headers join in order; the last is the proxy's",
  );
  const direct = ingressTrust({ BLAST_BACKEND_INGRESS_MODE: "direct" });
  assert.equal(
    ingressAddress(request("203.0.113.9"), "::ffff:198.51.100.7", direct),
    "198.51.100.7",
  );
  assert.equal(ingressAddress(request("203.0.113.9"), null, direct), null);
});

test("even a valid gateway proof cannot bypass trusted ingress peer validation", async () => {
  const { createBackendHttp } = await import("../src/app/server.ts");
  const { signGatewayRequest } = await import("@blast/core/modules/backend-api/gateway.ts");
  let work = 0;
  const namespace = "a".repeat(64);
  const secret = "s".repeat(32);
  const http = createBackendHttp({
    namespace,
    gatewaySecret: secret,
    ingress: ingressTrust({
      BLAST_BACKEND_INGRESS_MODE: "trusted-proxy",
      BLAST_BACKEND_TRUSTED_PROXY_CIDRS: "192.0.2.0/24",
    }),
    redis: {
      async execute() {
        work++;
        return "OK";
      },
    },
    ready: async () => true,
    async handle() {
      work++;
      return Response.json({ ok: true });
    },
  });
  const target = new Request("https://backend.test/internal/public-read/api/v1/prices");
  const signed = new Request(target, {
    headers: signGatewayRequest(target, secret, "198.51.100.7", namespace),
  });
  const response = await http.fetch(signed, "127.0.0.1");
  assert.equal(response.status, 503);
  assert.equal(work, 0);
  await response.body?.cancel();
  await http.drain();
});
