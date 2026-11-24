import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { bcs } from "@mysten/sui/bcs";
import { Inputs, Transaction } from "@mysten/sui/transactions";
import { fromBase58, normalizeStructTag, normalizeSuiAddress, toBase58, toBase64, toHex } from "@mysten/sui/utils";

import { bridgeWithdrawMaxFee } from "@blast/core/modules/social/contracts/bridge-withdraw.ts";
import { presaleIdentityFixture } from "../../../../../core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { readPresaleDeploymentIdentity } from "@blast/core/modules/presale/deployment/service.ts";
import { buildBridgeActivationRecord, parseBridgeActivationChecklist, suiCctpKey } from "./activation.ts";
import { CircleUnavailableError } from "@blast/core/modules/presale/bridge/circle.ts";
import {
  CIRCLE_MESSAGE_TTL_MS,
  CircleWithdrawUnavailable,
  createCachedCircleWithdraw,
  createCircleWithdrawIris,
  parseForwardFees,
  parseWithdrawMessage,
  type CircleWithdrawIris,
} from "./circle-withdraw.ts";
import type { BridgeActivationChecklist, BridgeActivationRecord, BridgeConfiguration, BridgeWithdrawTestTransfer } from "@blast/core/modules/presale/bridge/contracts.ts";
import { memoryBridgeActivations } from "../../../../../core/test/fixtures/modules/presale/bridge/fixtures.ts";
import { bridgeMaxFee } from "@blast/core/modules/presale/bridge/quote.ts";
import {
  addSuiBurn,
  burnMatches,
  canonicalWithdrawRecipient,
  depositForBurnEvents,
  destinationDomain,
  forwardHookData,
  hookBytes,
  isForwardHook,
  SOLANA_USDC_MINT,
  SUI_CCTP_V2_MAINNET,
  suiBurnIds,
  suiBurnTransaction,
  WITHDRAW_DESTINATIONS,
  WITHDRAW_FINALITY_THRESHOLD,
  withdrawDestination,
  withdrawMintRecipient,
} from "@blast/core/modules/presale/bridge/sui-burn.ts";
import {
  bridgeWithdrawDestinations,
  createBridgeWithdrawGate,
  evaluateBridgeWithdraw,
  WITHDRAW_ACTIVATION_MAX_SECONDS,
} from "./withdraw-activation.ts";
import {
  cctpWithout,
  fixtureBurnEvents,
  fixtureWithdrawIris,
  FIXTURE_FORWARD_FEES,
  FIXTURE_FORWARDED_MESSAGE,
  FIXTURE_PLAIN_FEES,
  FIXTURE_PLAIN_MESSAGE,
  FORWARDED_BURN_DIGEST,
  PLAIN_BURN_DIGEST,
  SUI_BURN_VECTORS,
  SUI_CCTP_V2_IDENTITY,
} from "../../../../../core/test/fixtures/modules/presale/bridge/withdraw-fixtures.ts";

/**
 * Withdraw to another chain (CCTP V2 out of Sui, Circle's Forwarding
 * Service): the burn builder and event decoder against independently encoded
 * wire vectors, Circle's fee and message reads, destination activation, the
 * optional stablecoin handler, and max fees. The tests run offline.
 */

const hashId = (label: string) => `0x${createHash("sha256").update(label).digest("hex")}`;
const digest = (label: string) => toBase58(createHash("sha256").update(label).digest());
const EVM = `0x${"1e".repeat(20)}`;
const SOLANA_OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const FORWARD_HOOK_HEX = `636374702d666f7277617264${"0".repeat(40)}`;

// ---------- recipients, hooks and mint recipients ----------

test("a recipient is canonical for its chain: EVM lowercase with its checksum when mixed case and never zero; Solana a 32-byte base58 key", () => {
  assert.equal(canonicalWithdrawRecipient("base", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"), "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", "EIP-55's own example");
  assert.equal(canonicalWithdrawRecipient("ethereum", "  0x5AAEB6053F3E94C9B9A09F33669435E7EF1BEAED "), "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", "all upper carries no checksum");
  assert.equal(canonicalWithdrawRecipient("arbitrum", EVM), EVM);
  assert.equal(canonicalWithdrawRecipient("base", "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD"), null, "a broken checksum");
  assert.equal(canonicalWithdrawRecipient("base", `0x${"0".repeat(40)}`), null);
  assert.equal(canonicalWithdrawRecipient("base", `0x${"ab".repeat(32)}`), null, "a Sui address is not an EVM one");
  assert.equal(canonicalWithdrawRecipient("base", SOLANA_OWNER), null);
  assert.equal(canonicalWithdrawRecipient("solana", SOLANA_OWNER), SOLANA_OWNER);
  assert.equal(canonicalWithdrawRecipient("solana", EVM), null);
  assert.equal(canonicalWithdrawRecipient("solana", toBase58(new Uint8Array(32))), null, "the zero key");
  assert.equal(canonicalWithdrawRecipient("solana", toBase58(new Uint8Array(31).fill(7))), null, "31 bytes");
  assert.equal(canonicalWithdrawRecipient("solana", 42), null);
});

test("destinations, their CCTP domains and the Standard finality", () => {
  assert.deepEqual([...WITHDRAW_DESTINATIONS], ["base", "arbitrum", "ethereum", "solana"]);
  assert.deepEqual(WITHDRAW_DESTINATIONS.map(destinationDomain), [6, 3, 0, 5]);
  assert.equal(withdrawDestination("sui"), null);
  assert.equal(withdrawDestination("solana"), "solana");
  assert.equal(WITHDRAW_FINALITY_THRESHOLD, 2000);
});

test("the Forwarding hook: an EVM chain's is the 32 standard bytes; Solana's asks Circle to create the token account (65 bytes)", () => {
  const evm = forwardHookData("base", EVM);
  assert.equal(toHex(evm), FORWARD_HOOK_HEX);
  // The forwarded burn vector's hook, byte for byte.
  const vector = SUI_BURN_VECTORS[FORWARDED_BURN_DIGEST]!.events.find((event) => event.eventType.endsWith("::DepositForBurn"))!;
  assert.equal(toBase64(evm), vector.json.hook_data);
  assert.ok(isForwardHook(evm));

  const solana = forwardHookData("solana", SOLANA_OWNER);
  assert.equal(solana.length, 65);
  assert.equal(toHex(solana.subarray(0, 28)), FORWARD_HOOK_HEX.slice(0, 56), "magic and version 0");
  assert.equal(toHex(solana.subarray(28, 32)), "00000021", "33 bytes of Circle data");
  assert.equal(solana[32], 1, "create the recipient's token account");
  assert.deepEqual(solana.subarray(33), fromBase58(SOLANA_OWNER));
  assert.ok(isForwardHook(solana));

  assert.equal(isForwardHook(new Uint8Array(32)), false);
  assert.equal(isForwardHook(solana.subarray(0, 64)), false, "a length that disagrees with the header");
  assert.deepEqual(hookBytes(`0x${toHex(solana)}`), solana);
});

test("the mint recipient: an EVM address left-padded; for Solana the owner's classic-token USDC associated account", async () => {
  assert.equal(await withdrawMintRecipient("arbitrum", "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"), `0x${"0".repeat(24)}5aaeb6053f3e94c9b9a09f33669435e7ef1beaed`);
  // Checked against Solana's own program-address rule, with the ATA and Token programs named here, not taken from the helper.
  const { address, getAddressEncoder, getProgramDerivedAddress } = await import("@solana/kit");
  const encoder = getAddressEncoder();
  const [expected] = await getProgramDerivedAddress({
    programAddress: address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
    seeds: [encoder.encode(address(SOLANA_OWNER)), encoder.encode(address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")), encoder.encode(address(SOLANA_USDC_MINT))],
  });
  assert.equal(await withdrawMintRecipient("solana", SOLANA_OWNER), `0x${toHex(Uint8Array.from(encoder.encode(expected)))}`);
});

// ---------- the burn ----------

type Canonical = string | readonly unknown[] | Readonly<Record<string, unknown>>;

/** One Move call's target and arguments, independent of input order: pure bytes, shared objects, results relative to `base`. */
function canonicalCall(
  target: string,
  args: readonly Readonly<{ $kind: string; Input?: number; NestedResult?: readonly [number, number] }>[],
  input: (index: number) => Readonly<Record<string, unknown>>,
  base: number,
): Canonical[] {
  return [target, ...args.map((argument): Canonical => {
    if (argument.$kind === "NestedResult") return ["result", argument.NestedResult![0] - base, argument.NestedResult![1]];
    const value = input(argument.Input!) as { Pure?: { bytes: string }; Object?: { SharedObject?: { objectId: string; initialSharedVersion: string | number; mutable: boolean } } };
    if (value.Pure) return { pure: value.Pure.bytes };
    const shared = value.Object?.SharedObject;
    if (shared) return { shared: normalizeSuiAddress(shared.objectId), version: String(shared.initialSharedVersion), mutable: shared.mutable };
    return { other: argument.$kind };
  })];
}

/** The wire vector's last three calls (the burn), canonical, coin argument aside. */
function vectorBurnCalls(digestOf: string): Canonical[][] {
  const burn = SUI_BURN_VECTORS[digestOf]!;
  const calls = burn.commands.flatMap((command, index) => (typeof command.MoveCall === "string" ? [{ index, target: command.MoveCall, args: command.args as never }] : []));
  const last = calls.slice(-3);
  const base = last[0]!.index;
  return last.map((call) => canonicalCall(call.target.replace("<>", ""), call.args, (n) => burn.inputs[n]!, base));
}

function builtBurnCalls(kind: ReturnType<typeof bcs.TransactionKind.parse>): Canonical[][] {
  const { inputs, commands } = kind.ProgrammableTransaction!;
  const calls = commands.flatMap((command, index) => (command.MoveCall ? [{ index, call: command.MoveCall }] : [])).slice(-3);
  const base = calls[0]!.index;
  return calls.map(({ call }) => {
    const types = call.typeArguments.map((type) => normalizeStructTag(type));
    const target = `${normalizeSuiAddress(call.package)}::${call.module}::${call.function}${types.length ? `<${types.join(",")}>` : ""}`;
    return canonicalCall(target, call.arguments as never, (n) => inputs[n] as never, base);
  });
}

const OWNED_USDC = Inputs.ObjectRef({ objectId: hashId("usdc-coin"), version: "11", digest: digest("usdc-coin") });

test("the plain burn to Base matches the three-call wire vector, including shared versions and mutability", async () => {
  const vector = SUI_BURN_VECTORS[PLAIN_BURN_DIGEST]!;
  const event = fixtureBurnEvents(PLAIN_BURN_DIGEST);
  const [parsed] = depositForBurnEvents(event, SUI_CCTP_V2_MAINNET);
  const tx = new Transaction();
  tx.setSender(vector.sender);
  const [coin] = tx.splitCoins(tx.object(OWNED_USDC), [parsed!.amount]);
  addSuiBurn(tx, SUI_CCTP_V2_MAINNET, coin!, {
    destination: "base",
    amount: parsed!.amount,
    mintRecipient: parsed!.mintRecipient,
    maxFee: parsed!.maxFee,
    hookData: new Uint8Array(0),
  });
  const kind = bcs.TransactionKind.parse(await tx.build({ onlyTransactionKind: true }));
  const ours = builtBurnCalls(kind);
  const theirs = vectorBurnCalls(PLAIN_BURN_DIGEST);
  // The coin burned is a split of the sender's USDC in both; the rest is identical.
  assert.equal((ours[0]![1] as readonly unknown[])[0], "result");
  assert.deepEqual(ours.map((call, n) => (n === 0 ? [call[0], ...call.slice(2)] : call)), theirs.map((call, n) => (n === 0 ? [call[0], ...call.slice(2)] : call)));
});

test("a forwarded burn's arguments match the wire vector apart from the destination domain", async () => {
  const vector = SUI_BURN_VECTORS[FORWARDED_BURN_DIGEST]!;
  const [event] = depositForBurnEvents(fixtureBurnEvents(FORWARDED_BURN_DIGEST), SUI_CCTP_V2_MAINNET);
  const tx = new Transaction();
  tx.setSender(vector.sender);
  const [coin] = tx.splitCoins(tx.object(OWNED_USDC), [event!.amount]);
  addSuiBurn(tx, SUI_CCTP_V2_MAINNET, coin!, { destination: "base", amount: event!.amount, mintRecipient: event!.mintRecipient, maxFee: event!.maxFee, hookData: forwardHookData("base", EVM) });
  const [deposit] = builtBurnCalls(bcs.TransactionKind.parse(await tx.build({ onlyTransactionKind: true })));
  const [expectedDeposit] = vectorBurnCalls(FORWARDED_BURN_DIGEST);
  // Domain aside (the vector uses Arc, 26; ours to Base, 6), every argument is the same bytes.
  assert.deepEqual([deposit![3], deposit![4], deposit![5], deposit![6], deposit![7], deposit![8]], [expectedDeposit![3], expectedDeposit![4], expectedDeposit![5], expectedDeposit![6], expectedDeposit![7], expectedDeposit![8]]);
  assert.deepEqual(deposit![2], { pure: toBase64(bcs.u32().serialize(6).toBytes()) });
});

test("suiBurnTransaction takes exactly the amount of the sender's USDC, never the gas coin, then burns it", () => {
  const params = { destination: "solana" as const, amount: 5_000_000n, mintRecipient: hashId("ata"), maxFee: 344_900n, hookData: forwardHookData("solana", SOLANA_OWNER) };
  const tx = suiBurnTransaction(SUI_CCTP_V2_MAINNET, hashId("sender"), params);
  const data = tx.getData();
  assert.equal(data.sender, normalizeSuiAddress(hashId("sender")));
  assert.equal(data.commands[0]!.$kind, "$Intent");
  assert.deepEqual(
    data.commands.slice(1).map((command) => `${command.MoveCall?.module}::${command.MoveCall?.function}`),
    ["deposit_for_burn::deposit_for_burn", "handler::burn", "deposit_for_burn::complete_burn"],
  );
  const intent = data.commands[0]!.$Intent!;
  assert.equal(intent.name, "CoinWithBalance");
  assert.equal((intent.data as { balance: bigint }).balance, 5_000_000n);
});

test("the identity's ids become burn ids only with the V2 stablecoin handler", () => {
  const ids = suiBurnIds(SUI_CCTP_V2_IDENTITY);
  assert.deepEqual(ids, SUI_CCTP_V2_MAINNET);
  const v1 = cctpWithout("stablecoinHandler", "handlerState") as typeof SUI_CCTP_V2_IDENTITY;
  assert.equal(suiBurnIds(v1), null);
  assert.equal(suiBurnIds(null), null);
});

// ---------- the burn's event ----------

test("the DepositForBurn wire vectors decode to the expected fullnode fields, and only the identity's TokenMessengerMinter's count", () => {
  for (const digestOf of [FORWARDED_BURN_DIGEST, PLAIN_BURN_DIGEST]) {
    const events = depositForBurnEvents(fixtureBurnEvents(digestOf), SUI_CCTP_V2_MAINNET);
    assert.equal(events.length, 1, digestOf);
    const json = SUI_BURN_VECTORS[digestOf]!.events.find((event) => event.eventType.endsWith("::DepositForBurn"))!.json;
    assert.deepEqual(events[0], {
      amount: BigInt(json.amount as string),
      depositor: json.depositor,
      mintRecipient: json.mint_recipient,
      destinationDomain: json.destination_domain,
      destinationCaller: json.destination_caller,
      maxFee: BigInt(json.max_fee as string),
      minFinalityThreshold: json.min_finality_threshold,
      hookData: `0x${toHex(Uint8Array.from(Buffer.from(json.hook_data as string, "base64")))}`,
    }, digestOf);
    assert.deepEqual(depositForBurnEvents(fixtureBurnEvents(digestOf), { tokenMessengerMinter: hashId("another-tmm") }), [], "another package's event");
  }
  assert.deepEqual(depositForBurnEvents([{ eventType: `${SUI_CCTP_V2_MAINNET.tokenMessengerMinter}::deposit_for_burn::DepositForBurn`, bcs: new Uint8Array(3) }], SUI_CCTP_V2_MAINNET), [], "malformed BCS");
});

test("burnMatches holds only for exactly this withdrawal's burn: sender, destination, amount, recipient, fee, Standard finality and hook", () => {
  const events = depositForBurnEvents(fixtureBurnEvents(PLAIN_BURN_DIGEST), SUI_CCTP_V2_MAINNET);
  const event = events[0]!;
  const expected = {
    sender: SUI_BURN_VECTORS[PLAIN_BURN_DIGEST]!.sender,
    destination: "base" as const,
    amount: event.amount,
    mintRecipient: event.mintRecipient,
    maxFee: 0n,
    hookData: new Uint8Array(0),
  };
  assert.equal(burnMatches(events, expected), true);
  for (const change of [
    { sender: hashId("someone") },
    { destination: "arbitrum" as const },
    { amount: event.amount + 1n },
    { mintRecipient: hashId("other") },
    { maxFee: 1n },
    { hookData: forwardHookData("base", EVM) },
  ]) {
    assert.equal(burnMatches(events, { ...expected, ...change }), false, JSON.stringify(change, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
  }
  assert.equal(burnMatches([{ ...event, minFinalityThreshold: 1000 }], expected), false, "a Fast burn");
  assert.equal(burnMatches([{ ...event, destinationCaller: hashId("caller") }], expected), false, "a destination caller");
  // The forwarded vector uses Arc (26), which is no destination of ours.
  const arc = depositForBurnEvents(fixtureBurnEvents(FORWARDED_BURN_DIGEST), SUI_CCTP_V2_MAINNET);
  assert.equal(burnMatches(arc, { sender: SUI_BURN_VECTORS[FORWARDED_BURN_DIGEST]!.sender, destination: "base", amount: arc[0]!.amount, mintRecipient: arc[0]!.mintRecipient, maxFee: arc[0]!.maxFee, hookData: forwardHookData("base", EVM) }), false);
});

// ---------- the max fee ----------

test("bridgeWithdrawMaxFee is the deposit quote's protocol-fee rule, rounded up, plus Circle's forwarding fee", () => {
  // Sui to each destination charges 0 bps today: the max fee is the forwarding fee alone.
  assert.equal(bridgeWithdrawMaxFee(100_000_000n, "0", 54_800n), 54_800n);
  for (const [amount, bps] of [[1_000_000_000n, "1.3"], [1_000_000_000n, "1"], [7_777_777n, "0.5"], [1n, "2"], [123_456_789n, "1.25"]] as const) {
    assert.equal(bridgeWithdrawMaxFee(amount, bps, 0n), bridgeMaxFee(amount, bps), `${amount} at ${bps}`);
    assert.equal(bridgeWithdrawMaxFee(amount, bps, 80_769n), bridgeMaxFee(amount, bps) + 80_769n);
  }
  assert.equal(bridgeWithdrawMaxFee(1_000_000_000n, "1.3", 0n), 162_500n);
  assert.equal(bridgeWithdrawMaxFee(1n, "0.5", 0n), 1n, "a fraction of an atom rounds up");
});

// ---------- Circle ----------

test("Circle's forward fees parse: protocol bps per finality and the forwarding fee by level; a list without one is not forwarded", () => {
  const base = parseForwardFees(FIXTURE_FORWARD_FEES.base);
  assert.deepEqual(base, [
    { finalityThreshold: 1000, minimumFeeBps: "0", forwardFee: { low: 54_600n, med: 54_700n, high: 54_800n } },
    { finalityThreshold: 2000, minimumFeeBps: "0", forwardFee: { low: 54_600n, med: 54_700n, high: 54_800n } },
  ]);
  assert.equal(parseForwardFees(FIXTURE_FORWARD_FEES.solana)[1]!.forwardFee!.high, 344_900n, "with the account setup");
  assert.equal(parseForwardFees(FIXTURE_FORWARD_FEES.ethereum)[1]!.forwardFee!.high, 1_736_900n);
  for (const plain of Object.values(FIXTURE_PLAIN_FEES)) assert.ok(parseForwardFees(plain).every((entry) => entry.forwardFee === null));
  assert.deepEqual(parseForwardFees([{ finalityThreshold: 2000, minimumFee: 1.3, forwardFee: { low: "1", med: "2", high: "3" } }])[0], {
    finalityThreshold: 2000, minimumFeeBps: "1.3", forwardFee: { low: 1n, med: 2n, high: 3n },
  });
  for (const malformed of [{}, [{ minimumFee: 0 }], [{ finalityThreshold: 2000, minimumFee: -1 }], [{ finalityThreshold: 2000, minimumFee: 0, forwardFee: 5 }], [{ finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 1, med: 2, high: -3 } }]]) {
    assert.throws(() => parseForwardFees(malformed), (error: unknown) => error instanceof CircleUnavailableError && error.kind === "malformed", JSON.stringify(malformed));
  }
});

test("Circle's message for a burn: attested, its forward state and destination hash, and what Circle kept; nothing yet is null", () => {
  assert.deepEqual({ ...parseWithdrawMessage(FIXTURE_FORWARDED_MESSAGE), message: "…" }, {
    status: "complete",
    message: "…",
    forwardState: "COMPLETE",
    forwardTxHash: `0x${"d5".repeat(32)}`,
    feeExecuted: 203_017n,
    delayReason: null,
  });
  assert.match(parseWithdrawMessage(FIXTURE_FORWARDED_MESSAGE)!.message!, /^0x[0-9a-f]+$/);
  const plain = parseWithdrawMessage(FIXTURE_PLAIN_MESSAGE)!;
  assert.deepEqual([plain.status, plain.forwardState, plain.forwardTxHash, plain.feeExecuted], ["complete", null, null, 0n]);
  assert.equal(parseWithdrawMessage(null), null);
  assert.equal(parseWithdrawMessage({ messages: [] }), null);
  const pending = parseWithdrawMessage({ messages: [{ status: "pending_confirmations", message: "0xabcd", forwardState: "PENDING", delayReason: "insufficient_fee" }] })!;
  assert.deepEqual(pending, { status: "pending_confirmations", message: null, forwardState: "PENDING", forwardTxHash: null, feeExecuted: null, delayReason: "insufficient_fee" });
  // Free text never passes: a forward state or delay reason outside the fixed shapes is dropped.
  const odd = parseWithdrawMessage({ messages: [{ status: "complete", forwardState: "<script>", delayReason: "Something Went Wrong", forwardTxHash: "nope" }] })!;
  assert.deepEqual([odd.forwardState, odd.delayReason, odd.forwardTxHash], [null, null, null]);
  assert.throws(() => parseWithdrawMessage({ messages: "x" }), CircleUnavailableError);
});

test("the Iris client asks the documented routes: forward fees per destination (Solana with its account setup) and the burn's message by Sui digest", async () => {
  const iris = fixtureWithdrawIris({ messages: { [FORWARDED_BURN_DIGEST]: FIXTURE_FORWARDED_MESSAGE } });
  const client = createCircleWithdrawIris({ fetch: iris.fetch, timeoutMs: 100 });
  for (const destination of WITHDRAW_DESTINATIONS) await client.forwardFees(destination);
  assert.deepEqual(iris.requests, [
    "/v2/burn/USDC/fees/8/6?forward=true",
    "/v2/burn/USDC/fees/8/3?forward=true",
    "/v2/burn/USDC/fees/8/0?forward=true",
    "/v2/burn/USDC/fees/8/5?forward=true&includeRecipientSetup=true",
  ]);
  assert.equal((await client.message(FORWARDED_BURN_DIGEST))?.forwardState, "COMPLETE");
  assert.equal(await client.message(PLAIN_BURN_DIGEST), null, "Circle has not seen it yet (404)");
  await assert.rejects(client.message("not a digest"), CircleUnavailableError);
  iris.state.status = 429;
  await assert.rejects(client.forwardFees("base"), (error: unknown) => error instanceof CircleUnavailableError && error.kind === "rate_limited");
  iris.state.status = 500;
  await assert.rejects(client.message(FORWARDED_BURN_DIGEST), (error: unknown) => error instanceof CircleUnavailableError && error.kind === "unavailable");
});

test("the cached facade: one request per key in flight, fees reused for the TTL, a failure not repeated, and nothing sent during Circle's 429 block", async () => {
  let now = 1_000_000;
  const calls: string[] = [];
  let fail: CircleUnavailableError | null = null;
  const iris: CircleWithdrawIris = {
    async forwardFees(destination) {
      calls.push(`fees:${destination}`);
      if (fail) throw fail;
      return parseForwardFees(FIXTURE_FORWARD_FEES[destination]);
    },
    async message(suiDigest) {
      calls.push(`message:${suiDigest}`);
      if (fail) throw fail;
      return null;
    },
  };
  const cached = createCachedCircleWithdraw(iris, { now: () => now, ttlMs: 30_000, failureTtlMs: 10_000, rateLimitBlockMs: 300_000 });
  const [a, b] = await Promise.all([cached.forwardFees("base"), cached.forwardFees("base")]);
  assert.equal(a, b);
  await cached.forwardFees("base");
  assert.deepEqual(calls, ["fees:base"], "deduplicated and cached");
  await cached.message(PLAIN_BURN_DIGEST);
  now += CIRCLE_MESSAGE_TTL_MS + 1;
  await cached.message(PLAIN_BURN_DIGEST);
  assert.equal(calls.filter((call) => call.startsWith("message:")).length, 2, "a message is reused for its own shorter TTL");

  fail = new CircleUnavailableError("unavailable");
  now += 30_001;
  await assert.rejects(cached.forwardFees("base"), (error: unknown) => error instanceof CircleWithdrawUnavailable && error.retryAfterSeconds === 10);
  const before = calls.length;
  await assert.rejects(cached.forwardFees("base"), CircleWithdrawUnavailable);
  assert.equal(calls.length, before, "the failure is remembered");

  fail = new CircleUnavailableError("rate_limited");
  await assert.rejects(cached.forwardFees("arbitrum"), (error: unknown) => error instanceof CircleWithdrawUnavailable && error.retryAfterSeconds === 300);
  fail = null;
  const blocked = calls.length;
  await assert.rejects(cached.forwardFees("solana"), (error: unknown) => error instanceof CircleWithdrawUnavailable && error.retryAfterSeconds === 300);
  await assert.rejects(cached.message(FORWARDED_BURN_DIGEST), CircleWithdrawUnavailable);
  assert.equal(calls.length, blocked, "nothing is sent while blocked");
  now += 300_001;
  assert.equal((await cached.forwardFees("solana")).length, 2);
});

// ---------- activation ----------

const RELAYER = hashId("bridge-relayer");
const CCTP_V2_ENV = { PRESALE_DEPLOYMENT_MANIFEST: JSON.stringify(presaleIdentityFixture({ cctp: SUI_CCTP_V2_IDENTITY })) };

function checklist(withdraw?: BridgeActivationChecklist["withdraw"]): BridgeActivationChecklist {
  return {
    forwarding: "blast",
    relayer_address: RELAYER,
    hook_data: null,
    circle: { domain8_v2: true, domain8_fast: true, checked_at: "2026-10-05T09:00:00.000Z" },
    fast_allowance: { allowance_usdc: "2500000.5", raise_atoms: "500000000000", wallet_cap_atoms: "5000000000" },
    test_transfers: [
      { source: "solana", amount_atoms: "5000000", source_tx_hash: digest("sol-1") + digest("sol-1/2"), sui_digest: digest("sui-1"), burn_to_mint_seconds: 21 },
      { source: "solana", amount_atoms: "5000000", source_tx_hash: digest("sol-2") + digest("sol-2/2"), sui_digest: digest("sui-2"), burn_to_mint_seconds: 19 },
      { source: "base", amount_atoms: "5000000", source_tx_hash: `0x${"ab".repeat(32)}`, sui_digest: digest("sui-3"), burn_to_mint_seconds: 33 },
    ],
    ...(withdraw ? { withdraw } : {}),
  };
}

const passing = (destination: BridgeWithdrawTestTransfer["destination"], n: number, overrides: Partial<BridgeWithdrawTestTransfer> = {}): BridgeWithdrawTestTransfer => ({
  destination,
  amount_atoms: "5000000",
  sui_digest: digest(`withdraw-${n}`),
  destination_tx_hash: destination === "solana" ? digest(`dest-${n}`) + digest(`dest-${n}/2`) : `0x${n.toString(16).padStart(64, "0")}`,
  burn_to_mint_seconds: 40,
  ...overrides,
});

test("a destination is proven by one passing withdrawal: at least $5, minted in under 300 s, a repeated digest or hash counted once; in the sheet's order", () => {
  assert.deepEqual(bridgeWithdrawDestinations(undefined), []);
  assert.deepEqual(bridgeWithdrawDestinations({ test_transfers: [passing("solana", 1), passing("base", 2)] }), ["base", "solana"]);
  assert.deepEqual(bridgeWithdrawDestinations({ test_transfers: [passing("base", 1, { amount_atoms: "4999999" })] }), []);
  assert.deepEqual(bridgeWithdrawDestinations({ test_transfers: [passing("base", 1, { burn_to_mint_seconds: WITHDRAW_ACTIVATION_MAX_SECONDS })] }), []);
  assert.deepEqual(bridgeWithdrawDestinations({ test_transfers: [passing("ethereum", 1), passing("arbitrum", 1, { destination_tx_hash: `0x${"9".repeat(64)}` })] }), ["ethereum"], "the same Sui digest twice");
  assert.deepEqual(bridgeWithdrawDestinations({ test_transfers: [passing("base", 1), passing("base", 2, { destination_tx_hash: passing("base", 1).destination_tx_hash })] }), ["base"]);
});

test("the checklist's optional withdraw part parses exactly; an unknown key, a bad destination or hash is refused", () => {
  const withdraw = { test_transfers: [passing("base", 1), passing("solana", 2)] };
  assert.deepEqual(parseBridgeActivationChecklist(structuredClone(checklist(withdraw))).withdraw, withdraw);
  assert.equal(parseBridgeActivationChecklist(structuredClone(checklist())).withdraw, undefined);
  for (const bad of [
    { test_transfers: [{ ...passing("base", 1), extra: 1 }] },
    { test_transfers: [{ ...passing("base", 1), destination: "sui" }] },
    { test_transfers: [{ ...passing("base", 1), destination_tx_hash: "0x12" }] },
    { test_transfers: [{ ...passing("solana", 1), destination_tx_hash: `0x${"1".repeat(64)}` }] },
    { test_transfers: [{ ...passing("base", 1), sui_digest: "nope" }] },
    { test_transfers: [{ ...passing("base", 1), burn_to_mint_seconds: -1 }] },
    { test_transfers: "none" },
    { test_transfers: [], more: true },
  ]) {
    assert.throws(() => parseBridgeActivationChecklist(structuredClone({ ...checklist(), withdraw: bad })), JSON.stringify(bad));
  }
});

function configuration(env: Record<string, string> = CCTP_V2_ENV): BridgeConfiguration {
  return { identity: readPresaleDeploymentIdentity(env), forwarding: "blast", relayerAddress: RELAYER };
}

function record(list: BridgeActivationChecklist, config: BridgeConfiguration, id = "1"): BridgeActivationRecord {
  const cctp = config.identity.status === "ready" ? config.identity.identity.cctp ?? null : null;
  return { ...buildBridgeActivationRecord({ checklist: list, suiCctp: cctp, recordedBy: "operator:ops" }), id, recordedAt: new Date(0) };
}

test("withdrawals are off unless the bridge is on, the identity names the V2 handler, and the record proved the destination", () => {
  const config = configuration();
  assert.deepEqual(evaluateBridgeWithdraw(null, config), { active: false, reason: "no_record", live: [] });
  assert.deepEqual(evaluateBridgeWithdraw(record(checklist(), config), config), { active: false, reason: "no_withdraw_tests", live: [] });
  const proven = record(checklist({ test_transfers: [passing("solana", 1), passing("base", 2)] }), config);
  const on = evaluateBridgeWithdraw(proven, config);
  assert.equal(on.active, true);
  assert.deepEqual(on.live, ["base", "solana"]);
  assert.ok(on.active && on.recordId === "1");
  assert.deepEqual(on.active ? on.ids : null, SUI_CCTP_V2_MAINNET);

  // Another forwarding mode or relayer than the record's is the bridge's own refusal.
  assert.equal(evaluateBridgeWithdraw(proven, { ...config, relayerAddress: hashId("another") }).active, false);

  // The identity without the handler: the bridge's key changes (no V2 burn ids), and withdrawals stay off.
  const v1 = cctpWithout("stablecoinHandler", "handlerState") as typeof SUI_CCTP_V2_IDENTITY;
  const v1Config = configuration({ PRESALE_DEPLOYMENT_MANIFEST: JSON.stringify(presaleIdentityFixture({ cctp: v1 })) });
  assert.deepEqual(evaluateBridgeWithdraw(proven, v1Config), { active: false, reason: "sui_cctp_changed", live: [] });
  const v1Record = record(checklist({ test_transfers: [passing("base", 2)] }), v1Config);
  assert.deepEqual(evaluateBridgeWithdraw(v1Record, v1Config), { active: false, reason: "sui_burn_ids_missing", live: [] });
  assert.notEqual(suiCctpKey(SUI_CCTP_V2_IDENTITY), suiCctpKey(v1), "the handler is part of the ids a record was made for");
});

test("the withdrawal gate reads the latest record on every call", async () => {
  const config = configuration();
  const records = memoryBridgeActivations();
  const gate = createBridgeWithdrawGate({ records, configuration: () => config });
  assert.equal((await gate.current()).active, false);
  await records.record(buildBridgeActivationRecord({ checklist: checklist({ test_transfers: [passing("arbitrum", 3)] }), suiCctp: SUI_CCTP_V2_IDENTITY, recordedBy: "operator:ops" }));
  assert.deepEqual((await gate.current()).live, ["arbitrum"]);
});

// ---------- the deployment identity ----------

test("the identity's cctp block takes the V2 stablecoin handler as a pair, normalized, and refuses half of it", () => {
  const state = readPresaleDeploymentIdentity(CCTP_V2_ENV);
  assert.equal(state.status, "ready");
  assert.ok(state.status === "ready");
  assert.equal(state.identity.cctp?.stablecoinHandler, SUI_CCTP_V2_MAINNET.stablecoinHandler);
  assert.deepEqual(state.identity.cctp?.handlerState, SUI_CCTP_V2_MAINNET.handlerState);
  const shortDeny = readPresaleDeploymentIdentity({ PRESALE_DEPLOYMENT_MANIFEST: JSON.stringify(presaleIdentityFixture({ cctp: { ...SUI_CCTP_V2_IDENTITY, denyList: { objectId: "0x403", initialSharedVersion: "65624845" } } })) });
  assert.ok(shortDeny.status === "ready" && shortDeny.identity.cctp?.denyList.objectId === SUI_CCTP_V2_MAINNET.denyList.objectId);
  const half = cctpWithout("handlerState");
  assert.equal(readPresaleDeploymentIdentity({ PRESALE_DEPLOYMENT_MANIFEST: JSON.stringify(presaleIdentityFixture({ cctp: half })) }).status, "unavailable");
  const otherHalf = cctpWithout("stablecoinHandler");
  assert.equal(readPresaleDeploymentIdentity({ PRESALE_DEPLOYMENT_MANIFEST: JSON.stringify(presaleIdentityFixture({ cctp: otherHalf })) }).status, "unavailable");
  assert.equal(
    readPresaleDeploymentIdentity({ PRESALE_DEPLOYMENT_MANIFEST: JSON.stringify(presaleIdentityFixture({ cctp: { ...SUI_CCTP_V2_IDENTITY, handlerState: { objectId: "0x1" } } })) }).status,
    "unavailable",
  );
});
