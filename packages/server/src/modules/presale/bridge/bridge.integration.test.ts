import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { toBase58 } from "@mysten/sui/utils";

import type { RateBucket, RateLimitDecision, RateLimitPort } from "@blast/core/lib/web-security/rate-limits.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { createPresaleValidator } from "@blast/core/modules/presale/contracts/validate.ts";
import { fixtureChainNode, SUI_MAINNET_CHAIN_IDENTIFIER, presaleIdentityFixture } from "../../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { createPresaleDeploymentGate, readPresaleDeploymentIdentity } from "@blast/core/modules/presale/deployment/service.ts";
import { createPresaleRouteKit } from "@blast/core/modules/presale/route-kit/route.ts";
import type { BridgeActivationChecklist, BridgeTransferRegistration } from "@blast/core/modules/presale/bridge/contracts.ts";
import {
  buildBridgeActivationRecord,
  buildBridgeDeactivationRecord,
  createBridgeActivationGate,
} from "./activation.ts";
import { createPresaleBridgeRoutes } from "./routes.ts";
import { createCachedCircle, createCircleIris } from "@blast/core/modules/presale/bridge/circle.ts";
import { parseBridgeActivationCommand, runBridgeActivationCommand } from "./activation-command.ts";
import { fixtureCircle } from "../../../../../core/test/fixtures/modules/presale/bridge/fixtures.ts";
import { OperatorAuthenticator } from "@blast/server/modules/mission-control/operator/auth.ts";
import { PostgresBridgeActivations, PostgresBridgeTransfers } from "@blast/core/modules/presale/bridge/repository.ts";

/**
 * T-020 (AC-069, AC-070, AC-079, AC-080): the transfer registry, its
 * forward-only transitions, and the activation records in Postgres
 * (migration 0044), then the three routes over them with a fixture Iris API.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const hashId = (label: string) => `0x${createHash("sha256").update(label).digest("hex")}`;
const digest = (label: string) => toBase58(createHash("sha256").update(label).digest());
/** A 64-byte Solana signature in base58 (86 to 88 characters). */
const signature = (label: string) => digest(label) + digest(`${label}/2`);
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

const CHECKLIST: BridgeActivationChecklist = {
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
};

function registration(label: string, overrides: Partial<BridgeTransferRegistration> = {}): BridgeTransferRegistration {
  return {
    source: "base",
    txHash: `0x${createHash("sha256").update(label).digest("hex")}`,
    suiAddress: hashId("user-wallet"),
    amount: "5000000",
    presaleId: hashId("presale"),
    privyDid: null,
    ...overrides,
  };
}

async function freshPool() {
  assert.ok(databaseUrl);
  const pool = createPool(databaseUrl, { max: 8 });
  await migrateDatabase(pool);
  await pool.query("TRUNCATE presale_bridge_transfers, presale_bridge_activations RESTART IDENTITY");
  return pool;
}

test("T-020-AC-5: registration is idempotent on (source, tx_hash), also under concurrent repeats", { skip }, async () => {
  const pool = await freshPool();
  try {
    const transfers = new PostgresBridgeTransfers(pool);
    const input = registration("burn-1", { privyDid: "did:privy:bridge-user" });
    const first = await transfers.register(input);
    assert.equal(first.created, true);
    assert.match(first.id, /^bt_[0-9a-f]{32}$/);
    assert.deepEqual(await transfers.register({ ...input, privyDid: null, amount: "9" }), { id: first.id, created: false });

    const concurrent = await Promise.all(Array.from({ length: 8 }, () => transfers.register(registration("burn-2"))));
    assert.equal(new Set(concurrent.map((result) => result.id)).size, 1);
    assert.equal(concurrent.filter((result) => result.created).length, 1);
    assert.notEqual((await transfers.register(registration("burn-1", { source: "arbitrum" }))).id, first.id, "per source");

    const stored = await transfers.find(first.id);
    assert.ok(stored);
    assert.deepEqual(
      { ...stored, sentAt: undefined, nextPollAt: undefined },
      {
        id: first.id,
        source: "base",
        sourceDomain: 6,
        txHash: input.txHash,
        suiAddress: input.suiAddress,
        amount: "5000000",
        presaleId: input.presaleId,
        privyDid: "did:privy:bridge-user",
        status: "sent",
        sentAt: undefined,
        attestedAt: null,
        mintedAt: null,
        failedAt: null,
        error: null,
        nonce: null,
        message: null,
        attestation: null,
        suiDigest: null,
        nextPollAt: undefined,
        pollCount: 0,
        // 0051 (T-021): the relayer's queue evidence and observation window.
        circleNotFoundAt: null,
        observedFrom: null,
      },
    );
    assert.ok(stored.nextPollAt.getTime() <= Date.now() + 1_000, "due for its first poll at once");
    assert.equal(await transfers.find(`bt_${"0".repeat(32)}`), null);
    const solana = registration("burn-3", { source: "solana", txHash: digest("a") + digest("b") });
    assert.equal((await transfers.find((await transfers.register(solana)).id))?.sourceDomain, 5);
  } finally {
    await pool.end();
  }
});

test("T-020-AC-5: transitions only move forward and stamp each timestamp", { skip }, async () => {
  const pool = await freshPool();
  try {
    const transfers = new PostgresBridgeTransfers(pool);
    // Stamps an hour ahead of the database clock, so each is later than every
    // sent_at below and the clamp (greatest(previous stamps, at)) keeps it as
    // given. Fixed dates go stale: once the run is past them, sent_at wins.
    const base = (await transfers.now()).getTime() + 3_600_000;
    const at = (seconds: number) => new Date(base + seconds * 1_000);
    const message = `0x${"11".repeat(40)}`;
    const attestation = `0x${"22".repeat(65)}`;
    const nonce = `0x${"33".repeat(32)}`;
    const { id } = await transfers.register(registration("forward"));

    // sent -> minted skips attested: refused, nothing changes.
    const skipped = await transfers.markMinted(id, { suiDigest: digest("mint"), at: at(5) });
    assert.equal(skipped.applied, false);
    assert.equal(skipped.transfer?.status, "sent");

    const polled = await transfers.recordPoll(id, { nextPollAt: at(3), delayReason: "insufficient_fee" });
    assert.equal(polled.applied, true);
    assert.deepEqual([polled.transfer?.pollCount, polled.transfer?.nextPollAt.getTime(), polled.transfer?.error], [1, at(3).getTime(), "insufficient_fee"]);

    const attested = await transfers.markAttested(id, { message, attestation, nonce, at: at(10) });
    assert.equal(attested.applied, true);
    assert.deepEqual(
      [attested.transfer?.status, attested.transfer?.attestedAt?.getTime(), attested.transfer?.message, attested.transfer?.attestation, attested.transfer?.nonce, attested.transfer?.error],
      ["attested", at(10).getTime(), message, attestation, nonce, null],
    );
    assert.equal((await transfers.markAttested(id, { message, attestation, at: at(11) })).applied, false, "attested twice");

    const minted = await transfers.markMinted(id, { suiDigest: digest("mint"), at: at(18) });
    assert.equal(minted.applied, true);
    assert.deepEqual([minted.transfer?.status, minted.transfer?.mintedAt?.getTime(), minted.transfer?.suiDigest], ["minted", at(18).getTime(), digest("mint")]);
    assert.equal(minted.transfer?.attestedAt?.getTime(), at(10).getTime(), "earlier stamps stay");

    // Minted is terminal: no failure, no attestation, no poll.
    assert.equal((await transfers.markFailed(id, { error: "invalid_burn", at: at(20) })).applied, false);
    assert.equal((await transfers.markAttested(id, { message, attestation, at: at(20) })).applied, false);
    assert.equal((await transfers.recordPoll(id, { nextPollAt: at(30) })).applied, false);
    assert.equal((await transfers.find(id))?.status, "minted");

    // failed from sent and from attested.
    const invalid = (await transfers.register(registration("invalid"))).id;
    const failed = await transfers.markFailed(invalid, { error: "invalid_burn", at: at(40) });
    assert.deepEqual([failed.applied, failed.transfer?.status, failed.transfer?.failedAt?.getTime(), failed.transfer?.error], [true, "failed", at(40).getTime(), "invalid_burn"]);
    assert.equal((await transfers.markAttested(invalid, { message, attestation, at: at(41) })).applied, false, "an invalid burn never revives");
    const afterAttest = (await transfers.register(registration("after-attest"))).id;
    await transfers.markAttested(afterAttest, { message, attestation, at: at(42) });
    assert.equal((await transfers.markFailed(afterAttest, { error: "mint_failed", at: at(43) })).transfer?.status, "failed");
    assert.equal((await transfers.markAttested(afterAttest, { message, attestation, at: at(44) })).applied, false, "attested once already");

    // A late attestation revives an attestation timeout, clearing the failure.
    const late = (await transfers.register(registration("late"))).id;
    await transfers.markFailed(late, { error: "attestation_timeout", at: at(50) });
    const revived = await transfers.markAttested(late, { message, attestation, at: at(55) });
    assert.deepEqual(
      [revived.applied, revived.transfer?.status, revived.transfer?.attestedAt?.getTime(), revived.transfer?.failedAt, revived.transfer?.error],
      [true, "attested", at(55).getTime(), null, null],
    );

    // Without `at`, the database clock stamps the move.
    const clock = (await transfers.register(registration("clock"))).id;
    const before = Date.now();
    const stamped = await transfers.markAttested(clock, { message, attestation });
    assert.ok(Math.abs((stamped.transfer?.attestedAt?.getTime() ?? 0) - before) < 60_000);

    const unknown = await transfers.markAttested(`bt_${"0".repeat(32)}`, { message, attestation });
    assert.deepEqual(unknown, { applied: false, transfer: null });
  } finally {
    await pool.end();
  }
});

test("T-020-AC-4: activation records keep history and only a complete one for this configuration activates", { skip }, async () => {
  const pool = await freshPool();
  try {
    const records = new PostgresBridgeActivations(pool);
    const identity = readPresaleDeploymentIdentity(IDENTITY_ENV);
    assert.ok(identity.status === "ready" && identity.identity.cctp);
    let configuration = { identity, forwarding: "blast" as const, relayerAddress: RELAYER };
    const gate = createBridgeActivationGate({ records, configuration: () => configuration });

    assert.deepEqual(await gate.current(), { active: false, reason: "no_record", recordId: null });
    assert.equal(await gate.everActivated(), false);

    const partial = await records.record(buildBridgeActivationRecord({
      checklist: { ...CHECKLIST, circle: { ...CHECKLIST.circle, domain8_fast: false } },
      suiCctp: identity.identity.cctp,
      recordedBy: "operator:ops",
    }));
    assert.deepEqual([partial.complete, partial.problems], [false, ["domain8_fast_unconfirmed"]]);
    assert.equal((await gate.current()).active, false);

    const complete = await records.record(buildBridgeActivationRecord({ checklist: CHECKLIST, suiCctp: identity.identity.cctp, recordedBy: "operator:ops" }));
    assert.deepEqual(await gate.current(), {
      active: true,
      recordId: complete.id,
      forwarding: "blast",
      destinationCaller: RELAYER,
      hookData: null,
    });
    assert.deepEqual(complete.suiCctp, identity.identity.cctp, "the ids round-trip");
    assert.deepEqual((await records.latest())?.checklist, CHECKLIST);

    configuration = { ...configuration, forwarding: "circle" as never };
    assert.deepEqual(await gate.current(), { active: false, reason: "forwarding_changed", recordId: complete.id });
    configuration = { ...configuration, forwarding: "blast" };

    await records.record(buildBridgeDeactivationRecord({ reason: "incident 42", recordedBy: "operator:ops" }));
    assert.deepEqual((await gate.current()).active, false);
    assert.equal(await gate.everActivated(), true);

    const history = await records.history(10);
    assert.deepEqual(history.map((record) => record.kind), ["deactivation", "checklist", "checklist"]);
    assert.deepEqual(history.map((record) => record.complete), [false, true, false]);
    assert.ok(history.every((record) => record.recordedBy === "operator:ops" && record.recordedAt instanceof Date));
  } finally {
    await pool.end();
  }
});

test("B-001: from the 10th record on, the newest record still governs: a deactivation as record 12 closes the bridge", { skip }, async () => {
  const pool = await freshPool();
  try {
    const records = new PostgresBridgeActivations(pool);
    const identity = readPresaleDeploymentIdentity(IDENTITY_ENV);
    assert.ok(identity.status === "ready" && identity.identity.cctp);
    const gate = createBridgeActivationGate({ records, configuration: { identity, forwarding: "blast", relayerAddress: RELAYER } });
    const incomplete = { ...CHECKLIST, circle: { ...CHECKLIST.circle, domain8_v2: false } };
    for (let index = 1; index <= 8; index += 1) {
      await records.record(buildBridgeActivationRecord({ checklist: incomplete, suiCctp: identity.identity.cctp, recordedBy: "operator:ops" }));
    }
    await records.record(buildBridgeActivationRecord({ checklist: CHECKLIST, suiCctp: identity.identity.cctp, recordedBy: "operator:ops" }));
    await records.record(buildBridgeDeactivationRecord({ reason: "first stop", recordedBy: "operator:ops" }));
    const reopened = await records.record(buildBridgeActivationRecord({ checklist: CHECKLIST, suiCctp: identity.identity.cctp, recordedBy: "operator:ops" }));
    assert.equal(reopened.id, "11");
    assert.equal((await gate.current()).active, true, "record 11 reopens it");
    const stop = await records.record(buildBridgeDeactivationRecord({ reason: "incident 42", recordedBy: "operator:ops" }));
    assert.equal(stop.id, "12");

    assert.equal((await records.latest())?.id, "12");
    assert.deepEqual((await records.history(4)).map((record) => record.id), ["12", "11", "10", "9"]);
    assert.deepEqual(await gate.current(), { active: false, reason: "deactivated", recordId: "12" });
  } finally {
    await pool.end();
  }
});

test("Q-004: a timed-out transfer stays on the poll schedule until a late attestation; other failures do not", { skip }, async () => {
  const pool = await freshPool();
  try {
    const transfers = new PostgresBridgeTransfers(pool);
    const later = new Date(Date.now() + 60_000);
    const timedOut = (await transfers.register(registration("timed-out"))).id;
    await transfers.markFailed(timedOut, { error: "attestation_timeout" });
    const polled = await transfers.recordPoll(timedOut, { nextPollAt: later });
    assert.deepEqual([polled.applied, polled.transfer?.pollCount, polled.transfer?.status, polled.transfer?.error], [true, 1, "failed", "attestation_timeout"]);
    // A poll of a timed-out transfer keeps its failure text: the delay reason does not replace it.
    const withReason = await transfers.recordPoll(timedOut, { nextPollAt: later, delayReason: "insufficient_fee" });
    assert.deepEqual([withReason.applied, withReason.transfer?.error], [true, "attestation_timeout"]);

    const invalid = (await transfers.register(registration("invalid-burn"))).id;
    await transfers.markFailed(invalid, { error: "invalid_burn" });
    assert.equal((await transfers.recordPoll(invalid, { nextPollAt: later })).applied, false);

    const index = await pool.query<{ definition: string }>(
      "SELECT pg_get_indexdef('presale_bridge_transfers_due'::regclass) AS definition",
    );
    assert.match(index.rows[0]!.definition, /attestation_timeout/, "the due index covers timed-out transfers");
  } finally {
    await pool.end();
  }
});

test("Q-007/B-006, Q-011: a stamp before the previous one is clamped to it, never stored backwards", { skip }, async () => {
  const pool = await freshPool();
  try {
    const transfers = new PostgresBridgeTransfers(pool);
    const violation = (error: unknown) => (error as { code?: string }).code === "23514";
    const past = new Date("2000-01-01T00:00:00Z");
    const order = async (id: string) => (await pool.query<{ attested: string; minted: string; failed: string }>(
      `SELECT (attested_at = sent_at)::text AS attested, (minted_at = attested_at)::text AS minted,
              (failed_at = greatest(sent_at, attested_at))::text AS failed
       FROM presale_bridge_transfers WHERE id = $1`,
      [id],
    )).rows[0]!;

    const failing = (await transfers.register(registration("backdated-fail"))).id;
    assert.equal((await transfers.markFailed(failing, { error: "invalid_burn", at: past })).applied, true);
    assert.equal((await order(failing)).failed, "true", "failed_at is clamped to sent_at");

    const id = (await transfers.register(registration("backdated"))).id;
    assert.equal((await transfers.markAttested(id, { message: "0x01", attestation: "0x02", at: past })).applied, true);
    assert.equal((await order(id)).attested, "true", "attested_at is clamped to sent_at");
    assert.equal((await transfers.markMinted(id, { suiDigest: digest("m"), at: past })).applied, true);
    assert.equal((await order(id)).minted, "true", "minted_at is clamped to attested_at");

    const attestedThenFailed = (await transfers.register(registration("attested-then-failed"))).id;
    const sent = (await transfers.find(attestedThenFailed))!;
    await transfers.markAttested(attestedThenFailed, { message: "0x01", attestation: "0x02", at: new Date(sent.sentAt.getTime() + 20_000) });
    assert.equal((await transfers.markFailed(attestedThenFailed, { error: "mint_failed", at: past })).applied, true);
    assert.equal((await order(attestedThenFailed)).failed, "true", "failed_at is clamped to attested_at");

    // The relayer worker's own role is held to the order by the table, not only by the repository.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE blast_watcher");
      await assert.rejects(
        client.query("UPDATE presale_bridge_transfers SET minted_at = attested_at - interval '1 second' WHERE id = $1", [id]),
        violation,
        "the CHECKs stay the backstop: a raw update as blast_watcher is refused",
      );
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  } finally {
    await pool.end();
  }
});

function skewTest(name: string, body: (transfers: PostgresBridgeTransfers) => Promise<void>) {
  test(`B-007: ${name}`, { skip }, async () => {
    const pool = await freshPool();
    try {
      await body(new PostgresBridgeTransfers(pool));
    } finally {
      await pool.end();
    }
  });
}

const attest = (transfers: PostgresBridgeTransfers, id: string, at?: Date) =>
  transfers.markAttested(id, { message: "0x01", attestation: "0x02", at });

skewTest("at = the repository's own sentAt (milliseconds, from a microsecond stamp) attests", async (transfers) => {
  const id = (await transfers.register(registration("skew-echo"))).id;
  const sentAt = (await transfers.find(id))!.sentAt;
  assert.equal((await attest(transfers, id, sentAt)).applied, true);
});

skewTest("a worker clock 2 s behind the database attests and mints", async (transfers) => {
  const id = (await transfers.register(registration("skew-behind"))).id;
  assert.equal((await attest(transfers, id, new Date(Date.now() - 2_000))).applied, true);
  assert.equal((await transfers.markMinted(id, { suiDigest: digest("behind"), at: new Date(Date.now() - 2_000) })).applied, true);
});

skewTest("a worker clock 30 s ahead, then a default-time mint or failure", async (transfers) => {
  const id = (await transfers.register(registration("skew-ahead"))).id;
  const attestedAt = new Date(Date.now() + 30_000);
  assert.equal((await attest(transfers, id, attestedAt)).applied, true);
  const minted = await transfers.markMinted(id, { suiDigest: digest("ahead") });
  assert.equal(minted.applied, true);
  assert.ok((minted.transfer?.mintedAt?.getTime() ?? 0) >= attestedAt.getTime());
  const failing = (await transfers.register(registration("skew-ahead-fail"))).id;
  await attest(transfers, failing, new Date(Date.now() + 30_000));
  assert.equal((await transfers.markFailed(failing, { error: "mint_failed" })).applied, true);
});

test("Q-001/B-004: an operator registers a checklist burn while the bridge is off, in the public table", { skip }, async () => {
  const pool = await freshPool();
  try {
    const token = "operator-token-for-the-bridge-command-0001";
    const operator = new OperatorAuthenticator({ operatorId: "ops-1", tokenHash: createHash("sha256").update(token).digest("hex") })
      .authenticate("ops-1", token);
    const records = new PostgresBridgeActivations(pool);
    const transfers = new PostgresBridgeTransfers(pool);
    const identity = readPresaleDeploymentIdentity(IDENTITY_ENV);
    const ports = {
      readChecklist: async () => CHECKLIST,
      records,
      transfers,
      configuration: () => ({ identity, forwarding: "blast" as const, relayerAddress: RELAYER }),
    };
    const burn = ["solana", digest("op-burn") + digest("op-burn/2"), hashId("ops-wallet"), "5000000", hashId("presale")];
    const result = await runBridgeActivationCommand(parseBridgeActivationCommand(["register-test", ...burn]), operator, ports);
    assert.equal((result.activation as { active: boolean }).active, false, "registered while the bridge is off");
    const { id } = result.transfer as { id: string };
    assert.equal((await transfers.find(id))?.status, "sent");

    // Once activated, the public route sees the same transfer: one table, one rule.
    const kit = createPresaleRouteKit({
      expectedOrigin: "https://blast.fun",
      verifyAccessToken: async () => {
        throw new Error("anonymous");
      },
      limiter: new AllowAll(),
      deployment: createPresaleDeploymentGate({ environment: IDENTITY_ENV, node: async () => fixtureChainNode(SUI_MAINNET_CHAIN_IDENTIFIER) }),
    });
    const routes = createPresaleBridgeRoutes({
      kit,
      circle: createCachedCircle(createCircleIris({ fetch: fixtureCircle().fetch })),
      activation: createBridgeActivationGate({ records, configuration: ports.configuration }),
      transfers,
    });
    await runBridgeActivationCommand({ mode: "record", checklistPath: "checklist.json" }, operator, ports);
    const repeat = await routes.register(new Request("https://blast.fun/api/presale/bridge/transfers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: burn[0], tx_hash: burn[1], sui_address: burn[2], amount: burn[3], presale_id: burn[4] }),
    }), testClient());
    assert.equal(repeat.status, 200);
    assert.deepEqual(await repeat.json(), { id });
  } finally {
    await pool.end();
  }
});

class AllowAll implements RateLimitPort {
  async consume(bucket: RateBucket): Promise<RateLimitDecision> {
    return { allowed: true, bucket, policyVersion: 1, retryAfterSeconds: 0 };
  }
}

test("working path: quote while inactive and active, register twice, and read transitions through the routes", { skip }, async () => {
  const pool = await freshPool();
  try {
    const validator = createPresaleValidator();
    const circle = fixtureCircle();
    const records = new PostgresBridgeActivations(pool);
    const transfers = new PostgresBridgeTransfers(pool);
    const identity = readPresaleDeploymentIdentity(IDENTITY_ENV);
    const kit = createPresaleRouteKit({
      expectedOrigin: "https://blast.fun",
      verifyAccessToken: async () => {
        throw new Error("anonymous");
      },
      limiter: new AllowAll(),
      deployment: createPresaleDeploymentGate({ environment: IDENTITY_ENV, node: async () => fixtureChainNode(SUI_MAINNET_CHAIN_IDENTIFIER) }),
    });
    const routes = createPresaleBridgeRoutes({
      kit,
      circle: createCachedCircle(createCircleIris({ fetch: circle.fetch })),
      activation: createBridgeActivationGate({ records, configuration: { identity, forwarding: "blast", relayerAddress: RELAYER } }),
      transfers,
    });
    const quote = () => routes.quote(new Request("https://blast.fun/api/presale/bridge/quote?source=solana&amount=5000000"), testClient());
    const register = () => routes.register(new Request("https://blast.fun/api/presale/bridge/transfers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "solana", tx_hash: digest("x") + digest("y"), sui_address: hashId("w"), amount: "5000000", presale_id: hashId("p") }),
    }), testClient());

    const inactive = await quote();
    assert.equal(inactive.status, 503);
    assert.ok(Number(inactive.headers.get("retry-after")) >= 1);
    assert.deepEqual(validator.validate("errors/bridge_unavailable", await inactive.json()).errors, []);
    assert.equal((await register()).status, 503);

    assert.ok(identity.status === "ready");
    await records.record(buildBridgeActivationRecord({ checklist: CHECKLIST, suiCctp: identity.identity.cctp ?? null, recordedBy: "operator:ops" }));
    const active = await quote();
    assert.equal(active.status, 200);
    assert.deepEqual(validator.validate("bridge-quote-response", await active.json()).errors, []);

    const first = await register();
    const repeat = await register();
    assert.deepEqual([first.status, repeat.status], [201, 200]);
    const { id } = (await first.json()) as { id: string };
    assert.deepEqual(await repeat.json(), { id });

    const read = async () => {
      const response = await routes.status(new Request(`https://blast.fun/api/presale/bridge/transfers/${id}`), testClient());
      const body = await response.json();
      assert.deepEqual(validator.validate("bridge-transfer-status-response", body).errors, []);
      return body as { status: string; timestamps: Record<string, number | null>; sui_digest: string | null };
    };
    assert.equal((await read()).status, "sent");
    await transfers.markAttested(id, { message: "0x01", attestation: "0x02" });
    await transfers.markMinted(id, { suiDigest: digest("minted") });
    const minted = await read();
    assert.equal(minted.status, "minted");
    assert.equal(minted.sui_digest, digest("minted"));
    assert.ok((minted.timestamps.sent_ms ?? 0) <= (minted.timestamps.attested_ms ?? 0));
    assert.ok((minted.timestamps.attested_ms ?? 0) <= (minted.timestamps.minted_ms ?? 0));
  } finally {
    await pool.end();
  }
});
