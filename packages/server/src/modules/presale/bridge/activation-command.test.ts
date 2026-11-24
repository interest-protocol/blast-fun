import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { toBase58 } from "@mysten/sui/utils";

import { OperatorAuthenticator } from "@blast/server/modules/mission-control/operator/auth.ts";
import { OperatorError } from "@blast/server/modules/mission-control/operator/errors.ts";
import { presaleIdentityFixture } from "../../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { readPresaleDeploymentIdentity } from "@blast/core/modules/presale/deployment/service.ts";
import { parseBridgeActivationCommand, runBridgeActivationCommand } from "./activation-command.ts";
import { bridgeConfigurationFromEnvironment, buildBridgeActivationRecord, createBridgeActivationGate, parseBridgeActivationChecklist } from "./activation.ts";
import { memoryBridgeActivations, memoryBridgeTransfers } from "../../../../../core/test/fixtures/modules/presale/bridge/fixtures.ts";

/**
 * T-020 (AC-079, AC-080, AC-108 support): the operator command that records
 * the 5 October activation checklist (`npm run presale:bridge-activation`).
 */

const hashId = (label: string) => `0x${createHash("sha256").update(label).digest("hex")}`;
const digest = (label: string) => toBase58(createHash("sha256").update(label).digest());
/** A 64-byte Solana signature in base58 (86 to 88 characters). */
const signature = (label: string) => digest(label) + digest(`${label}/2`);
const RELAYER = hashId("bridge-relayer");
const TOKEN = "operator-token-for-the-bridge-command-0001";
const operator = new OperatorAuthenticator({
  operatorId: "ops-1",
  tokenHash: createHash("sha256").update(TOKEN).digest("hex"),
}).authenticate("ops-1", TOKEN);
const SUI_CCTP = {
  messageTransmitter: hashId("mt-package"),
  tokenMessengerMinter: hashId("tmm-package"),
  mtState: { objectId: hashId("mt-state"), initialSharedVersion: "9" },
  tmmState: { objectId: hashId("tmm-state"), initialSharedVersion: "9" },
  usdcTreasury: { objectId: hashId("usdc-treasury"), initialSharedVersion: "9" },
  usdcType: `${hashId("usdc")}::usdc::USDC`,
  denyList: { objectId: "0x403", initialSharedVersion: "1" },
};
const ENV = {
  PRESALE_DEPLOYMENT_MANIFEST: JSON.stringify(presaleIdentityFixture({ cctp: SUI_CCTP })),
  PRESALE_BRIDGE_FORWARDING: "blast",
  PRESALE_BRIDGE_RELAYER_ADDRESS: RELAYER.toUpperCase().replace("0X", "0x"),
};
const IDENTITY = readPresaleDeploymentIdentity(ENV);
assert.ok(IDENTITY.status === "ready" && IDENTITY.identity.cctp);
const IDS = IDENTITY.identity.cctp;
const CHECKLIST = {
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
  note: "5 October activation run",
};

function ports(files: Record<string, unknown>, env: Record<string, string> = ENV) {
  const records = memoryBridgeActivations();
  return {
    records,
    transfers: memoryBridgeTransfers(),
    readChecklist: async (path: string) => {
      if (!(path in files)) throw new OperatorError("OPERATOR_INPUT_INVALID");
      return files[path];
    },
    configuration: () => bridgeConfigurationFromEnvironment(env, readPresaleDeploymentIdentity(env)),
  };
}

function refused(code: string) {
  return (error: unknown) => error instanceof OperatorError && error.code === code;
}

test("the command parses record, deactivate, status and history exactly", () => {
  assert.deepEqual(parseBridgeActivationCommand(["record", "checklist.json"]), { mode: "record", checklistPath: "checklist.json" });
  assert.deepEqual(parseBridgeActivationCommand(["deactivate", "incident 42"]), { mode: "deactivate", reason: "incident 42" });
  assert.deepEqual(parseBridgeActivationCommand(["status"]), { mode: "status" });
  assert.deepEqual(parseBridgeActivationCommand(["history"]), { mode: "history", limit: 20 });
  assert.deepEqual(parseBridgeActivationCommand(["history", "5"]), { mode: "history", limit: 5 });
  for (const args of [[], ["record"], ["record", "a", "b"], ["deactivate"], ["status", "x"], ["history", "0"], ["history", "x"], ["activate"]]) {
    assert.throws(() => parseBridgeActivationCommand(args), refused("OPERATOR_INPUT_INVALID"), args.join(" "));
  }
});

test("T-020-AC-4: recording a complete checklist activates the bridge for the configured mode and ids", async () => {
  const command = ports({ "checklist.json": CHECKLIST });
  assert.deepEqual(
    await runBridgeActivationCommand({ mode: "status" }, operator, command),
    { activation: { active: false, reason: "no_record", recordId: null }, withdraw: { active: false, reason: "no_record", live: [] }, latest: null },
  );
  const result = await runBridgeActivationCommand({ mode: "record", checklistPath: "checklist.json" }, operator, command);
  assert.deepEqual(result.activation, { active: true, recordId: "1", forwarding: "blast", destinationCaller: RELAYER, hookData: null });
  assert.deepEqual({ ...(result.record as Record<string, unknown>), recorded_at: undefined }, {
    id: "1",
    recorded_at: undefined,
    recorded_by: "operator:ops-1",
    kind: "checklist",
    forwarding: "blast",
    complete: true,
    problems: [],
  });
  assert.deepEqual(command.records.rows[0]?.suiCctp, IDS, "the ids come from the deployment identity");
});

test("merge train 8: once the identity names CCTP V2's handler pair, a record made before it is off for deposits and the command alike, until re-recorded", async () => {
  // `suiCctpKey` includes the handler ids (withdraw to another chain), so the
  // deposit route's gate and the command read the same `sui_cctp_changed`.
  const v2Env = {
    ...ENV,
    PRESALE_DEPLOYMENT_MANIFEST: JSON.stringify(
      presaleIdentityFixture({ cctp: { ...SUI_CCTP, stablecoinHandler: hashId("handler-package"), handlerState: { objectId: hashId("handler-state"), initialSharedVersion: "9" } } }),
    ),
  };
  const before = ports({ "checklist.json": CHECKLIST });
  const recorded = await runBridgeActivationCommand({ mode: "record", checklistPath: "checklist.json" }, operator, before);
  assert.equal((recorded.activation as { active: boolean }).active, true);
  const after = { ...ports({ "checklist.json": CHECKLIST }, v2Env), records: before.records };
  const deposits = createBridgeActivationGate({ records: before.records, configuration: after.configuration });
  assert.deepEqual(await deposits.current(), { active: false, reason: "sui_cctp_changed", recordId: "1" });
  const status = await runBridgeActivationCommand({ mode: "status" }, operator, after);
  assert.deepEqual(status.activation, await deposits.current(), "the command says what the deposit route reads");
  assert.deepEqual(status.withdraw, { active: false, reason: "sui_cctp_changed", live: [] });
  const rerecorded = await runBridgeActivationCommand({ mode: "record", checklistPath: "checklist.json" }, operator, after);
  assert.deepEqual(rerecorded.activation, await deposits.current());
  assert.equal((await deposits.current()).active, true);
  assert.deepEqual(rerecorded.withdraw, { active: false, reason: "no_withdraw_tests", live: [] }, "a checklist without a withdraw part keeps withdrawals off");
});

test("an incomplete checklist is recorded and keeps the bridge off; a malformed one is refused and not recorded", async () => {
  const failing = { ...CHECKLIST, circle: { ...CHECKLIST.circle, domain8_v2: false }, test_transfers: CHECKLIST.test_transfers.slice(1) };
  const command = ports({ "failing.json": failing, "malformed.json": { ...CHECKLIST, extra: true }, "typo.json": { ...CHECKLIST, forwarding: "relay" } });
  const result = await runBridgeActivationCommand({ mode: "record", checklistPath: "failing.json" }, operator, command);
  assert.deepEqual((result.record as { problems: string[] }).problems, ["domain8_v2_unconfirmed", "solana_transfers_missing"]);
  assert.deepEqual(result.activation, { active: false, reason: "incomplete", recordId: "1" });

  for (const path of ["malformed.json", "typo.json", "missing.json"]) {
    await assert.rejects(runBridgeActivationCommand({ mode: "record", checklistPath: path }, operator, command), refused("OPERATOR_INPUT_INVALID"));
  }
  assert.equal(command.records.rows.length, 1);

  // Without Sui CCTP ids in the identity the checklist cannot pass.
  const noIds = ports({ "checklist.json": CHECKLIST }, { ...ENV, PRESALE_DEPLOYMENT_MANIFEST: JSON.stringify(presaleIdentityFixture()) });
  const unbound = await runBridgeActivationCommand({ mode: "record", checklistPath: "checklist.json" }, operator, noIds);
  assert.deepEqual((unbound.record as { problems: string[] }).problems, ["sui_cctp_missing"]);
});

test("T-020-AC-4: deactivate turns the bridge off and history keeps every record, newest first", async () => {
  const command = ports({ "checklist.json": CHECKLIST });
  await runBridgeActivationCommand({ mode: "record", checklistPath: "checklist.json" }, operator, command);
  const off = await runBridgeActivationCommand({ mode: "deactivate", reason: "incident 42" }, operator, command);
  assert.deepEqual(off.activation, { active: false, reason: "deactivated", recordId: "2" });
  assert.deepEqual((off.record as { problems: string[] }).problems, ["deactivated"]);

  const history = await runBridgeActivationCommand({ mode: "history", limit: 20 }, operator, command);
  assert.deepEqual((history.records as { id: string; kind: string }[]).map((record) => [record.id, record.kind]), [
    ["2", "deactivation"],
    ["1", "checklist"],
  ]);

  // A mode change in the environment without a new record: off, and status says why.
  const circleEnv = ports({}, { ...ENV, PRESALE_BRIDGE_FORWARDING: "circle" });
  await circleEnv.records.record(buildBridgeActivationRecord({
    checklist: parseBridgeActivationChecklist(CHECKLIST),
    suiCctp: IDS,
    recordedBy: "operator:ops-1",
  }));
  const status = await runBridgeActivationCommand({ mode: "status" }, operator, circleEnv);
  assert.deepEqual(status.activation, { active: false, reason: "forwarding_changed", recordId: "1" });
});

test("B-001: record and deactivate report what the gate reads after the write, not the row written", async () => {
  const command = ports({ "checklist.json": CHECKLIST });
  await runBridgeActivationCommand({ mode: "record", checklistPath: "checklist.json" }, operator, command);
  // A store whose newest row is not the one just written (another operator, or a misordered read).
  const governing = command.records.rows[0]!;
  const skewed = { ...command, records: { ...command.records, latest: async () => governing } };
  const off = await runBridgeActivationCommand({ mode: "deactivate", reason: "incident 42" }, operator, skewed);
  assert.equal((off.record as { id: string }).id, "2");
  assert.deepEqual(off.activation, { active: true, recordId: "1", forwarding: "blast", destinationCaller: RELAYER, hookData: null });
});

const SOL_1 = CHECKLIST.test_transfers[0]!;
const BASE_1 = CHECKLIST.test_transfers[2]!;

async function recordChecklist(checklist: unknown) {
  const command = ports({ "checklist.json": checklist });
  return runBridgeActivationCommand({ mode: "record", checklistPath: "checklist.json" }, operator, command);
}

test("Q-002/B-002: one transfer listed twice does not count as two", async () => {
  const twice = await recordChecklist({ ...CHECKLIST, test_transfers: [SOL_1, SOL_1, BASE_1] });
  assert.deepEqual((twice.record as { problems: string[] }).problems, ["test_transfers_duplicated", "solana_transfers_missing"]);
  assert.equal((twice.activation as { active: boolean }).active, false);

  // Another hash with the same Sui mint digest is the same transfer too.
  const sameMint = await recordChecklist({
    ...CHECKLIST,
    test_transfers: [SOL_1, { ...SOL_1, source_tx_hash: signature("sol-other") }, BASE_1],
  });
  assert.deepEqual((sameMint.record as { problems: string[] }).problems, ["test_transfers_duplicated", "solana_transfers_missing"]);

  // An EVM hash in other letter case is the same Base transfer.
  const recased = await recordChecklist({
    ...CHECKLIST,
    test_transfers: [...CHECKLIST.test_transfers, { ...BASE_1, source_tx_hash: BASE_1.source_tx_hash.toUpperCase().replace("0X", "0x"), sui_digest: digest("sui-4") }],
  });
  assert.deepEqual((recased.record as { problems: string[] }).problems, ["test_transfers_duplicated"]);
});

test("Q-002: every test transfer must be at least $5 (5,000,000 atoms)", async () => {
  const tiny = await recordChecklist({
    ...CHECKLIST,
    test_transfers: CHECKLIST.test_transfers.map((transfer) => ({ ...transfer, amount_atoms: "1" })),
  });
  assert.deepEqual((tiny.record as { problems: string[] }).problems, [
    "test_transfer_below_5_usdc",
    "solana_transfers_missing",
    "base_transfers_missing",
  ]);
  const oneShort = await recordChecklist({
    ...CHECKLIST,
    test_transfers: [...CHECKLIST.test_transfers, { ...SOL_1, amount_atoms: "4999999", source_tx_hash: signature("sol-3"), sui_digest: digest("sui-5") }],
  });
  assert.deepEqual((oneShort.record as { problems: string[] }).problems, ["test_transfer_below_5_usdc"]);
  const larger = await recordChecklist({
    ...CHECKLIST,
    test_transfers: CHECKLIST.test_transfers.map((transfer) => ({ ...transfer, amount_atoms: "5000001" })),
  });
  assert.deepEqual((larger.record as { problems: string[] }).problems, []);
});

test("Q-002: a test transfer's hash must be its source's format, or the checklist is refused", async () => {
  for (const transfer of [
    { ...BASE_1, source_tx_hash: "x" },
    { ...BASE_1, source_tx_hash: `0x${"ab".repeat(31)}` },
    { ...BASE_1, source_tx_hash: SOL_1.source_tx_hash },
    { ...SOL_1, source_tx_hash: BASE_1.source_tx_hash },
    { ...SOL_1, source_tx_hash: "0OIl".repeat(22) },
  ]) {
    const command = ports({ "checklist.json": { ...CHECKLIST, test_transfers: [...CHECKLIST.test_transfers.slice(0, 2), transfer] } });
    await assert.rejects(
      runBridgeActivationCommand({ mode: "record", checklistPath: "checklist.json" }, operator, command),
      refused("OPERATOR_INPUT_INVALID"),
      transfer.source_tx_hash,
    );
    assert.equal(command.records.rows.length, 0);
  }
});

test("B-003: the allowance is compared with the raise and the wallet cap as non-blocking warnings", async () => {
  // The ticket asks for the comparison but states no rule that blocks activation: Standard still works.
  const fine = await recordChecklist(CHECKLIST);
  assert.deepEqual(fine.warnings, []);
  const low = await recordChecklist({ ...CHECKLIST, fast_allowance: { ...CHECKLIST.fast_allowance, allowance_usdc: "1" } });
  assert.equal((low.record as { complete: boolean }).complete, true);
  assert.deepEqual(low.warnings, ["fast_allowance_below_wallet_cap", "fast_allowance_below_raise"]);
  const between = await recordChecklist({ ...CHECKLIST, fast_allowance: { ...CHECKLIST.fast_allowance, allowance_usdc: "5000.000001" } });
  assert.deepEqual(between.warnings, ["fast_allowance_below_raise"]);
  const capAboveRaise = await recordChecklist({ ...CHECKLIST, fast_allowance: { ...CHECKLIST.fast_allowance, wallet_cap_atoms: "600000000000" } });
  assert.deepEqual(capAboveRaise.warnings, ["wallet_cap_above_raise"]);
});

const TEST_BURN = ["base", `0x${"CD".repeat(32)}`, hashId("operator-wallet"), "5000000", hashId("presale")] as const;

test("Q-001: register-test parses with the public registration's validation", () => {
  assert.deepEqual(parseBridgeActivationCommand(["register-test", ...TEST_BURN]), {
    mode: "register-test",
    registration: {
      source: "base",
      txHash: `0x${"cd".repeat(32)}`,
      suiAddress: hashId("operator-wallet"),
      amount: "5000000",
      presaleId: hashId("presale"),
      privyDid: null,
    },
  });
  const solana = parseBridgeActivationCommand(["register-test", "solana", signature("sol-test"), hashId("w"), "5000000", hashId("p")]);
  assert.equal(solana.mode === "register-test" && solana.registration.txHash, signature("sol-test"));
  for (const args of [
    ["register-test", ...TEST_BURN.slice(0, 4)],
    ["register-test", ...TEST_BURN, "extra"],
    ["register-test", "polygon", ...TEST_BURN.slice(1)],
    ["register-test", "base", "x", ...TEST_BURN.slice(2)],
    ["register-test", "solana", ...TEST_BURN.slice(1)],
    ["register-test", "base", TEST_BURN[1], "0xabc", "5000000", TEST_BURN[4]],
    ["register-test", "base", TEST_BURN[1], TEST_BURN[2], "0", TEST_BURN[4]],
    ["register-test", "base", TEST_BURN[1], TEST_BURN[2], "5000000", "presale"],
  ]) {
    assert.throws(() => parseBridgeActivationCommand(args), refused("OPERATOR_INPUT_INVALID"), args.join(" "));
  }
});

test("Q-001/B-004: register-test registers a checklist burn while the bridge is off, idempotently", async () => {
  const command = ports({});
  const registration = parseBridgeActivationCommand(["register-test", ...TEST_BURN]);
  const first = await runBridgeActivationCommand(registration, operator, command);
  assert.deepEqual(first.activation, { active: false, reason: "no_record", recordId: null }, "the gate stays closed");
  const { id, created } = first.transfer as { id: string; created: boolean };
  assert.equal(created, true);
  const stored = command.transfers.rows.get(id);
  assert.deepEqual([stored?.status, stored?.txHash, stored?.privyDid], ["sent", `0x${"cd".repeat(32)}`, null]);

  const repeat = await runBridgeActivationCommand(registration, operator, command);
  assert.deepEqual(repeat.transfer, { id, created: false });
  assert.equal(command.transfers.rows.size, 1);
});

test("Q-012: the registration rule lives in the contracts, with a neutral error, and the command does not load the routes", async () => {
  const { BridgeRegistrationError, parseBridgeTransferRegistration } = await import("@blast/core/modules/presale/bridge/contracts.ts");
  const body = { source: "base", tx_hash: `0x${"AB".repeat(32)}`, sui_address: hashId("w"), amount: "5000000", presale_id: hashId("p") };
  assert.deepEqual(parseBridgeTransferRegistration(body, null), {
    source: "base", txHash: `0x${"ab".repeat(32)}`, suiAddress: hashId("w"), amount: "5000000", presaleId: hashId("p"), privyDid: null,
  });
  for (const bad of [{ ...body, extra: 1 }, { ...body, amount: "0" }, { ...body, tx_hash: "x" }, null, []]) {
    assert.throws(() => parseBridgeTransferRegistration(bad, null), BridgeRegistrationError);
  }
  const source = await (await import("node:fs/promises")).readFile(new URL("./activation-command.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from "\.\/routes\.ts"/);
});
