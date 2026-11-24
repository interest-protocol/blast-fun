import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { toBase58 } from "@mysten/sui/utils";

import type { RateBucket, RateLimitDecision, RateLimitPort, RateLimitSubject } from "@blast/core/lib/web-security/rate-limits.ts";
import { PRESALE_ERRORS, type PresaleErrorCode } from "@blast/core/modules/presale/contracts/errors.ts";
import { createPresaleValidator } from "@blast/core/modules/presale/contracts/validate.ts";
import { fixtureChainNode, SUI_MAINNET_CHAIN_IDENTIFIER, presaleIdentityFixture } from "../../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { createPresaleDeploymentGate, readPresaleDeploymentIdentity } from "@blast/core/modules/presale/deployment/service.ts";
import { createPresaleRouteKit } from "@blast/core/modules/presale/route-kit/route.ts";
import type { BridgeActivationChecklist, BridgeConfiguration } from "@blast/core/modules/presale/bridge/contracts.ts";
import { buildBridgeActivationRecord, createBridgeActivationGate } from "./activation.ts";
import { createPresaleBridgeRoutes } from "./routes.ts";
import { createCachedCircle, createCircleIris } from "@blast/core/modules/presale/bridge/circle.ts";
import { CIRCLE_FEES_STANDARD_ONLY, fixtureCircle, memoryBridgeActivations, memoryBridgeTransfers } from "../../../../../core/test/fixtures/modules/presale/bridge/fixtures.ts";
import { BRIDGE_OPEN_REGISTRATIONS_PER_ACCOUNT } from "@blast/core/modules/presale/bridge/contracts.ts";

/**
 * T-020: the CCTP bridge quote, transfer registry and activation gate
 * (REQ-016, REQ-017, REQ-019). Routes run as Request -> Response handlers
 * through the real presale route kit, the real Circle client and cache over a
 * fixture Iris API, and in-memory record stores; the Postgres stores are
 * covered by `bridge.integration.test.ts`.
 */

const ORIGIN = "https://blast.fun";
const validator = createPresaleValidator();
const hashId = (label: string) => `0x${createHash("sha256").update(label).digest("hex")}`;
const RELAYER = hashId("bridge-relayer");
const SUI_CCTP = {
  messageTransmitter: hashId("mt-package"),
  tokenMessengerMinter: hashId("tmm-package"),
  mtState: { objectId: hashId("mt-state"), initialSharedVersion: "9" },
  tmmState: { objectId: hashId("tmm-state"), initialSharedVersion: "9" },
  usdcTreasury: { objectId: hashId("usdc-treasury"), initialSharedVersion: "9" },
  usdcType: `${hashId("usdc")}::usdc::USDC`,
  denyList: { objectId: "0x403", initialSharedVersion: "1" },
};
const IDENTITY_ENV = { PRESALE_DEPLOYMENT_MANIFEST: JSON.stringify(presaleIdentityFixture({ cctp: SUI_CCTP })) };
const digest = (label: string) => toBase58(createHash("sha256").update(label).digest());
/** A 64-byte Solana signature in base58 (86 to 88 characters). */
const signature = (label: string) => digest(label) + digest(`${label}/2`);
const CIRCLE_HOOK = "0x636374702d666f72776172640000000000000000000000000000000000000000";

class MemoryLimiter implements RateLimitPort {
  readonly calls: { bucket: RateBucket; subject: RateLimitSubject }[] = [];
  async consume(bucket: RateBucket, subject: RateLimitSubject): Promise<RateLimitDecision> {
    this.calls.push({ bucket, subject });
    return { allowed: true, bucket, policyVersion: 1, retryAfterSeconds: 0 };
  }
}

/** A checklist that passes every item of the 5 October activation. */
function passingChecklist(overrides: Partial<BridgeActivationChecklist> = {}): BridgeActivationChecklist {
  return {
    forwarding: "blast",
    relayer_address: RELAYER,
    hook_data: null,
    circle: { domain8_v2: true, domain8_fast: true, checked_at: "2026-10-05T09:00:00.000Z" },
    fast_allowance: { allowance_usdc: "2500000.5", raise_atoms: "500000000000", wallet_cap_atoms: "5000000000" },
    test_transfers: [
      { source: "solana", amount_atoms: "5000000", source_tx_hash: signature("sol-1"), sui_digest: digest("sui-1"), burn_to_mint_seconds: 21 },
      { source: "solana", amount_atoms: "5000000", source_tx_hash: signature("sol-2"), sui_digest: digest("sui-2"), burn_to_mint_seconds: 19 },
      { source: "base", amount_atoms: "5000000", source_tx_hash: `0x${"ab".repeat(32)}`, sui_digest: digest("sui-3"), burn_to_mint_seconds: 33 },
    ],
    ...overrides,
  };
}

const DID = "did:privy:bridge-user";

function harness(options: Readonly<{
  configuration?: Partial<BridgeConfiguration>;
  env?: Record<string, string>;
  now?: () => number;
}> = {}) {
  const circle = fixtureCircle();
  const limiter = new MemoryLimiter();
  const activations = memoryBridgeActivations();
  const transfers = memoryBridgeTransfers();
  const identity = readPresaleDeploymentIdentity(options.env ?? IDENTITY_ENV);
  let configuration: BridgeConfiguration = { identity, forwarding: "blast", relayerAddress: RELAYER, ...options.configuration };
  let id = 0;
  const kit = createPresaleRouteKit({
    expectedOrigin: ORIGIN,
    verifyAccessToken: async (token) => {
      if (token !== "valid-token") throw new Error("invalid token");
      return { userId: DID } as Awaited<ReturnType<Parameters<typeof createPresaleRouteKit>[0]["verifyAccessToken"]>>;
    },
    limiter,
    deployment: createPresaleDeploymentGate({ environment: IDENTITY_ENV, node: async () => fixtureChainNode(SUI_MAINNET_CHAIN_IDENTIFIER) }),
    createRequestId: () => `req-${++id}`,
  });
  const routes = createPresaleBridgeRoutes({
    kit,
    circle: createCachedCircle(createCircleIris({ fetch: circle.fetch, timeoutMs: 50 }), { now: options.now }),
    activation: createBridgeActivationGate({ records: activations, configuration: () => configuration }),
    transfers,
  });
  const activate = async (checklist = passingChecklist()) =>
    activations.record(buildBridgeActivationRecord({ checklist, suiCctp: identity.status === "ready" ? identity.identity.cctp ?? null : null, recordedBy: "operator:ops" }));
  const quote = (query: string) => routes.quote(new Request(`${ORIGIN}/api/presale/bridge/quote?${query}`), testClient());
  const register = (body: unknown, headers: Record<string, string> = {}) => routes.register(new Request(`${ORIGIN}/api/presale/bridge/transfers`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }), testClient());
  const status = (id: string) => routes.status(new Request(`${ORIGIN}/api/presale/bridge/transfers/${id}`), testClient());
  const reconfigure = (change: Partial<BridgeConfiguration>) => {
    configuration = { ...configuration, ...change };
  };
  return { circle, limiter, activations, transfers, routes, activate, quote, register, status, reconfigure, identity };
}

async function okBody(response: Response, schema: "bridge-quote-response" | "bridge-transfer-created-response" | "bridge-transfer-status-response") {
  const body = await response.json();
  assert.deepEqual(validator.validate(schema, body).errors, [], JSON.stringify(body));
  assert.equal(response.headers.get("cache-control"), "no-store");
  return body as Record<string, unknown>;
}

async function assertError(response: Response, code: PresaleErrorCode) {
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(body.error.code, code, JSON.stringify(body));
  assert.equal(response.status, PRESALE_ERRORS[code].status);
  assert.deepEqual(validator.validate(`errors/${code}`, body).errors, []);
  const retryAfter = response.headers.get("retry-after");
  if (PRESALE_ERRORS[code].retryAfter) assert.match(retryAfter ?? "", /^[1-9][0-9]*$/, `${code} carries Retry-After`);
  else assert.equal(retryAfter, null);
  return { body: body.error, retryAfter: Number(retryAfter) };
}

test("T-020-AC-1: each source's fast and standard legs follow Circle's fees and the formulas, to domain 8", async () => {
  const { activate, quote, limiter } = harness();
  await activate();
  // 1,000 USDC. max_fee = ceil(amount x fee_bps x 1.25 / 10000); ETA = source finality + 10 s Sui mint.
  const expected = {
    ethereum: { fast: { eta_seconds: 30, fee_bps: "1", max_fee: "125000" }, standard: { eta_seconds: 1150, fee_bps: "0" } },
    arbitrum: { fast: { eta_seconds: 18, fee_bps: "1.3", max_fee: "162500" }, standard: { eta_seconds: 1150, fee_bps: "0" } },
    base: { fast: { eta_seconds: 18, fee_bps: "1.3", max_fee: "162500" }, standard: { eta_seconds: 1150, fee_bps: "0" } },
    solana: { fast: { eta_seconds: 18, fee_bps: "2", max_fee: "250000" }, standard: { eta_seconds: 35, fee_bps: "0.5" } },
  };
  for (const [source, legs] of Object.entries(expected)) {
    const response = await quote(`source=${source}&amount=1000000000`);
    assert.equal(response.status, 200, source);
    assert.deepEqual(await okBody(response, "bridge-quote-response"), {
      fast: { ...legs.fast, allowance_ok: true },
      standard: legs.standard,
      destination_domain: 8,
      forwarding: "blast",
      destination_caller: RELAYER,
      hook_data: null,
    }, source);
  }
  assert.ok(limiter.calls.every((call) => call.bucket === "presale_bridge_quote" && !call.subject.accountId));

  // One atom: the fee rounds up to one atom.
  const tiny = await okBody(await quote("source=base&amount=1"), "bridge-quote-response");
  assert.equal((tiny.fast as { max_fee: string }).max_fee, "1");
});

test("T-020-AC-1: a fee list without threshold 1000 has no Fast leg", async () => {
  const { activate, quote, circle } = harness();
  await activate();
  circle.state.fees.arbitrum = CIRCLE_FEES_STANDARD_ONLY;
  const body = await okBody(await quote("source=arbitrum&amount=5000000"), "bridge-quote-response");
  assert.equal(body.fast, null);
  assert.deepEqual(body.standard, { eta_seconds: 1150, fee_bps: "0" });
});

test("T-020-AC-2: allowance_ok is false above the global Fast allowance", async () => {
  const { activate, quote } = harness();
  await activate();
  // The recorded allowance is 2,500,000.5 USDC = 2,500,000,500,000 atoms.
  const fast = async (amount: string) =>
    ((await okBody(await quote(`source=solana&amount=${amount}`), "bridge-quote-response")).fast as { allowance_ok: boolean });
  assert.equal((await fast("2500000500000")).allowance_ok, true, "exactly the allowance");
  assert.equal((await fast("2500000500001")).allowance_ok, false, "one atom above");
});

test("T-020-AC-3: blast mode pins the relayer with no hook; circle mode is any caller with Circle's hook", async () => {
  const blast = harness();
  await blast.activate();
  const pinned = await okBody(await blast.quote("source=base&amount=5000000"), "bridge-quote-response");
  assert.deepEqual([pinned.forwarding, pinned.destination_caller, pinned.hook_data], ["blast", RELAYER, null]);

  const circle = harness({ configuration: { forwarding: "circle", relayerAddress: null } });
  await circle.activate(passingChecklist({ forwarding: "circle", relayer_address: null, hook_data: CIRCLE_HOOK }));
  const forwarded = await okBody(await circle.quote("source=base&amount=5000000"), "bridge-quote-response");
  assert.deepEqual([forwarded.forwarding, forwarded.destination_caller, forwarded.hook_data], ["circle", `0x${"0".repeat(64)}`, CIRCLE_HOOK]);
});

test("T-020-AC-4: the bridge is off until a complete checklist, and a mode or id change without a new record turns it off", async () => {
  const bridge = harness();
  // No record at all: every route that moves funds is off, with Retry-After.
  await assertError(await bridge.quote("source=base&amount=5000000"), "bridge_unavailable");
  assert.deepEqual(bridge.circle.state.requests, [], "an inactive bridge never calls Circle");

  // An incomplete checklist is recorded but activates nothing.
  const incomplete = await bridge.activate(passingChecklist({ test_transfers: passingChecklist().test_transfers.slice(0, 2) }));
  assert.deepEqual([incomplete.complete, incomplete.problems], [false, ["base_transfers_missing"]]);
  await assertError(await bridge.quote("source=base&amount=5000000"), "bridge_unavailable");
  const slow = await bridge.activate(passingChecklist({
    test_transfers: passingChecklist().test_transfers.map((transfer) => ({ ...transfer, burn_to_mint_seconds: 60 })),
  }));
  assert.deepEqual(slow.problems, ["solana_transfers_missing", "base_transfers_missing"], "60 s is not under 60 s");

  // A complete checklist activates it.
  assert.equal((await bridge.activate()).complete, true);
  assert.equal((await bridge.quote("source=base&amount=5000000")).status, 200);

  // Changing the forwarding mode or the relayer without a new record turns it off.
  bridge.reconfigure({ forwarding: "circle" });
  await assertError(await bridge.quote("source=base&amount=5000000"), "bridge_unavailable");
  bridge.reconfigure({ forwarding: "blast", relayerAddress: hashId("another-relayer") });
  await assertError(await bridge.quote("source=base&amount=5000000"), "bridge_unavailable");
  bridge.reconfigure({ relayerAddress: RELAYER });
  assert.equal((await bridge.quote("source=base&amount=5000000")).status, 200);

  // Changing the Sui CCTP ids in the identity without a new record turns it off.
  const moved = readPresaleDeploymentIdentity({
    PRESALE_DEPLOYMENT_MANIFEST: JSON.stringify(presaleIdentityFixture({ cctp: { ...SUI_CCTP, tokenMessengerMinter: hashId("tmm-package-v2") } })),
  });
  bridge.reconfigure({ identity: moved });
  await assertError(await bridge.quote("source=base&amount=5000000"), "bridge_unavailable");
  bridge.reconfigure({ identity: readPresaleDeploymentIdentity({}) });
  await assertError(await bridge.quote("source=base&amount=5000000"), "bridge_unavailable");
  bridge.reconfigure({ identity: bridge.identity });
  assert.equal((await bridge.quote("source=base&amount=5000000")).status, 200);

  // A new circle-mode record for a circle-mode configuration activates again.
  bridge.reconfigure({ forwarding: "circle" });
  await bridge.activate(passingChecklist({ forwarding: "circle", relayer_address: null, hook_data: CIRCLE_HOOK }));
  assert.equal((await bridge.quote("source=base&amount=5000000")).status, 200);
});

test("T-020-AC-6: Circle 429, timeouts and errors are bridge_unavailable, and a 429 stops all requests for 5 minutes", async () => {
  let clock = 1_000_000;
  const bridge = harness({ now: () => clock });
  await bridge.activate();

  bridge.circle.state.mode = "rate_limited";
  const limited = await assertError(await bridge.quote("source=base&amount=5000000"), "bridge_unavailable");
  assert.ok(limited.retryAfter > 290 && limited.retryAfter <= 300, String(limited.retryAfter));
  const sent = bridge.circle.state.requests.length;
  bridge.circle.state.mode = "ok";
  clock += 299_000;
  for (const source of ["base", "solana", "ethereum", "arbitrum"]) {
    await assertError(await bridge.quote(`source=${source}&amount=5000000`), "bridge_unavailable");
  }
  assert.equal(bridge.circle.state.requests.length, sent, "no request during Circle's block");
  clock += 1_000;
  assert.equal((await bridge.quote("source=base&amount=5000000")).status, 200);

  for (const mode of ["error", "hang"] as const) {
    clock += 60_000;
    bridge.circle.state.mode = mode;
    const failed = await assertError(await bridge.quote("source=solana&amount=5000000"), "bridge_unavailable");
    assert.ok(failed.retryAfter >= 1 && failed.retryAfter <= 5, `${mode}: ${failed.retryAfter}`);
    const before = bridge.circle.state.requests.length;
    await assertError(await bridge.quote("source=solana&amount=5000000"), "bridge_unavailable");
    assert.equal(bridge.circle.state.requests.length, before, `${mode}: a failure is not retried at once`);
  }
  clock += 60_000;
  bridge.circle.state.mode = "ok";
  bridge.circle.state.allowance = { allowance: "lots" };
  await assertError(await bridge.quote("source=ethereum&amount=5000000"), "bridge_unavailable");
});

test("T-020-AC-6: one instance sends at most one request per key per 30 s, however many callers", async () => {
  let clock = 5_000_000;
  const bridge = harness({ now: () => clock });
  await bridge.activate();
  bridge.circle.hold();
  const pending = Array.from({ length: 50 }, () => bridge.quote("source=base&amount=5000000"));
  await new Promise((resolve) => setImmediate(resolve));
  bridge.circle.release();
  const responses = await Promise.all(pending);
  assert.ok(responses.every((response) => response.status === 200));
  assert.deepEqual([...bridge.circle.state.requests].sort(), ["/v2/burn/USDC/fees/6/8", "/v2/fastBurn/USDC/allowance"]);

  clock += 29_000;
  assert.equal((await bridge.quote("source=base&amount=7000000")).status, 200);
  assert.equal(bridge.circle.state.requests.length, 2, "cached for 30 s");
  clock += 1_000;
  assert.equal((await bridge.quote("source=base&amount=7000000")).status, 200);
  assert.equal(bridge.circle.state.requests.length, 4, "refreshed after 30 s");
});

test("CL-21: a malformed quote parameter is invalid_parameter", async () => {
  const bridge = harness();
  await bridge.activate();
  for (const query of [
    "amount=5000000",
    "source=base",
    "source=polygon&amount=5000000",
    "source=base&amount=0",
    "source=base&amount=-1",
    "source=base&amount=1.5",
    "source=base&amount=05",
    "source=base&amount=18446744073709551616",
    "source=base&source=solana&amount=5000000",
  ]) {
    await assertError(await bridge.quote(query), "invalid_parameter");
  }
  assert.equal((await bridge.quote("source=base&amount=18446744073709551615")).status, 200, "u64 max");
});

const REGISTRATION = {
  source: "base",
  tx_hash: `0x${"AB".repeat(32)}`,
  sui_address: hashId("user-wallet"),
  amount: "5000000",
  presale_id: hashId("presale"),
};

test("T-020-AC-5: registration is idempotent on (source, tx_hash): 201 then 200 with the same id", async () => {
  const bridge = harness();
  await assertError(await bridge.register(REGISTRATION), "bridge_unavailable");
  await bridge.activate();

  const first = await bridge.register(REGISTRATION, { authorization: "Bearer valid-token" });
  assert.equal(first.status, 201);
  const { id } = await okBody(first, "bridge-transfer-created-response");
  const repeat = await bridge.register({ ...REGISTRATION, tx_hash: REGISTRATION.tx_hash.toLowerCase() });
  assert.equal(repeat.status, 200);
  assert.deepEqual(await okBody(repeat, "bridge-transfer-created-response"), { id });
  const stored = bridge.transfers.rows.get(id as string);
  assert.equal(stored?.txHash, `0x${"ab".repeat(32)}`, "EVM hashes are stored lowercase");
  assert.equal(stored?.privyDid, DID, "an optional Privy token links the account");
  assert.equal(stored?.status, "sent");
  assert.ok(bridge.limiter.calls.some((call) => call.bucket === "presale_bridge_register"));

  // The same hash from another source is another transfer; an invalid token is anonymous.
  const other = await bridge.register({ ...REGISTRATION, source: "arbitrum" }, { authorization: "Bearer expired" });
  assert.equal(other.status, 201);
  const otherId = (await other.json()).id as string;
  assert.notEqual(otherId, id);
  assert.equal(bridge.transfers.rows.get(otherId)?.privyDid, null);

  const solana = { ...REGISTRATION, source: "solana", tx_hash: digest("solana-burn") + digest("solana-burn-tail") };
  assert.equal((await bridge.register(solana)).status, 201);
});

test("review L6: a signed-in account holds at most five unattested registrations; a repeat and an anonymous caller are not capped here", async () => {
  const bridge = harness();
  await bridge.activate();
  const signedIn = { authorization: "Bearer valid-token" };
  const hash = (n: number) => `0x${n.toString(16).padStart(2, "0").repeat(32)}`;
  for (let n = 1; n <= BRIDGE_OPEN_REGISTRATIONS_PER_ACCOUNT; n += 1) {
    assert.equal((await bridge.register({ ...REGISTRATION, tx_hash: hash(n) }, signedIn)).status, 201, `registration ${n}`);
  }
  const sixth = await bridge.register({ ...REGISTRATION, tx_hash: hash(9) }, signedIn);
  await assertError(sixth.clone(), "rate_limited");
  assert.equal(sixth.headers.get("retry-after"), "300");
  assert.equal(bridge.transfers.rows.size, BRIDGE_OPEN_REGISTRATIONS_PER_ACCOUNT, "nothing more was registered");
  // A burn this account already registered still answers its id.
  assert.equal((await bridge.register({ ...REGISTRATION, tx_hash: hash(1) }, signedIn)).status, 200);
  // Anonymous registrations name no account; presale_bridge_register (per IP) bounds them.
  assert.equal((await bridge.register({ ...REGISTRATION, tx_hash: hash(9) })).status, 201);
  // Once Circle attests one, a new one fits again.
  const first = [...bridge.transfers.rows.values()].find((row) => row.txHash === hash(1))!;
  bridge.transfers.put({ ...first, status: "attested", attestedAt: new Date() });
  assert.equal((await bridge.register({ ...REGISTRATION, tx_hash: hash(10) }, signedIn)).status, 201);
});

test("registration refuses a malformed body with invalid_request", async () => {
  const bridge = harness();
  await bridge.activate();
  for (const body of [
    { ...REGISTRATION, extra: 1 },
    { ...REGISTRATION, source: "polygon" },
    { ...REGISTRATION, tx_hash: "0x1234" },
    { ...REGISTRATION, source: "solana" },
    { ...REGISTRATION, sui_address: `0x${"AB".repeat(32)}` },
    { ...REGISTRATION, presale_id: "presale" },
    { ...REGISTRATION, amount: "0" },
    { ...REGISTRATION, amount: 5000000 },
  ]) {
    await assertError(await bridge.register(body), "invalid_request");
  }
});

test("T-020-AC-5: a transfer's status is readable once the bridge was activated, and stays readable", async () => {
  const bridge = harness();
  await assertError(await bridge.status(`bt_${"0".repeat(32)}`), "bridge_unavailable");
  await bridge.activate();
  await assertError(await bridge.status(`bt_${"0".repeat(32)}`), "not_found");
  await assertError(await bridge.status("bt_nope"), "invalid_parameter");

  const { id } = (await (await bridge.register(REGISTRATION)).json()) as { id: string };
  const sent = await okBody(await bridge.status(id), "bridge-transfer-status-response");
  const sentMs = bridge.transfers.rows.get(id)!.sentAt.getTime();
  assert.deepEqual(sent, {
    status: "sent",
    timestamps: { sent_ms: sentMs, attested_ms: null, minted_ms: null, failed_ms: null },
    sui_digest: null,
    error: null,
  });
  const row = bridge.transfers.rows.get(id)!;
  bridge.transfers.put({
    ...row,
    status: "minted",
    attestedAt: new Date(sentMs + 18_000),
    mintedAt: new Date(sentMs + 26_000),
    suiDigest: digest("mint"),
  });

  // A later deactivation stops quotes and registrations, not status reads.
  bridge.reconfigure({ forwarding: "circle" });
  await assertError(await bridge.register({ ...REGISTRATION, tx_hash: `0x${"cd".repeat(32)}` }), "bridge_unavailable");
  assert.deepEqual(await okBody(await bridge.status(id), "bridge-transfer-status-response"), {
    status: "minted",
    timestamps: { sent_ms: sentMs, attested_ms: sentMs + 18_000, minted_ms: sentMs + 26_000, failed_ms: null },
    sui_digest: digest("mint"),
    error: null,
  });
});

test("Q-008: Circle's error bodies are cancelled, not left holding the connection", async () => {
  let clock = 9_000_000;
  const bridge = harness({ now: () => clock });
  await bridge.activate();
  bridge.circle.state.mode = "error";
  await assertError(await bridge.quote("source=base&amount=5000000"), "bridge_unavailable");
  assert.equal(bridge.circle.state.cancelledBodies, 2, "the fee list and the allowance");
  clock += 60_000;
  bridge.circle.state.mode = "rate_limited";
  await assertError(await bridge.quote("source=solana&amount=5000000"), "bridge_unavailable");
  assert.equal(bridge.circle.state.cancelledBodies, 4);
});

test("Q-006: once the bridge was ever activated, status reads stop asking the database", async () => {
  const activations = memoryBridgeActivations();
  let asked = 0;
  const gate = createBridgeActivationGate({
    records: { latest: activations.latest, anyComplete: async () => (asked += 1, activations.anyComplete()) },
    configuration: { identity: readPresaleDeploymentIdentity(IDENTITY_ENV), forwarding: "blast", relayerAddress: RELAYER },
  });
  assert.equal(await gate.everActivated(), false);
  assert.equal(await gate.everActivated(), false);
  assert.equal(asked, 2, "false is never remembered");
  await activations.record(buildBridgeActivationRecord({ checklist: passingChecklist(), suiCctp: SUI_CCTP as never, recordedBy: "operator:ops" }));
  assert.equal(await gate.everActivated(), true);
  assert.equal(await gate.everActivated(), true);
  assert.equal(asked, 3, "true is remembered: records are never deleted");
});
