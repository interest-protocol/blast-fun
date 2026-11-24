// Fixtures for the bridge relayer worker (T-021): CCTP V1 and V2 messages,
// a fixture attester, a fixture Circle messages API (`GET /v2/messages/{src}`
// in the shape Circle documents, checked 2026-10-02), and a fixture Sui node
// that runs Sui CCTP V1's receive path (`receive_message` →
// `handle_receive_message` → `deconstruct_stamp_receipt_ticket_with_burn_message`
// → `stamp_receipt` → `complete_receive_message`, after Circle's
// `circlefin/sui-cctp` `scripts/sui-scripts/receiveMessage.ts`) over an
// in-memory used-nonce table. Tests and rehearsals only: nothing here calls
// Circle or a Sui network, and nothing holds value.

import { SUI_COIN_TYPE as SUI } from "@blast/core/lib/sui/coin-types.ts";
import { createHash, randomBytes } from "node:crypto";

import { bcs } from "@mysten/sui/bcs";
import { ObjectError, TransactionError, type ClientWithCoreApi, type SuiClientTypes } from "@mysten/sui/client";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import {
  deriveDynamicFieldID,
  fromBase64,
  fromHex,
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  toBase58,
  toHex,
} from "@mysten/sui/utils";
import { verifyTransactionSignature } from "@mysten/sui/verify";

import { decodeCctpMessage, SOURCE_TOKEN_MESSENGER, SOURCE_USDC_BURN_TOKEN, usedNonceKeyV1, type CctpMessage } from "../../../../../src/modules/presale/bridge/cctp-message.ts";
import { CCTP_SOURCE_DOMAINS, SUI_CCTP_DOMAIN, type BridgeSource, type SuiCctpIds } from "../../../../../src/modules/presale/bridge/contracts.ts";

const ZERO32 = `0x${"0".repeat(64)}`;

function hex32(value: string): string {
  return value.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function u32be(value: number): string {
  return value.toString(16).padStart(8, "0");
}

function uint(value: bigint, bytes: number): string {
  return value.toString(16).padStart(bytes * 2, "0");
}

export type CctpMessageFixture = Readonly<{
  /** 0 (V1, the default: Sui's published CCTP) or 1 (V2). */
  version?: 0 | 1;
  source?: BridgeSource;
  sourceDomain?: number;
  destinationDomain?: number;
  nonce?: bigint;
  recipient?: string;
  amount?: bigint;
  destinationCaller?: string;
  burnToken?: string;
  /** The message's sender: the source's Circle TokenMessenger unless given (a generic message's sender otherwise). */
  sender?: string;
  /** V2 only: 1000 (Fast) or 2000 (Standard). */
  minFinalityThreshold?: number;
}>;

/** A CCTP burn message, `0x` + hex, laid out as Circle's contracts emit it. */
export function cctpMessageFixture(options: CctpMessageFixture = {}): string {
  const version = options.version ?? 0;
  const source = options.source ?? "base";
  const sourceDomain = options.sourceDomain ?? CCTP_SOURCE_DOMAINS[source];
  const destinationDomain = options.destinationDomain ?? SUI_CCTP_DOMAIN;
  const nonce = options.nonce ?? 1n;
  const recipient = hex32(options.recipient ?? `0x${"a1".repeat(32)}`);
  const amount = options.amount ?? 5_000_000n;
  const caller = hex32(options.destinationCaller ?? ZERO32);
  const burnToken = hex32(options.burnToken ?? SOURCE_USDC_BURN_TOKEN[source]);
  const sender = hex32(`0x${"5e".repeat(32)}`);
  const tokenMessenger = hex32(options.sender ?? SOURCE_TOKEN_MESSENGER[version][source]);
  const remoteRecipient = hex32(`0x${"7e".repeat(32)}`);
  const header = version === 0
    ? `${u32be(0)}${u32be(sourceDomain)}${u32be(destinationDomain)}${uint(nonce, 8)}${tokenMessenger}${remoteRecipient}${caller}`
    : `${u32be(1)}${u32be(sourceDomain)}${u32be(destinationDomain)}${uint(nonce, 32)}${tokenMessenger}${remoteRecipient}${caller}${u32be(options.minFinalityThreshold ?? 1000)}${u32be(options.minFinalityThreshold ?? 1000)}`;
  const body = version === 0
    ? `${u32be(0)}${burnToken}${recipient}${uint(amount, 32)}${sender}`
    : `${u32be(1)}${burnToken}${recipient}${uint(amount, 32)}${sender}${uint(1000n, 32)}${uint(500n, 32)}${uint(0n, 32)}`;
  return `0x${header}${body}`;
}

/** The fixture attester's 65-byte signature over `message`: the only attestation the fixture node accepts. */
export function fixtureAttestation(message: string): string {
  const digest = createHash("sha256").update(`fixture-attester:${message.toLowerCase()}`).digest("hex");
  return `0x${digest}${digest}1b`;
}

/** Hash-derived Sui CCTP ids for a fixture identity (`cctp`). */
export function suiCctpFixture(label = "fixture"): SuiCctpIds {
  const id = (name: string) => `0x${createHash("sha256").update(`sui-cctp:${label}:${name}`).digest("hex")}`;
  return Object.freeze({
    messageTransmitter: id("message-transmitter"),
    tokenMessengerMinter: id("token-messenger-minter"),
    mtState: Object.freeze({ objectId: id("mt-state"), initialSharedVersion: "11" }),
    tmmState: Object.freeze({ objectId: id("tmm-state"), initialSharedVersion: "12" }),
    usdcTreasury: Object.freeze({ objectId: id("usdc-treasury"), initialSharedVersion: "13" }),
    usdcType: normalizeStructTag(`${id("usdc")}::usdc::USDC`),
    denyList: Object.freeze({ objectId: normalizeSuiObjectId("0x403"), initialSharedVersion: "1" }),
  });
}

// ---------------------------------------------------------------------------
// The fixture Circle messages API.

/** What the fixture answers for one `(source domain, transaction hash)`. */
export type CircleMessageScenario =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "pending"; message: string; delayReason?: string | null }>
  | Readonly<{ kind: "complete"; message: string; attestation?: string; forwardState?: string | null; forwardTxHash?: string | null }>
  | Readonly<{ kind: "many"; messages: ReadonlyArray<Extract<CircleMessageScenario, { kind: "pending" | "complete" }>> }>
  | Readonly<{ kind: "rate_limited" }>
  | Readonly<{ kind: "error" }>;

function decodedBody(message: CctpMessage) {
  return {
    sourceDomain: String(message.sourceDomain),
    destinationDomain: String(message.destinationDomain),
    nonce: message.version === 0 ? String(BigInt(message.nonce)) : message.nonce,
    sender: message.sender,
    recipient: message.recipient,
    destinationCaller: message.destinationCaller,
    ...(message.version === 1
      ? { minFinalityThreshold: String(message.minFinalityThreshold), finalityThresholdExecuted: String(message.finalityThresholdExecuted) }
      : {}),
    messageBody: `0x${message.hex.slice(message.version === 0 ? 2 + 232 : 2 + 296)}`,
    decodedMessageBody: message.body
      ? {
        // EVM tokens as Circle shows them: 20 bytes, mixed case.
        burnToken: message.body.burnToken.startsWith(`0x${"0".repeat(24)}`) ? `0x${message.body.burnToken.slice(26).toUpperCase()}` : message.body.burnToken,
        mintRecipient: message.body.mintRecipient,
        amount: String(message.body.amount),
        messageSender: message.body.messageSender,
      }
      : null,
  };
}

/** One message as Circle's `MessageV2` schema has it. */
export function circleMessageBody(scenario: Extract<CircleMessageScenario, { kind: "pending" | "complete" }>): Record<string, unknown> {
  const message = decodeCctpMessage(scenario.message);
  const complete = scenario.kind === "complete";
  return {
    message: complete ? scenario.message : "0x",
    eventNonce: message.version === 0 ? String(BigInt(message.nonce)) : message.nonce,
    attestation: complete ? (scenario.attestation ?? fixtureAttestation(scenario.message)) : "PENDING",
    decodedMessage: decodedBody(message),
    cctpVersion: message.version === 0 ? 1 : 2,
    status: complete ? "complete" : "pending_confirmations",
    delayReason: scenario.kind === "pending" ? (scenario.delayReason ?? null) : null,
    ...(complete && scenario.forwardState !== undefined ? { forwardState: scenario.forwardState } : {}),
    ...(complete && scenario.forwardTxHash ? { forwardTxHash: scenario.forwardTxHash } : {}),
  };
}

/** A fixture Iris messages API on Circle's mainnet host, scripted per burn; it records every request. */
export function fixtureCircleMessages() {
  const scenarios = new Map<string, CircleMessageScenario>();
  const state = {
    requests: [] as Array<Readonly<{ domain: number; txHash: string }>>,
    /** Forces every answer, whatever the scripts say. */
    mode: null as null | "rate_limited" | "error",
  };
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.origin !== "https://iris-api.circle.com") throw new Error(`unexpected host ${url.origin}`);
    const match = url.pathname.match(/^\/v2\/messages\/(\d+)$/);
    const txHash = url.searchParams.get("transactionHash");
    if (!match || !txHash) return Response.json({ code: 400, message: "Bad request." }, { status: 400 });
    const domain = Number(match[1]);
    state.requests.push({ domain, txHash });
    const scenario = state.mode ? { kind: state.mode } : (scenarios.get(`${domain}:${txHash}`) ?? { kind: "not_found" as const });
    switch (scenario.kind) {
      case "not_found":
        return Response.json({ code: 404, message: "Message hash not found" }, { status: 404 });
      case "rate_limited":
        return Response.json({ error: "Too Many Requests" }, { status: 429 });
      case "error":
        return new Response("upstream error", { status: 500 });
      case "many":
        return Response.json({ messages: scenario.messages.map(circleMessageBody), sourceTxHash: txHash });
      default:
        return Response.json({ messages: [circleMessageBody(scenario)], sourceTxHash: txHash });
    }
  };
  return {
    state,
    fetch,
    /** Scripts the answer for one burn. */
    set(source: BridgeSource, txHash: string, scenario: CircleMessageScenario) {
      scenarios.set(`${CCTP_SOURCE_DOMAINS[source]}:${txHash}`, scenario);
    },
    /** Requests made for one burn. */
    requestsFor(source: BridgeSource, txHash: string): number {
      return state.requests.filter((request) => request.domain === CCTP_SOURCE_DOMAINS[source] && request.txHash === txHash).length;
    },
  };
}

// ---------------------------------------------------------------------------
// The fixture Sui node with the CCTP V1 receive path.

export const FIXTURE_CCTP_GAS_COST = 3_000_000n;
const GAS_PRICE = "1000";

export type CctpFixtureNodeBehavior = {
  chainIdentifier: string;
  /**
   * `lost-response`: it lands and the answer is lost; `dropped`: it never
   * reaches the node; `hidden`: it lands, and no read sees it until `reveal()`
   * (a node that executed it while the worker died); `abort`: it lands and aborts.
   */
  execution: "complete" | "lost-response" | "dropped" | "hidden" | "abort";
};

type Landed = { effects: SuiClientTypes.TransactionEffects; events: SuiClientTypes.Event[]; checkpoint: string };

export type FixtureMint = Readonly<{ digest: string; recipient: string; amount: bigint; nonce: string; sourceDomain: number; caller: string }>;

function effects(digest: string, status: SuiClientTypes.ExecutionStatus): SuiClientTypes.TransactionEffects {
  return {
    bcs: null,
    version: 2,
    status,
    gasUsed: { computationCost: String(FIXTURE_CCTP_GAS_COST), storageCost: "0", storageRebate: "0", nonRefundableStorageFee: "0" },
    transactionDigest: digest,
    gasObject: null,
    eventsDigest: null,
    dependencies: [],
    lamportVersion: null,
    changedObjects: [],
    unchangedConsensusObjects: [],
    auxiliaryDataDigest: null,
  };
}

function abort(module: string, code: number, message: string): SuiClientTypes.ExecutionStatus {
  return { success: false, error: { $kind: "MoveAbort", message: `${module}: ${message}`, MoveAbort: { abortCode: String(code) } } as SuiClientTypes.ExecutionError };
}

function answer(digest: string, landed: Landed) {
  const transaction = {
    digest,
    signatures: [],
    epoch: "1",
    timestampMs: 1_790_000_000_000,
    checkpoint: landed.checkpoint,
    status: landed.effects.status,
    balanceChanges: undefined,
    effects: landed.effects,
    events: landed.events,
    objectTypes: {},
    transaction: undefined,
    bcs: undefined,
  };
  return landed.effects.status.success
    ? { $kind: "Transaction" as const, Transaction: transaction }
    : { $kind: "FailedTransaction" as const, FailedTransaction: transaction };
}

const MessageReceived = bcs.struct("MessageReceived", {
  caller: bcs.Address,
  source_domain: bcs.u32(),
  nonce: bcs.u64(),
  sender: bcs.Address,
  message_body: bcs.vector(bcs.u8()),
});

/** The prefix of Sui CCTP V1's `message_transmitter::state::State` the relayer reads, plus trailing fields. */
const StateFixture = bcs.struct("State", {
  id: bcs.Address,
  local_domain: bcs.u32(),
  message_version: bcs.u32(),
  max_message_body_size: bcs.u64(),
  enabled_attesters: bcs.vector(bcs.Address),
  next_available_nonce: bcs.u64(),
  used_nonces: bcs.struct("Table", { id: bcs.Address, size: bcs.u64() }),
  signature_threshold: bcs.u64(),
  paused: bcs.bool(),
  trailing: bcs.vector(bcs.u8()),
});

type TxData = ReturnType<Transaction["getData"]>;
type Argument = TxData["commands"][number] extends infer C ? (C extends { MoveCall?: infer M } ? (M extends { arguments: Array<infer A> } ? A : never) : never) : never;

/**
 * An in-memory Sui node with the CCTP V1 receive path for `cctp`: SUI address
 * balances (which pay gas: no gas coin, a `ValidDuring` expiration for the
 * current epoch on this chain),
 * the shared CCTP objects, the used-nonce table, `MessageReceived` events,
 * and scripted execution failures.
 */
export function createCctpFixtureNode(cctp: SuiCctpIds, behavior: Partial<CctpFixtureNodeBehavior> & { chainIdentifier: string }) {
  const state: CctpFixtureNodeBehavior = { execution: "complete", ...behavior };
  const mt = normalizeSuiAddress(cctp.messageTransmitter);
  const tmm = normalizeSuiAddress(cctp.tokenMessengerMinter);
  const usedNonceTable = normalizeSuiObjectId(`0x${createHash("sha256").update(`used-nonces:${mt}`).digest("hex")}`);
  const calls = { simulate: 0, execute: 0, listEvents: 0, mints: [] as FixtureMint[] };
  /** Whether a used-nonce field reports its creating transaction (`previousTransaction`). */
  const fields = { previousTransaction: true };
  const addressBalances = new Map<string, bigint>();
  let epoch = 1;
  const landed = new Map<string, Landed>();
  const hidden = new Set<string>();
  /** Used-nonce keys, each with the transaction that created its field. */
  const used = new Map<string, string>();
  const events: Array<SuiClientTypes.EventEntry> = [];
  let checkpoint = 100;
  const shared = new Map<string, { type: string; initialSharedVersion: string; content?: Uint8Array }>([
    [normalizeSuiObjectId(cctp.mtState.objectId), {
      type: `${mt}::state::State`,
      initialSharedVersion: cctp.mtState.initialSharedVersion,
      content: StateFixture.serialize({
        id: cctp.mtState.objectId,
        local_domain: SUI_CCTP_DOMAIN,
        message_version: 0,
        max_message_body_size: 8192n,
        enabled_attesters: [`0x${"a7".repeat(32)}`],
        next_available_nonce: 0n,
        used_nonces: { id: usedNonceTable, size: 0n },
        signature_threshold: 1n,
        paused: false,
        trailing: [1, 2, 3, 4],
      }).toBytes(),
    }],
    [normalizeSuiObjectId(cctp.tmmState.objectId), { type: `${tmm}::state::State`, initialSharedVersion: cctp.tmmState.initialSharedVersion }],
    [normalizeSuiObjectId(cctp.usdcTreasury.objectId), { type: `0x2::coin::TreasuryCap<${cctp.usdcType}>`, initialSharedVersion: cctp.usdcTreasury.initialSharedVersion }],
    [normalizeSuiObjectId(cctp.denyList.objectId), { type: "0x2::deny_list::DenyList", initialSharedVersion: cctp.denyList.initialSharedVersion }],
  ]);

  const digest32 = () => toBase58(randomBytes(32));

  function markUsed(message: CctpMessage, caller: string, digest: string) {
    used.set(usedNonceKeyV1(message.sourceDomain, BigInt(message.nonce)), digest);
    checkpoint += 1;
    events.push({
      packageId: mt,
      module: "receive_message",
      sender: caller,
      eventType: `${mt}::receive_message::MessageReceived`,
      bcs: MessageReceived.serialize({
        caller,
        source_domain: message.sourceDomain,
        nonce: BigInt(message.nonce),
        sender: message.sender,
        message_body: [...fromHex(message.hex.slice(2 + 232))],
      }).toBytes(),
      json: null,
      checkpoint: String(checkpoint),
      transactionDigest: digest,
      eventIndex: 0,
    });
    return checkpoint;
  }

  function pure(data: TxData, argument: Argument | undefined): Uint8Array | null {
    if (argument?.$kind !== "Input") return null;
    const input = data.inputs[argument.Input];
    if (!input?.Pure) return null;
    return Uint8Array.from(bcs.vector(bcs.u8()).parse(fromBase64(input.Pure.bytes)));
  }

  function sharedId(data: TxData, argument: Argument | undefined): string | null {
    if (argument?.$kind !== "Input") return null;
    const object = data.inputs[argument.Input]?.Object?.SharedObject;
    return object ? normalizeSuiObjectId(object.objectId) : null;
  }

  type Checked = Readonly<{ ok: true; message: CctpMessage } | { ok: false; status: SuiClientTypes.ExecutionStatus }>;

  /** What the Move VM would do with these bytes: only the V1 receive path runs. */
  function check(data: TxData): Checked {
    const sender = normalizeSuiAddress(data.sender ?? "0x0");
    const moves = data.commands.map((command) => command.MoveCall);
    const at = (index: number, pkg: string, module: string, fn: string) => {
      const call = moves[index];
      return call && normalizeSuiAddress(call.package) === pkg && call.module === module && call.function === fn ? call : null;
    };
    const receive = at(0, mt, "receive_message", "receive_message");
    const handle = at(1, tmm, "handle_receive_message", "handle_receive_message");
    const split = at(2, tmm, "handle_receive_message", "deconstruct_stamp_receipt_ticket_with_burn_message");
    const stamp = at(3, mt, "receive_message", "stamp_receipt");
    const complete = at(4, mt, "receive_message", "complete_receive_message");
    if (data.commands.length !== 5 || !receive || !handle || !split || !stamp || !complete) {
      return { ok: false, status: abort("fixture", 0, "The fixture node runs only the CCTP V1 receive path.") };
    }
    const messageBytes = pure(data, receive.arguments[0]);
    const attestationBytes = pure(data, receive.arguments[1]);
    if (!messageBytes || !attestationBytes || sharedId(data, receive.arguments[2]) !== normalizeSuiObjectId(cctp.mtState.objectId)) {
      return { ok: false, status: abort("receive_message", 0, "bad arguments") };
    }
    const messageHex = `0x${toHex(messageBytes)}`;
    let message: CctpMessage;
    try {
      message = decodeCctpMessage(messageHex);
    } catch {
      return { ok: false, status: abort("message", 0, "malformed message") };
    }
    if (`0x${toHex(attestationBytes)}` !== fixtureAttestation(messageHex)) return { ok: false, status: abort("attestation", 0, "invalid attestation") };
    if (message.destinationDomain !== SUI_CCTP_DOMAIN) return { ok: false, status: abort("receive_message", 2, "EInvalidDestinationDomain") };
    if (message.destinationCaller !== ZERO32 && message.destinationCaller !== sender) {
      return { ok: false, status: abort("receive_message", 1, "EInvalidDestinationCaller") };
    }
    if (message.version !== 0) return { ok: false, status: abort("receive_message", 3, "EInvalidMessageVersion") };
    const from = Object.entries(CCTP_SOURCE_DOMAINS).find(([, domain]) => domain === message.sourceDomain)?.[0] as BridgeSource | undefined;
    if (!from || message.sender !== SOURCE_TOKEN_MESSENGER[0][from]) {
      return { ok: false, status: abort("handle_receive_message", 1, "EInvalidRemoteTokenMessenger") };
    }
    if (used.has(usedNonceKeyV1(message.sourceDomain, BigInt(message.nonce)))) {
      return { ok: false, status: abort("receive_message", 4, "ENonceAlreadyUsed") };
    }
    if (normalizeStructTag(handle.typeArguments[0] ?? "") !== cctp.usdcType) return { ok: false, status: abort("handle_receive_message", 4, "EInvalidTokenType") };
    if (
      sharedId(data, handle.arguments[1]) !== normalizeSuiObjectId(cctp.tmmState.objectId)
      || sharedId(data, handle.arguments[2]) !== normalizeSuiObjectId(cctp.denyList.objectId)
      || sharedId(data, handle.arguments[3]) !== normalizeSuiObjectId(cctp.usdcTreasury.objectId)
    ) {
      return { ok: false, status: abort("handle_receive_message", 0, "bad objects") };
    }
    const source = Object.entries(CCTP_SOURCE_DOMAINS).find(([, domain]) => domain === message.sourceDomain)?.[0] as BridgeSource | undefined;
    if (!source || !message.body || message.body.burnToken !== SOURCE_USDC_BURN_TOKEN[source]) {
      return { ok: false, status: abort("handle_receive_message", 3, "EUnknownBurnToken") };
    }
    if (message.body.amount > (1n << 64n) - 1n) return { ok: false, status: abort("handle_receive_message", 7, "EAmountOverflow") };
    return { ok: true, message };
  }

  /** As on Sui: no gas coin, so the address balance pays, for bytes valid during the current epoch on this chain. */
  function spendGas(sender: string, data: TxData) {
    if (data.gasData.payment?.length) throw new Error("The fixture node holds no gas coin.");
    const validDuring = data.expiration?.$kind === "ValidDuring" ? data.expiration.ValidDuring : null;
    if (!validDuring || validDuring.chain !== state.chainIdentifier || Number(validDuring.minEpoch) > epoch || Number(validDuring.maxEpoch) < epoch) {
      throw new Error("The transaction expired.");
    }
    const available = addressBalances.get(sender) ?? 0n;
    if (available < FIXTURE_CCTP_GAS_COST) throw new Error("The address balance cannot pay for this transaction.");
    addressBalances.set(sender, available - FIXTURE_CCTP_GAS_COST);
  }

  function visible(digest: string): Landed | undefined {
    return hidden.has(digest) ? undefined : landed.get(digest);
  }

  const core = {
    async getChainIdentifier() {
      return { chainIdentifier: state.chainIdentifier };
    },
    async getObjects({ objectIds, include }: Readonly<{ objectIds: readonly string[]; include?: { content?: boolean; previousTransaction?: boolean } }>) {
      return {
        objects: objectIds.map((raw) => {
          const id = normalizeSuiObjectId(raw);
          const object = shared.get(id);
          if (object) {
            return {
              objectId: id,
              version: "40",
              digest: "11111111111111111111111111111111",
              owner: { $kind: "Shared", Shared: { initialSharedVersion: object.initialSharedVersion } },
              type: object.type,
              ...(include?.content ? { content: object.content ?? new Uint8Array() } : {}),
            };
          }
          const field = [...used.keys()].find((key) => deriveDynamicFieldID(usedNonceTable, "address", fromHex(key.slice(2))) === id);
          if (field) {
            const creator = used.get(field)!;
            return {
              objectId: id,
              version: "41",
              digest: "11111111111111111111111111111111",
              owner: { $kind: "ObjectOwner", ObjectOwner: usedNonceTable },
              type: "0x2::dynamic_field::Field<address, bool>",
              ...(include?.content ? { content: new Uint8Array([...fromHex(id.slice(2)), ...fromHex(field.slice(2)), 1]) } : {}),
              ...(include?.previousTransaction ? { previousTransaction: fields.previousTransaction ? creator : null } : {}),
            };
          }
          return new ObjectError("NOT_FOUND", `Object ${id} does not exist.`, { reason: "notFound", objectId: id });
        }),
      };
    },
    async getBalance({ owner }: Readonly<{ owner: string }>) {
      const balance = String(addressBalances.get(normalizeSuiAddress(owner)) ?? 0n);
      return { balance: { coinType: SUI, balance, coinBalance: "0", addressBalance: balance } };
    },
    async getCurrentSystemState() {
      return { systemState: { epoch: String(epoch), referenceGasPrice: GAS_PRICE } };
    },
    async simulateTransaction({ transaction }: Readonly<{ transaction: Uint8Array }>) {
      calls.simulate += 1;
      const digest = TransactionDataBuilder.getDigestFromBytes(transaction);
      const checked = check(Transaction.from(transaction).getData());
      const status = checked.ok ? ({ success: true, error: null } as const) : checked.status;
      return { ...answer(digest, { effects: effects(digest, status), events: [], checkpoint: "0" }), commandResults: undefined };
    },
    async executeTransaction({ transaction, signatures }: Readonly<{ transaction: Uint8Array; signatures: string[] }>) {
      const digest = TransactionDataBuilder.getDigestFromBytes(transaction);
      if (state.execution === "dropped") throw new Error("The fixture node closed the connection before answering.");
      const found = landed.get(digest);
      if (found) {
        if (hidden.has(digest)) throw new Error("The fixture node is not answering.");
        return answer(digest, found);
      }
      const data = Transaction.from(transaction).getData();
      const sender = normalizeSuiAddress(data.sender ?? "0x0");
      const signer = await verifyTransactionSignature(transaction, signatures[0] ?? "", { offline: true });
      if (signer.toSuiAddress() !== sender) throw new Error("The signature is not the sender's.");
      spendGas(sender, data);
      calls.execute += 1;
      const checked = check(data);
      let outcome: Landed;
      if (checked.ok && state.execution !== "abort") {
        const at = markUsed(checked.message, sender, digest);
        calls.mints.push({
          digest,
          recipient: checked.message.body!.mintRecipient,
          amount: checked.message.body!.amount,
          nonce: checked.message.nonce,
          sourceDomain: checked.message.sourceDomain,
          caller: sender,
        });
        outcome = { effects: effects(digest, { success: true, error: null }), events: [events.at(-1)!], checkpoint: String(at) };
      } else {
        outcome = { effects: effects(digest, checked.ok ? abort("fixture", 9, "aborted on request") : checked.status), events: [], checkpoint: String(checkpoint) };
      }
      landed.set(digest, outcome);
      if (state.execution === "hidden") {
        hidden.add(digest);
        throw new Error("The fixture node is not answering.");
      }
      if (state.execution === "lost-response") throw new Error("The fixture node lost the answer.");
      return answer(digest, outcome);
    },
    async getTransaction({ digest }: Readonly<{ digest: string }>) {
      const found = visible(digest);
      if (!found) throw new TransactionError("notFound", digest);
      return answer(digest, found);
    },
    async waitForTransaction({ digest, timeout = 0 }: Readonly<{ digest: string; timeout?: number }>) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const found = visible(digest);
        if (found) return answer(digest, found);
        if (Date.now() >= deadline) throw new TransactionError("notFound", digest);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    async listEvents({ filter, limit = 50, before, order }: Readonly<{ filter?: { eventType?: string }; limit?: number; before?: string | null; order?: string }>) {
      calls.listEvents += 1;
      const matching = events.filter((event) => !filter?.eventType || event.eventType === filter.eventType);
      const newestFirst = order === "descending" || before ? [...matching].reverse() : matching;
      const start = before ? newestFirst.findIndex((event) => `${event.checkpoint}:${event.transactionDigest}` === before) + 1 : 0;
      const page = newestFirst.slice(start, start + limit);
      const last = page.at(-1);
      return {
        events: page,
        hasNextPage: start + limit < newestFirst.length,
        startCursor: page[0] ? `${page[0].checkpoint}:${page[0].transactionDigest}` : null,
        endCursor: last ? `${last.checkpoint}:${last.transactionDigest}` : null,
      };
    },
  };

  return {
    client: { core } as unknown as ClientWithCoreApi,
    behavior: state,
    calls,
    fields,
    usedNonceTable,
    /** Sets `owner`'s SUI address balance, which pays its gas. */
    fundAddressBalance(owner: string, mist: bigint) {
      addressBalances.set(normalizeSuiAddress(owner), mist);
    },
    /** The next epoch: `ValidDuring` expirations that end before it lapse. */
    resetEpoch() {
      epoch += 1;
    },
    /** Someone else (Circle's forwarder, the user, another relayer) receives `message` first; returns the mint digest. */
    receiveExternally(messageHex: string, caller = `0x${"e7".repeat(32)}`): string {
      const message = decodeCctpMessage(messageHex);
      const digest = digest32();
      const at = markUsed(message, normalizeSuiAddress(caller), digest);
      calls.mints.push({ digest, recipient: message.body!.mintRecipient, amount: message.body!.amount, nonce: message.nonce, sourceDomain: message.sourceDomain, caller });
      landed.set(digest, { effects: effects(digest, { success: true, error: null }), events: [events.at(-1)!], checkpoint: String(at) });
      return digest;
    },
    /** Unrelated `MessageReceived` events, newer than any mint so far (a busy mainnet). */
    noise(count: number) {
      for (let index = 0; index < count; index += 1) {
        const message = decodeCctpMessage(cctpMessageFixture({ nonce: 900_000n + BigInt(events.length) }));
        const digest = digest32();
        markUsed(message, `0x${"9a".repeat(32)}`, digest);
        landed.set(digest, { effects: effects(digest, { success: true, error: null }), events: [events.at(-1)!], checkpoint: String(checkpoint) });
      }
    },
    /** Hidden transactions become visible: the node answers again. */
    reveal() {
      hidden.clear();
    },
  };
}

export type CctpFixtureNode = ReturnType<typeof createCctpFixtureNode>;
