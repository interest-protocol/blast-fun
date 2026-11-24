import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { toBase58 } from "@mysten/sui/utils";
import { BLAST_DEPLOYMENTS, deploymentFingerprint, presaleDeployment } from "@interest-protocol/blast-sdk/deployments";

import { PresaleRouteError } from "../route-kit/errors.ts";
import { presaleNode } from "./node.ts";
import {
  createPresaleDeploymentGate,
  parsePresaleRuntimeIdentity,
  readPresaleDeploymentIdentity,
} from "./service.ts";
import {
  fixtureChainNode,
  presaleIdentityFixture,
  SUI_MAINNET_CHAIN_IDENTIFIER,
  SUI_TESTNET_CHAIN_IDENTIFIER,
} from "../../../../test/fixtures/modules/presale/deployment/fixtures.ts";
import { startFixtureHttpsNode } from "../../../../test/fixtures/modules/presale/deployment/https-node.ts";

/** T-008: one presale deployment identity that fails closed (AC-004, AC-005). */

const nonProduction = (manifest: unknown) => ({
  PRESALE_DEPLOYMENT_MANIFEST: typeof manifest === "string" ? manifest : JSON.stringify(manifest),
});
const canonical = BLAST_DEPLOYMENTS.mainnet!;
const production = {
  BLAST_DEPLOYMENT_TARGET: "production",
  BLAST_NETWORK: "mainnet",
  BLAST_DEPLOYMENT_FINGERPRINT: deploymentFingerprint(canonical),
};

function hashId(label: string): string {
  return `0x${createHash("sha256").update(label).digest("hex")}`;
}

/** A mainnet identity whose IDs look like published ones (hash-derived, not SDK fixtures). */
function mainnetIdentity(overrides: Record<string, unknown> = {}) {
  const shared = (label: string) => ({ objectId: hashId(`mainnet-${label}`), initialSharedVersion: "614" });
  return presaleIdentityFixture({
    presale: {
      ...(presaleIdentityFixture().presale as object),
      packageId: hashId("mainnet-presale"),
      originalPackageId: hashId("mainnet-presale"),
      packageVersion: shared("package-version"),
      packageAdmin: shared("package-admin"),
      presaleRegistry: shared("presale-registry"),
      creationPolicy: shared("creation-policy"),
      feePolicy: shared("fee-policy"),
      admin: { packageId: hashId("mainnet-admin"), originalPackageId: hashId("mainnet-admin"), acl: shared("acl") },
    },
    venues: {},
    ...overrides,
  });
}

function reason(environment: Record<string, string>) {
  const state = readPresaleDeploymentIdentity(environment);
  return state.status === "unavailable" ? state.reason : "ready";
}

test("a valid identity loads and keeps its SDK-normalized presale deployment", () => {
  const state = readPresaleDeploymentIdentity(nonProduction(presaleIdentityFixture()));
  assert.equal(state.status, "ready");
  assert.ok(state.status === "ready");
  assert.equal(state.identity.network, "mainnet");
  assert.equal(state.identity.chainIdentifier, SUI_MAINNET_CHAIN_IDENTIFIER);
  assert.equal(state.identity.presale.packageVersion.initialSharedVersion, "7");
  assert.equal(state.identity.cctp, undefined);
  assert.equal(readPresaleDeploymentIdentity(production).status, "ready");
});

test("production selects the published registry identity and requires its exact fingerprint", () => {
  const override = nonProduction(presaleIdentityFixture());
  const state = readPresaleDeploymentIdentity({ ...override, ...production });
  assert.ok(state.status === "ready");
  assert.equal(state.identity.manifest, canonical);
  assert.deepEqual(state.identity.presale, presaleDeployment(canonical));
  assert.equal(reason({ ...production, BLAST_DEPLOYMENT_FINGERPRINT: "0".repeat(64) }), "deployment_mismatch");
  assert.equal(reason({ ...override, BLAST_DEPLOYMENT_TARGET: "production" }), "missing");
});

test("a missing or malformed identity is unavailable, with a value-free reason", () => {
  assert.equal(reason({}), "missing");
  assert.equal(reason({ PRESALE_DEPLOYMENT_MANIFEST: "  " }), "missing");
  assert.equal(reason(nonProduction("{not json")), "malformed");
  assert.equal(reason(nonProduction([])), "malformed");
  for (const broken of [
    presaleIdentityFixture({ schemaVersion: 1 }),
    presaleIdentityFixture({ extra: true }),
    presaleIdentityFixture({ network: 1 }),
    presaleIdentityFixture({ chainIdentifier: "not-a-digest" }),
    presaleIdentityFixture({ contractsCommit: "eca9b25" }),
    presaleIdentityFixture({ sdkCommit: "D9E62FE0000000000000000000000000000000AA" }),
    presaleIdentityFixture({ publishCheckpoint: 1200 }),
    presaleIdentityFixture({ presale: { ...(presaleIdentityFixture().presale as object), packageId: "0x0" } }),
    presaleIdentityFixture({ presale: { ...(presaleIdentityFixture().presale as object), feePolicy: undefined } }),
    presaleIdentityFixture({ venues: { cetus: { globalConfig: { objectId: hashId("x"), initialSharedVersion: "0" } } } }),
    presaleIdentityFixture({ venues: { orca: {} } }),
    presaleIdentityFixture({ cctp: { messageTransmitter: hashId("mt") } }),
  ]) {
    assert.equal(reason(nonProduction(broken)), "malformed", JSON.stringify(broken).slice(0, 120));
  }
  const missingField = presaleIdentityFixture();
  delete missingField.publishCheckpoint;
  assert.equal(reason(nonProduction(missingField)), "malformed");
  const fixture = presaleIdentityFixture();
  const presale = fixture.presale as Record<string, unknown>;
  assert.equal(reason(nonProduction({ ...fixture, presale: { ...presale, admin: undefined, adminRegistry: presale.admin } })), "malformed");
});

test("only mainnet is accepted, in every environment, and its genesis must match (#856)", () => {
  const parseProduction = (manifest: unknown) => parsePresaleRuntimeIdentity(manifest, { production: true });
  for (const network of ["localnet", "testnet", "devnet", "Mainnet"]) {
    assert.equal(reason(nonProduction(presaleIdentityFixture({ network }))), "network_not_allowed", network);
    assert.throws(() => parseProduction(mainnetIdentity({ network })), /network_not_allowed/, network);
  }
  assert.equal(
    reason(nonProduction(presaleIdentityFixture({ chainIdentifier: SUI_TESTNET_CHAIN_IDENTIFIER }))),
    "network_mismatch",
  );
  const localGenesis = toBase58(createHash("sha256").update("a localnet genesis").digest());
  assert.equal(reason(nonProduction(mainnetIdentity({ chainIdentifier: localGenesis }))), "network_mismatch");
});

test("the manifest parser refuses fixture IDs under production validation", () => {
  const parseProduction = (manifest: unknown) => parsePresaleRuntimeIdentity(manifest, { production: true });
  assert.throws(() => parseProduction(presaleIdentityFixture()), /fixture_identity/);
  // Hand-written IDs below 2^64 and the SDK's own test manifest IDs are fixtures.
  const smallId = mainnetIdentity();
  (smallId.presale as Record<string, unknown>).packageId = "0x2a";
  assert.throws(() => parseProduction(smallId), /fixture_identity/);
  const sdkFixture = mainnetIdentity();
  (sdkFixture.presale as Record<string, unknown>).feePolicy = {
    objectId: hashId("blast-sdk-nonprod-3"),
    initialSharedVersion: "1",
  };
  assert.throws(() => parseProduction(sdkFixture), /fixture_identity/);
  assert.equal(reason(nonProduction(sdkFixture)), "ready", "rehearsals may use fixture IDs");
  // The web's own fixture identity is mainnet-shaped, and a fixture all the same (B-004).
  assert.equal(reason(nonProduction(presaleIdentityFixture())), "ready");
  const oneFixtureVenue = mainnetIdentity({ venues: { bluefin: (presaleIdentityFixture().venues as Record<string, unknown>).bluefin } });
  assert.throws(() => parseProduction(oneFixtureVenue), /fixture_identity/);
  // System objects such as the deny list are not fixtures.
  const cctp = {
    messageTransmitter: hashId("mt-package"),
    tokenMessengerMinter: hashId("tmm-package"),
    mtState: { objectId: hashId("mt-state"), initialSharedVersion: "9" },
    tmmState: { objectId: hashId("tmm-state"), initialSharedVersion: "9" },
    usdcTreasury: { objectId: hashId("usdc-treasury"), initialSharedVersion: "9" },
    usdcType: `${hashId("usdc")}::usdc::USDC`,
    denyList: { objectId: "0x403", initialSharedVersion: "1" },
  };
  const withCctp = parseProduction(mainnetIdentity({ cctp }));
  assert.equal(withCctp.cctp?.denyList.objectId, `0x${"0".repeat(61)}403`);
});

test("production only exposes Aftermath when the SDK deployment registers it", () => {
  const state = readPresaleDeploymentIdentity(production);
  assert.ok(state.status === "ready");
  const vendor = presaleDeployment(canonical).aftermathDaoPresale;
  assert.deepEqual(state.identity.venues.aftermath, vendor && {
    vendorPackageId: vendor.packageId,
    ...vendor.aftermath,
  });
});

test("a local Aftermath vendor requires explicit shared objects and feeds the SDK deployment", () => {
  const fixture = presaleIdentityFixture();
  const state = readPresaleDeploymentIdentity(nonProduction(fixture));
  assert.ok(state.status === "ready");
  const aftermath = state.identity.venues.aftermath;
  assert.ok(aftermath);
  assert.deepEqual(state.identity.presale.aftermathDaoPresale, {
    packageId: aftermath.vendorPackageId,
    originalPackageId: aftermath.vendorPackageId,
    aftermath: { poolRegistry: aftermath.poolRegistry, daoFeeVersion: aftermath.daoFeeVersion },
  });

  const without = readPresaleDeploymentIdentity(nonProduction(presaleIdentityFixture({ venues: {} })));
  assert.ok(without.status === "ready");
  assert.equal(without.identity.venues.aftermath, undefined);
  assert.equal(without.identity.presale.aftermathDaoPresale, undefined);

  for (const broken of [
    {},
    { vendorPackageId: aftermath.vendorPackageId },
    { ...aftermath, vendorPackageId: "0x0" },
    { ...aftermath, extra: true },
    { ...aftermath, daoFeeVersion: { ...aftermath.daoFeeVersion, initialSharedVersion: "0" } },
    { ...aftermath, poolRegistry: { objectId: hashId("r") } },
  ]) {
    assert.equal(reason(nonProduction(presaleIdentityFixture({ venues: { aftermath: broken } }))), "malformed");
  }
  assert.throws(() => parsePresaleRuntimeIdentity(mainnetIdentity({ venues: { aftermath } }), { production: true }), /fixture_identity/);
});

test("with no identity, identity-dependent work is deployment_unavailable", async () => {
  const node = fixtureChainNode(SUI_MAINNET_CHAIN_IDENTIFIER);
  const gate = createPresaleDeploymentGate({ environment: {}, node: async () => node });
  assert.throws(() => gate.identity(), isCode("deployment_unavailable"));
  await assert.rejects(gate.authorize(), isCode("deployment_unavailable"));
  assert.equal(node.calls, 0, "no node read without an identity");
});

test("a node on another chain blocks serving and signing with deployment_mismatch", async () => {
  const environment = nonProduction(presaleIdentityFixture());
  const wrong = createPresaleDeploymentGate({
    environment,
    node: async () => fixtureChainNode(SUI_TESTNET_CHAIN_IDENTIFIER),
  });
  assert.equal(wrong.identity().network, "mainnet", "the parsed identity alone is not a signing authorization");
  await assert.rejects(wrong.authorize(), isCode("deployment_mismatch"));
  await assert.rejects(wrong.authorize(), isCode("deployment_mismatch"), "a mismatch is never cached as verified");

  const unreachable = createPresaleDeploymentGate({
    environment,
    node: async () => fixtureChainNode(SUI_MAINNET_CHAIN_IDENTIFIER, { fail: true }),
  });
  await assert.rejects(unreachable.authorize(), isCode("deployment_unavailable"));
  const unconfigured = createPresaleDeploymentGate({ environment, node: async () => null });
  await assert.rejects(unconfigured.authorize(), isCode("deployment_unavailable"));

  const node = fixtureChainNode(SUI_MAINNET_CHAIN_IDENTIFIER);
  const matching = createPresaleDeploymentGate({ environment, node: async () => node });
  assert.equal((await matching.authorize()).chainIdentifier, SUI_MAINNET_CHAIN_IDENTIFIER);
  await matching.authorize();
  assert.equal(node.calls, 1, "a node's genesis never changes: one read per node");
});

test("a node that never answers is deployment_unavailable within the node timeout, never cached (B-001)", async () => {
  const environment = nonProduction(presaleIdentityFixture());
  const node = fixtureChainNode(SUI_MAINNET_CHAIN_IDENTIFIER, { hang: true });
  const gate = createPresaleDeploymentGate({ environment, node: async () => node, nodeTimeoutMs: 50 });
  const started = performance.now();
  await assert.rejects(gate.authorize(), (error: unknown) =>
    isCode("deployment_unavailable")(error) && (error as PresaleRouteError).retryAfterSeconds === 5);
  assert.ok(performance.now() - started < 1_000, "bounded by the node timeout");
  await assert.rejects(gate.authorize(), isCode("deployment_unavailable"));
  assert.equal(node.calls, 2, "a timed-out read is never remembered");
});

test("the real gRPC node client is bounded too: a loopback node that accepts and never answers", async () => {
  const held: import("node:http").ServerResponse[] = [];
  const fixtureNode = await startFixtureHttpsNode((request, response) => {
    request.resume();
    held.push(response);
  });
  try {
    const environment = {
      ...nonProduction(presaleIdentityFixture()),
      PRESALE_SUI_GRPC_URL: fixtureNode.url,
    };
    const state = readPresaleDeploymentIdentity(environment);
    // A second, not 200 ms: on a loaded machine the process's first fetch (undici starting, the loopback TLS connect)
    // could outlast 200 ms, so the gate gave up before the read was sent. The ceiling keeps the old 1.8 s of slack
    // over the bound, still under the 3 s default, and the floor shows the bound, not a failed read, ended it.
    const nodeTimeoutMs = 1_000;
    const gate = createPresaleDeploymentGate({ state, node: async () => presaleNode(state, fixtureNode.url.replace(/\/$/, "")), nodeTimeoutMs });
    const started = performance.now();
    await assert.rejects(gate.authorize(), isCode("deployment_unavailable"));
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= nodeTimeoutMs - 5, `the bound ended the read (${Math.round(elapsed)} ms)`);
    assert.ok(elapsed < nodeTimeoutMs + 1_800, `and the stalled read did not hold the gate past it (${Math.round(elapsed)} ms)`);
    assert.ok(held.length >= 1, "the node received the read");
  } finally {
    for (const response of held) response.destroy();
    await fixtureNode.close();
  }
});

/** A gRPC-web answer to LedgerService.GetServiceInfo carrying `chainId` (field 1). */
function serviceInfoResponse(chainId: string): Buffer {
  const id = Buffer.from(chainId, "utf8");
  const message = Buffer.concat([Buffer.from([0x0a, id.length]), id]);
  const trailer = Buffer.from("grpc-status:0\r\ngrpc-message:\r\n", "utf8");
  const frame = (flag: number, body: Buffer) => {
    const header = Buffer.alloc(5);
    header[0] = flag;
    header.writeUInt32BE(body.length, 1);
    return Buffer.concat([header, body]);
  };
  return Buffer.concat([frame(0x00, message), frame(0x80, trailer)]);
}

test("after a stalled read the real client reads the node again and recovers on the next call (B-007)", async () => {
  let hits = 0;
  let stalledClosed = false;
  const fixtureNode = await startFixtureHttpsNode((request, response) => {
    hits += 1;
    request.resume();
    if (hits === 1) {
      // The first read stalls: accepted, never answered.
      response.on("close", () => {
        stalledClosed = true;
      });
      return;
    }
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/grpc-web+proto", "grpc-status": "0" });
      response.end(serviceInfoResponse(SUI_MAINNET_CHAIN_IDENTIFIER));
    });
  });
  try {
    const environment = {
      ...nonProduction(presaleIdentityFixture()),
      PRESALE_SUI_GRPC_URL: fixtureNode.url,
    };
    const state = readPresaleDeploymentIdentity(environment);
    // One client for the process, as `deployment/runtime.ts` builds it.
    const node = presaleNode(state, fixtureNode.url.replace(/\/$/, ""));
    const gate = createPresaleDeploymentGate({ state, node: async () => node, nodeTimeoutMs: 300 });
    await assert.rejects(gate.authorize(), isCode("deployment_unavailable"));
    assert.equal((await gate.authorize()).chainIdentifier, SUI_MAINNET_CHAIN_IDENTIFIER, "the healthy node is read again");
    assert.equal(hits, 2);
    await gate.authorize();
    assert.equal(hits, 2, "a verified node is remembered");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(stalledClosed, true, "the stalled request was aborted, not left open");
  } finally {
    await fixtureNode.close();
  }
});

function isCode(code: string) {
  return (error: unknown) => error instanceof PresaleRouteError && error.code === code;
}
