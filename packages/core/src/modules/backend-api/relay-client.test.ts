import assert from "node:assert/strict";
import test from "node:test";
import { verifyGatewayRequest } from "./gateway.ts";
import { HOP_BY_HOP_HEADERS } from "./hop-by-hop.ts";
import { verifyPrivateRequest } from "./private-gateway.ts";
import { callBackend, type BackendSigning } from "./relay-client.ts";

const SECRET = "s".repeat(32);
const NAMESPACE = "a".repeat(64);
const SITE = "https://frontend.test";
const dropped = (): [string, string][] => HOP_BY_HOP_HEADERS.map((name) => [name, "drop"]);

/** Relays one call carrying every hop-by-hop field both ways and checks none crossed. */
async function relayThrough(signing: BackendSigning): Promise<Request> {
  let sent: Request | undefined;
  const response = await callBackend({
    url: new URL("https://api.blast.test/api/social/me?x=1"),
    method: "GET",
    headers: new Headers([...dropped(), ["host", "evil.test"], ["content-length", "0"], ["x-kept", "yes"]]),
    signing,
    signal: new AbortController().signal,
    timeoutMs: 5_000,
    redirect: "error",
    fetch: async (input, init) => {
      sent = new Request(input, init);
      return new Response(null, {
        status: 207,
        headers: [
          ...dropped(),
          ["connection", "x-listed"],
          ["x-listed", "drop"],
          ["content-encoding", "gzip"],
          ["content-length", "2"],
          ["x-kept", "yes"],
        ],
      });
    },
  });
  assert.ok(sent);
  for (const name of [...HOP_BY_HOP_HEADERS, "host", "content-length"]) {
    assert.equal(sent.headers.has(name), false, `sent ${name}`);
  }
  assert.equal(sent.headers.get("x-kept"), "yes");
  assert.equal(sent.redirect, "error");
  assert.equal(response.status, 207);
  assert.deepEqual([...response.headers], [["x-kept", "yes"]]);
  return sent;
}

// These fail if a relay forwards a connection-specific field upstream or back to its caller,
// or if signing stops covering what is actually sent.
test("a gateway-signed call strips hop-by-hop fields both ways and verifies", async () => {
  const sent = await relayThrough({ scheme: "gateway", secret: SECRET, ip: "198.18.0.1", namespace: NAMESPACE });
  assert.ok(verifyGatewayRequest(sent, SECRET, NAMESPACE));
});

test("a privately signed call strips hop-by-hop fields both ways and verifies", async () => {
  const context = { namespace: NAMESPACE, purpose: "browser", siteOrigin: SITE, ip: "198.18.0.1" } as const;
  const sent = await relayThrough({ scheme: "private", secret: SECRET, context });
  assert.ok(verifyPrivateRequest(sent, new Uint8Array(), SECRET, { namespace: NAMESPACE, siteOrigin: SITE }));
});

test("an unsigned call strips hop-by-hop fields both ways and adds nothing", async () => {
  const sent = await relayThrough({ scheme: "unsigned" });
  assert.deepEqual([...sent.headers], [["x-kept", "yes"]]);
});
