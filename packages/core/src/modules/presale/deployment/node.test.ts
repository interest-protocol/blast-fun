import assert from "node:assert/strict";
import test from "node:test";

import { SUI_MAINNET_GRPC_URL } from "@blast/core/lib/sui-mainnet.ts";
import { mainnetNodeUrl, presaleNodeUrl } from "./node.ts";
import { readPresaleDeploymentIdentity } from "./service.ts";
import { presaleIdentityFixture } from "../../../../test/fixtures/modules/presale/deployment/fixtures.ts";

/** The server's mainnet node: `PRESALE_SUI_GRPC_URL` under the presale node's rules, else the public fullnode. */

const PRODUCTION = [{ BLAST_DEPLOYMENT_TARGET: "production" }, { BLAST_WORKER_ENVIRONMENT: "production" }] as const;

test("unset, the mainnet node is the public fullnode, in production too", () => {
  assert.equal(mainnetNodeUrl({}), SUI_MAINNET_GRPC_URL);
  assert.equal(mainnetNodeUrl({ PRESALE_SUI_GRPC_URL: "  " }), SUI_MAINNET_GRPC_URL, "blank is unset");
  for (const production of PRODUCTION) assert.equal(mainnetNodeUrl(production), SUI_MAINNET_GRPC_URL);
});

test("a configured https node is used, trimmed and without its trailing slash", () => {
  assert.equal(mainnetNodeUrl({ PRESALE_SUI_GRPC_URL: " https://rpc.example/ " }), "https://rpc.example");
  for (const production of PRODUCTION) {
    assert.equal(mainnetNodeUrl({ ...production, PRESALE_SUI_GRPC_URL: "https://rpc.example:8443/key" }), "https://rpc.example:8443/key");
  }
});

test("a refused value is null, never the public fullnode", () => {
  for (const value of ["not a url", "http://rpc.example", "http://10.0.0.8:9000", "ftp://rpc.example", "ws://127.0.0.1:9000"]) {
    assert.equal(mainnetNodeUrl({ PRESALE_SUI_GRPC_URL: value }), null, value);
  }
  for (const production of PRODUCTION) {
    assert.equal(mainnetNodeUrl({ ...production, PRESALE_SUI_GRPC_URL: "http://127.0.0.1:9000" }), null, "production takes only https");
    assert.equal(mainnetNodeUrl({ ...production, PRESALE_SUI_GRPC_URL: "http://rpc.example" }), null);
  }
});

test("loopback http is refused in every environment; loopback https is a node like any other (#856)", () => {
  for (const value of ["http://127.0.0.1:9000/", "http://localhost:9000", "http://127.5.6.7:9000/", "http://[::1]:9000"]) {
    for (const environment of [{}, ...PRODUCTION]) {
      assert.equal(mainnetNodeUrl({ ...environment, PRESALE_SUI_GRPC_URL: value }), null, value);
    }
  }
  assert.equal(mainnetNodeUrl({ PRESALE_SUI_GRPC_URL: "https://127.0.0.1:9000/" }), "https://127.0.0.1:9000");
});

test("the presale node is the mainnet node while an identity is in force, else none", () => {
  const fixture = readPresaleDeploymentIdentity({ PRESALE_DEPLOYMENT_MANIFEST: JSON.stringify(presaleIdentityFixture()) });
  assert.equal(fixture.status, "ready");
  assert.equal(presaleNodeUrl(fixture, "https://rpc.example"), "https://rpc.example");
  assert.equal(presaleNodeUrl(readPresaleDeploymentIdentity({}), SUI_MAINNET_GRPC_URL), null, "no identity, no node");
});
