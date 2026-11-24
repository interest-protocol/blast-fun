import { SUI_COIN_TYPE as SUI } from "@blast/core/lib/sui/coin-types.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

import { sharedObjectEntries, type BlastDeployment, type BlastDeploymentInput } from "@interest-protocol/blast-deployments-sdk";
import { COIN_REGISTRY_ID } from "@interest-protocol/blast-core/effects";
import { packageVersionBcs } from "@interest-protocol/blast-admin-sdk/state";
import { runtimeFor } from "../../final-stack/venue-deployment.ts";
import { ObjectError, TransactionError, type ClientWithCoreApi, type SuiClientTypes } from "@mysten/sui/client";
import { Inputs, Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import {
  deriveObjectID,
  fromBase64,
  normalizeStructTag,
  normalizeSuiAddress,
  normalizeSuiObjectId,
  toBase58,
  toBase64,
} from "@mysten/sui/utils";
import { verifyTransactionSignature } from "@mysten/sui/verify";

const GAS_PRICE = "1000";
/** What one fixture transaction charges, in MIST. */
export const FIXTURE_GAS_COST = 2_000_000n;

export type FixtureNodeBehavior = {
  chainIdentifier: string;
  /** `unavailable`: every read and submission throws, as an unreachable node. */
  reads: "available" | "unavailable";
  /** `abort`: every simulation fails, as a transaction the chain would reject. */
  simulation: "success" | "abort";
  /**
   * `lost-response`: the node executes the transaction and the answer is lost;
   * `dropped`: it never reaches the node; `abort`: it executes and aborts.
   */
  execution: "complete" | "lost-response" | "dropped" | "abort";
  /** How long the node holds a submission before executing it. */
  executeDelayMs: number;
  /** Meme types whose `finalize_registration` aborts, in simulation and on chain, the error naming its command. */
  refuseRegistrations: string[];
  /** Meme types someone else registers just before the node executes our transaction (a race after simulation). */
  registerBeforeExecution: string[];
};

type ObjectRef = { objectId: string; version: string; digest: string };
type Landed = {
  effects: SuiClientTypes.TransactionEffects;
  objectTypes: Record<string, string>;
  sender: string;
  events?: SuiClientTypes.Event[];
};

export type FixturePublication = Readonly<{
  digest: string;
  packageId: string;
  memeType: string;
  ticketId: string;
  pendingCurrency: ObjectRef;
}>;

export type FixtureNodeCalls = {
  simulate: number;
  execute: number;
  registrations: Record<string, number>;
  /** How many Meme types each executed registration transaction shared, in order. */
  registrationBatches: number[];
  /** The most submissions for one Meme type the node held at the same time. */
  concurrentSubmissions: Record<string, number>;
  /** Every distinct digest a validator received, in order (before any execution delay). */
  received: string[];
};

export type FixtureNode = Readonly<{
  client: ClientWithCoreApi;
  behavior: FixtureNodeBehavior;
  calls: FixtureNodeCalls;
  /** Publishes a generated Meme package whose ticket belongs to `launchpad`, its cap sealed under `core`. */
  publish(options: Readonly<{ launchpad: string; core: string; creator?: string; symbol?: string }>): FixturePublication;
  /** Someone else's `finalize_registration` for `memeType`. */
  registerExternally(memeType: string): void;
  /** Sets `owner`'s SUI address balance, which pays gas for `ValidDuring` bytes with no gas coin. */
  fundAddressBalance(owner: string, mist: bigint): void;
  /** The shared `Currency<Meme>`, or null. */
  sharedCurrency(memeType: string): string | null;
  /** The pending `Currency<Meme>` the Coin Registry still owns, or null. */
  pendingCurrency(memeType: string): ObjectRef | null;
  /** The next epoch: `ValidDuring` expirations that end before it lapse. */
  resetEpoch(): void;
}>;

function randomDigest(): string {
  return toBase58(randomBytes(32));
}

function randomId(): string {
  return normalizeSuiObjectId(`0x${randomBytes(32).toString("hex")}`);
}

function currencyType(memeType: string): string {
  return `0x2::coin_registry::Currency<${normalizeStructTag(memeType)}>`;
}

/** `deriveObjectID(0xc, CurrencyKey<Meme>)`, where `finalize_registration` shares the currency. */
export function derivedCurrencyId(memeType: string): string {
  return deriveObjectID(
    COIN_REGISTRY_ID,
    `0x2::coin_registry::CurrencyKey<${normalizeStructTag(memeType)}>`,
    new Uint8Array([0]),
  );
}

function effects(
  digest: string,
  status: SuiClientTypes.ExecutionStatus,
  changedObjects: SuiClientTypes.ChangedObject[],
): SuiClientTypes.TransactionEffects {
  return {
    bcs: null,
    version: 2,
    status,
    gasUsed: { computationCost: String(FIXTURE_GAS_COST), storageCost: "0", storageRebate: "0", nonRefundableStorageFee: "0" },
    transactionDigest: digest,
    gasObject: null,
    eventsDigest: null,
    dependencies: [],
    lamportVersion: null,
    changedObjects,
    unchangedConsensusObjects: [],
    auxiliaryDataDigest: null,
  };
}

function created(
  objectId: string,
  owner: SuiClientTypes.ObjectOwner | null,
  outputState: SuiClientTypes.ChangedObject["outputState"] = "ObjectWrite",
): SuiClientTypes.ChangedObject {
  return {
    objectId,
    inputState: "DoesNotExist",
    inputVersion: null,
    inputDigest: null,
    inputOwner: null,
    outputState,
    outputVersion: "1",
    outputDigest: randomDigest(),
    outputOwner: owner,
    idOperation: "Created",
  };
}

/** A Move abort, in the command `command` when given (as the node names the failing command). */
function abort(message: string, command?: number): SuiClientTypes.ExecutionStatus {
  return {
    success: false,
    error: { $kind: "MoveAbort", message, MoveAbort: { abortCode: "0" }, ...(command === undefined ? {} : { command }) } as SuiClientTypes.ExecutionError,
  };
}

function result(digest: string, landed: Landed, checkpoint: string | null) {
  const transaction = {
    digest,
    signatures: [],
    epoch: "1",
    timestampMs: checkpoint === null ? null : 1_790_000_000_000,
    checkpoint,
    status: landed.effects.status,
    balanceChanges: undefined,
    effects: landed.effects,
    events: landed.events ?? [],
    objectTypes: landed.objectTypes,
    transaction: undefined,
    bcs: undefined,
  };
  return landed.effects.status.success
    ? { $kind: "Transaction" as const, Transaction: transaction }
    : { $kind: "FailedTransaction" as const, FailedTransaction: transaction };
}


/**
 * Resolves what the worker leaves to the node: the Coin Registry's shared
 * input and the gas price. The worker sets the budget and the gas payment.
 */
function fixtureResolver(core: () => ClientWithCoreApi["core"]) {
  return async (data: TransactionDataBuilder, _options: unknown, next: () => Promise<void>) => {
    for (const [index, input] of data.inputs.entries()) {
      if (input.$kind !== "UnresolvedObject") continue;
      const { objects } = await core().getObjects({ objectIds: [input.UnresolvedObject.objectId] });
      const object = objects[0];
      if (!object || object instanceof Error || object.owner.$kind !== "Shared") {
        throw new Error(`fixture node cannot resolve ${input.UnresolvedObject.objectId}`);
      }
      data.inputs[index] = Inputs.SharedObjectRef({
        objectId: object.objectId,
        initialSharedVersion: object.owner.Shared.initialSharedVersion,
        mutable: true,
      });
    }
    data.gasData.price ??= GAS_PRICE;
    await next();
  };
}

const DEFAULT_BEHAVIOR: Omit<FixtureNodeBehavior, "chainIdentifier"> = {
  reads: "available",
  simulation: "success",
  execution: "complete",
  executeDelayMs: 0,
  refuseRegistrations: [],
  registerBeforeExecution: [],
};

/** One in-memory node for `manifest`'s chain and shared objects. */
export function createFixtureNode(manifest: BlastDeploymentInput, behavior: Partial<FixtureNodeBehavior> = {}): FixtureNode {
  const state: FixtureNodeBehavior = { chainIdentifier: manifest.chainIdentifier, ...DEFAULT_BEHAVIOR, ...behavior };
  const calls: FixtureNodeCalls = {
    simulate: 0,
    execute: 0,
    registrations: {},
    registrationBatches: [],
    concurrentSubmissions: {},
    received: [],
  };
  let epoch = 1;
  const inFlight = new Map<string, number>();
  const runtime = runtimeFor(manifest);
  const shared = new Map<string, { type: string; initialSharedVersion: string; content?: Uint8Array }>(
    sharedObjectEntries(manifest.sharedObjects as BlastDeployment["sharedObjects"]).map(([path, identity]) => [
      normalizeSuiObjectId(identity.objectId),
      { type: runtime.sharedObjects[path]!.type, initialSharedVersion: String(identity.initialSharedVersion), ...(path.endsWith(".packageVersion") ? { content: packageVersionBcs.serialize({ id: { id: { bytes: identity.objectId } }, valid_pause_bits: 7, paused: 0, package_witness: "0x1::dummy::DUMMY", version: 1n }).toBytes() } : {}) },
    ]),
  );
  shared.set(COIN_REGISTRY_ID, { type: "0x2::coin_registry::CoinRegistry", initialSharedVersion: "1" });
  /** Pending currencies by object ID. */
  const pending = new Map<string, ObjectRef & { memeType: string; previousTransaction: string }>();
  /** Shared currencies by Meme type. */
  const currencies = new Map<string, string>();
  const addressBalances = new Map<string, bigint>();
  const landed = new Map<string, Landed>();
  function requireReads() {
    if (state.reads === "unavailable") throw new Error("The fixture node is not answering.");
  }

  /** `finalize_registration`: the pending currency leaves 0xc and the shared one appears. */
  function share(memeType: string): SuiClientTypes.ChangedObject[] {
    const meme = normalizeStructTag(memeType);
    const id = derivedCurrencyId(meme);
    const entry = [...pending.values()].find((currency) => currency.memeType === meme);
    if (entry) pending.delete(entry.objectId);
    currencies.set(meme, id);
    calls.registrations[meme] = (calls.registrations[meme] ?? 0) + 1;
    const changed = [created(id, { $kind: "Shared", Shared: { initialSharedVersion: "7" } } as SuiClientTypes.ObjectOwner)];
    if (entry) {
      changed.push({
        objectId: entry.objectId,
        inputState: "Exists",
        inputVersion: entry.version,
        inputDigest: entry.digest,
        inputOwner: { $kind: "AddressOwner", AddressOwner: COIN_REGISTRY_ID } as SuiClientTypes.ObjectOwner,
        outputState: "DoesNotExist",
        outputVersion: null,
        outputDigest: null,
        outputOwner: null,
        idOperation: "Deleted",
      });
    }
    return changed;
  }

  /** Someone else's `finalize_registration` of `memeType` lands. */
  function registerExternally(memeType: string) {
    const meme = normalizeStructTag(memeType);
    if (currencies.has(meme)) return;
    const digest = randomDigest();
    const changed = share(meme);
    landed.set(digest, {
      effects: effects(digest, { success: true, error: null }, changed),
      objectTypes: Object.fromEntries(changed.map((object) => [object.objectId, currencyType(meme)])),
      sender: `0x${"e7".repeat(32)}`,
    });
  }

  type Checked =
    | { ok: true; memeTypes: string[]; sender: string }
    | { ok: false; status: SuiClientTypes.ExecutionStatus; sender: string };

  /** What this node's Move VM would do with these bytes. */
  function check(bytes: Uint8Array): Checked {
    const data = Transaction.from(bytes).getData();
    const sender = normalizeSuiAddress(data.sender ?? "0x0");
    const moveCalls = data.commands.map((command) => command.MoveCall);
    if (
      moveCalls.length === 0 ||
      moveCalls.some((call) =>
        !call ||
        normalizeSuiAddress(call.package) !== normalizeSuiAddress("0x2") ||
        call.module !== "coin_registry" ||
        call.function !== "finalize_registration")
    ) {
      return { ok: false, status: abort("The fixture node runs only finalize_registration."), sender };
    }
    // Every finalize_registration, in order: the first that aborts fails the transaction, naming its command.
    const memeTypes: string[] = [];
    for (const [command, call] of moveCalls.entries()) {
      const memeType = normalizeStructTag(call!.typeArguments[0] ?? "");
      const argument = call!.arguments[1];
      const receiving = argument?.$kind === "Input" ? data.inputs[argument.Input]?.Object?.Receiving : undefined;
      const current = receiving ? pending.get(normalizeSuiObjectId(receiving.objectId)) : undefined;
      if (
        !current ||
        current.memeType !== memeType ||
        String(receiving?.version) !== current.version ||
        receiving?.digest !== current.digest
      ) {
        return { ok: false, status: abort("The Coin Registry has no such pending currency (already registered?).", command), sender };
      }
      if (state.refuseRegistrations.includes(memeType)) {
        return { ok: false, status: abort("finalize_registration aborted: the fixture node refuses this Meme.", command), sender };
      }
      memeTypes.push(memeType);
    }
    // A transaction the node rejects as a whole names no command.
    if (state.simulation === "abort") {
      return { ok: false, status: abort("The fixture node rejects this registration."), sender };
    }
    return { ok: true, memeTypes, sender };
  }

  /** The address balance pays: there is no gas coin. */
  function spendGas(sender: string) {
    const available = addressBalances.get(sender) ?? 0n;
    if (available < FIXTURE_GAS_COST) throw new Error("The address balance cannot pay for this transaction.");
    addressBalances.set(sender, available - FIXTURE_GAS_COST);
  }

  function executeChecked(checked: Checked, digest: string): Landed {
    if (!checked.ok || state.execution === "abort") {
      return {
        effects: effects(digest, checked.ok ? abort("The fixture node aborted this registration.") : checked.status, []),
        objectTypes: {},
        sender: checked.sender,
      };
    }
    const changed: SuiClientTypes.ChangedObject[] = [];
    const objectTypes: Record<string, string> = {};
    for (const memeType of checked.memeTypes) {
      const shared = share(memeType);
      changed.push(...shared);
      for (const object of shared) objectTypes[object.objectId] = currencyType(memeType);
    }
    calls.registrationBatches.push(checked.memeTypes.length);
    return { effects: effects(digest, { success: true, error: null }, changed), objectTypes, sender: checked.sender };
  }

  const core = {
    async getChainIdentifier() {
      requireReads();
      return { chainIdentifier: state.chainIdentifier };
    },
    async getObjects({ objectIds, include }: Readonly<{ objectIds: readonly string[]; include?: { previousTransaction?: boolean; content?: boolean } }>) {
      requireReads();
      return {
        objects: objectIds.map((raw) => {
          const id = normalizeSuiObjectId(raw);
          const previous = include?.previousTransaction ? { previousTransaction: null } : {};
          const sharedObject = shared.get(id);
          if (sharedObject) {
            return {
              objectId: id,
              version: "9",
              digest: "11111111111111111111111111111111",
              owner: { $kind: "Shared", Shared: { initialSharedVersion: sharedObject.initialSharedVersion } },
              type: sharedObject.type,
              content: sharedObject.content,
              ...previous,
            };
          }
          const memeType = [...currencies].find(([, currency]) => currency === id)?.[0];
          if (memeType) {
            return {
              objectId: id,
              version: "7",
              digest: "11111111111111111111111111111111",
              owner: { $kind: "Shared", Shared: { initialSharedVersion: "7" } },
              type: currencyType(memeType),
              ...previous,
            };
          }
          const pendingCurrency = pending.get(id);
          if (pendingCurrency) {
            return {
              objectId: id,
              version: pendingCurrency.version,
              digest: pendingCurrency.digest,
              owner: { $kind: "AddressOwner", AddressOwner: COIN_REGISTRY_ID },
              type: currencyType(pendingCurrency.memeType),
              ...(include?.previousTransaction ? { previousTransaction: pendingCurrency.previousTransaction } : {}),
            };
          }
          return new ObjectError("NOT_FOUND", `Object ${id} does not exist.`, { reason: "notFound", objectId: id });
        }),
      };
    },
    async getObject({ objectId }: Readonly<{ objectId: string }>) {
      const [object] = (await core.getObjects({ objectIds: [objectId] })).objects;
      if (!object || object instanceof Error) throw object ?? new Error(`Object ${objectId} does not exist.`);
      return { object };
    },
    async getDynamicField({ parentId }: Readonly<{ parentId: string; name: { type: string; bcs: Uint8Array } }>) {
      throw new ObjectError("NOT_FOUND", `No such field of ${parentId}.`, { reason: "notFound", objectId: parentId });
    },
    async listOwnedObjects({ owner, type, include }: Readonly<{ owner: string; type?: string; include?: { previousTransaction?: boolean } }>) {
      requireReads();
      const objects = normalizeSuiAddress(owner) !== COIN_REGISTRY_ID
        ? []
        : [...pending.values()]
          .filter((currency) => !type || normalizeStructTag(type) === normalizeStructTag(currencyType(currency.memeType)))
          .map((currency) => ({
            objectId: currency.objectId,
            version: currency.version,
            digest: currency.digest,
            owner: { $kind: "AddressOwner", AddressOwner: COIN_REGISTRY_ID },
            type: currencyType(currency.memeType),
            ...(include?.previousTransaction ? { previousTransaction: currency.previousTransaction } : {}),
          }));
      return { objects, hasNextPage: false, cursor: null };
    },
    async getBalance({ owner }: Readonly<{ owner: string }>) {
      requireReads();
      const address = addressBalances.get(normalizeSuiAddress(owner)) ?? 0n;
      return { balance: { coinType: SUI, balance: String(address), coinBalance: "0", addressBalance: String(address) } };
    },
    async getCurrentSystemState() {
      requireReads();
      return { systemState: { epoch: String(epoch), referenceGasPrice: GAS_PRICE } };
    },
    resolveTransactionPlugin() {
      return fixtureResolver(() => core as unknown as ClientWithCoreApi["core"]);
    },
    async simulateTransaction({ transaction }: Readonly<{ transaction: Uint8Array }>) {
      requireReads();
      calls.simulate += 1;
      const digest = TransactionDataBuilder.getDigestFromBytes(transaction);
      const checked = check(transaction);
      const status = checked.ok ? ({ success: true, error: null } as const) : checked.status;
      return { ...result(digest, { effects: effects(digest, status, []), objectTypes: {}, sender: checked.sender }, null), commandResults: undefined };
    },
    async executeTransaction({ transaction, signatures }: Readonly<{ transaction: Uint8Array; signatures: string[] }>) {
      requireReads();
      const data = Transaction.from(transaction).getData();
      const call = data.commands.at(-1)?.MoveCall;
      const key = call?.typeArguments[0] ? normalizeStructTag(call.typeArguments[0]) : "";
      const digest = TransactionDataBuilder.getDigestFromBytes(transaction);
      const delay = () => state.executeDelayMs > 0 ? new Promise((resolve) => setTimeout(resolve, state.executeDelayMs)) : undefined;
      if (state.execution === "dropped") {
        // Lost before any validator saw it: no lock.
        await delay();
        throw new Error("The fixture node closed the connection before answering.");
      }
      // As on Sui: bytes with no gas coin pay from the address balance and need a
      // `ValidDuring` expiration on this chain whose epochs include the current one.
      // This node holds no gas coin: bytes paid with one are refused.
      if (data.gasData.payment?.length) throw new Error("The fixture node holds no gas coin.");
      const validDuring = data.expiration?.$kind === "ValidDuring" ? data.expiration.ValidDuring : null;
      if (!validDuring) throw new Error("Bytes without a gas coin need a ValidDuring expiration.");
      if (validDuring.chain !== state.chainIdentifier || epoch < Number(validDuring.minEpoch) || epoch > Number(validDuring.maxEpoch)) {
        throw new Error("The transaction expired.");
      }
      if (!calls.received.includes(digest)) calls.received.push(digest);
      inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
      calls.concurrentSubmissions[key] = Math.max(calls.concurrentSubmissions[key] ?? 0, inFlight.get(key)!);
      try {
        await delay();
      } finally {
        inFlight.set(key, inFlight.get(key)! - 1);
      }
      calls.execute += 1;
      const signer = await verifyTransactionSignature(transaction, signatures[0] ?? "", { offline: true });
      const found = landed.get(digest);
      if (found) return result(digest, found, null);
      for (const memeType of state.registerBeforeExecution.splice(0)) registerExternally(memeType);
      const checked = check(transaction);
      if (signer.toSuiAddress() !== checked.sender) throw new Error("The signature is not the sender's.");
      spendGas(checked.sender);
      const outcome = executeChecked(checked, digest);
      landed.set(digest, outcome);
      if (state.execution === "lost-response") throw new Error("The fixture node lost the answer.");
      return result(digest, outcome, null);
    },
    async getTransaction({ digest }: Readonly<{ digest: string }>) {
      requireReads();
      const found = landed.get(digest);
      // The SDK's typed answer for a digest the node never ran.
      if (!found) throw new TransactionError("notFound", digest);
      return result(digest, found, "41");
    },
    async waitForTransaction({ digest, timeout = 0 }: Readonly<{ digest: string; timeout?: number }>) {
      const deadline = Date.now() + timeout;
      for (; ;) {
        try {
          return await core.getTransaction({ digest });
        } catch (error) {
          if (Date.now() >= deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
    },
  };

  return {
    client: { core } as unknown as ClientWithCoreApi,
    behavior: state,
    calls,
    publish({ launchpad, core, creator = `0x${"c4".repeat(32)}`, symbol = "MEME" }) {
      const digest = randomDigest();
      const packageId = randomId();
      const memeType = normalizeStructTag(`${packageId}::${symbol.toLowerCase()}::${symbol.toUpperCase()}`);
      const ticketId = randomId();
      const currencyId = randomId();
      const sealedCapId = randomId();
      const ticketType = `${normalizeSuiAddress(launchpad)}::launch_ticket::LaunchTicket<${memeType}>`;
      const sealedCapType = `${normalizeSuiAddress(core)}::sealed_treasury_cap::SealedTreasuryCap<${memeType}>`;
      const changed = [
        created(packageId, { $kind: "Immutable", Immutable: true } as SuiClientTypes.ObjectOwner, "PackageWrite"),
        created(ticketId, { $kind: "AddressOwner", AddressOwner: normalizeSuiAddress(creator) } as SuiClientTypes.ObjectOwner),
        created(currencyId, { $kind: "AddressOwner", AddressOwner: COIN_REGISTRY_ID } as SuiClientTypes.ObjectOwner),
        created(sealedCapId, { $kind: "AddressOwner", AddressOwner: normalizeSuiAddress(creator) } as SuiClientTypes.ObjectOwner),
      ];
      const currency = changed[2]!;
      landed.set(digest, {
        effects: effects(digest, { success: true, error: null }, changed),
        objectTypes: { [ticketId]: ticketType, [currencyId]: currencyType(memeType), [sealedCapId]: sealedCapType },
        sender: normalizeSuiAddress(creator),
      });
      const pendingCurrency = { objectId: currencyId, version: currency.outputVersion!, digest: currency.outputDigest! };
      pending.set(currencyId, { ...pendingCurrency, memeType, previousTransaction: digest });
      return { digest, packageId, memeType, ticketId, pendingCurrency };
    },
    registerExternally,
    fundAddressBalance(owner, mist) {
      addressBalances.set(normalizeSuiAddress(owner), mist);
    },
    sharedCurrency(memeType) {
      return currencies.get(normalizeStructTag(memeType)) ?? null;
    },
    pendingCurrency(memeType) {
      const meme = normalizeStructTag(memeType);
      const entry = [...pending.values()].find((currency) => currency.memeType === meme);
      return entry ? { objectId: entry.objectId, version: entry.version, digest: entry.digest } : null;
    },
    resetEpoch() {
      epoch += 1;
    },
  };
}

type Wire = Record<string, unknown>;

/** Bytes (object contents, BCS values) cross the loopback wire as `{ $bytes: base64 }`. */
function encodeBytes(_key: string, value: unknown): unknown {
  return value instanceof Uint8Array ? { $bytes: toBase64(value) } : value;
}

function decodeBytes(_key: string, value: unknown): unknown {
  return typeof value === "object" && value !== null && typeof (value as { $bytes?: unknown }).$bytes === "string"
    ? fromBase64((value as { $bytes: string }).$bytes)
    : value;
}

function readBody(request: IncomingMessage): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}", decodeBytes) as Wire);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body, encodeBytes));
}

const CORE_METHODS = new Set([
  "getChainIdentifier",
  "getObjects",
  "getObject",
  "getDynamicField",
  "listDynamicFields",
  "listOwnedObjects",
  "getBalance",
  "simulateTransaction",
  "executeTransaction",
  "getTransaction",
  "getCurrentSystemState",
]);

/**
 * Serves `node` on loopback: `POST /core` runs one Core API method
 * (`{ method, params }`, transaction bytes in base64), and `POST /control`
 * changes its behaviour, publishes, funds, or registers externally.
 */
export async function startFixtureNodeServer(
  node: FixtureNode,
  port = 0,
): Promise<Readonly<{ origin: string; close(): Promise<void> }>> {
  const core = node.client.core as unknown as Record<string, (params: Wire) => Promise<unknown>>;
  async function coreRequest(body: Wire, response: ServerResponse): Promise<void> {
    const method = String(body.method);
    if (!CORE_METHODS.has(method)) return send(response, 404, { error: "unknown method" });
    const params = { ...(body.params as Wire) };
    if (typeof params.transaction === "string") params.transaction = fromBase64(params.transaction);
    try {
      const answer = (await core[method]!(params)) as Wire;
      if (method === "getObjects") {
        answer.objects = (answer.objects as unknown[]).map((object) =>
          object instanceof ObjectError
            ? { $error: object.message, code: object.code, reason: object.reason }
            : object instanceof Error
              ? { $error: object.message }
              : object,
        );
      }
      return send(response, 200, answer);
    } catch (error) {
      return send(response, 502, { error: error instanceof Error ? error.message : "failed" });
    }
  }
  const server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request);
      if (request.method === "POST" && request.url === "/core") {
        return coreRequest(body, response);
      }
      if (request.method === "POST" && request.url === "/control") {
        switch (body.action) {
          case "behavior":
            Object.assign(node.behavior, body.behavior);
            return send(response, 200, node.behavior);
          case "publish":
            return send(response, 200, node.publish(body as { launchpad: string; core: string }));
          case "register":
            node.registerExternally(String(body.memeType));
            return send(response, 200, {});
          case "epoch":
            node.resetEpoch();
            return send(response, 200, {});
          case "fund":
            node.fundAddressBalance(String(body.owner), BigInt(String(body.mist)));
            return send(response, 200, {});
          case "state": {
            const memeType = String(body.memeType);
            return send(response, 200, {
              shared: node.sharedCurrency(memeType),
              pending: node.pendingCurrency(memeType),
              registrations: node.calls.registrations[normalizeStructTag(memeType)] ?? 0,
              calls: node.calls,
            });
          }
        }
      }
      send(response, 404, { error: "not found" });
    })().catch(() => send(response, 400, { error: "bad request" }));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture node has no address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A Core API client for a fixture node served at `origin` (loopback only). */
export function fixtureNodeClient(origin: string, fetcher: typeof fetch = fetch): ClientWithCoreApi {
  const url = new URL("/core", origin);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("The fixture node must be on loopback.");
  }
  async function call(method: string, params: Wire = {}): Promise<Wire> {
    const { signal, ...rest } = params as Wire & { signal?: AbortSignal };
    if (rest.transaction instanceof Uint8Array) rest.transaction = toBase64(rest.transaction);
    const response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, params: rest }, encodeBytes),
      signal,
    });
    const body = JSON.parse(await response.text(), decodeBytes) as Wire;
    if (!response.ok) throw new Error(String(body.error ?? `fixture node answered ${response.status}`));
    return body;
  }
  const core = {
    getChainIdentifier: (params?: Wire) => call("getChainIdentifier", params),
    async getObjects(params: Wire) {
      const answer = await call("getObjects", params);
      return {
        objects: (answer.objects as Wire[]).map((object) =>
          !("$error" in object)
            ? object
            : object.reason
              ? new ObjectError(String(object.code), String(object.$error), { reason: object.reason as "notFound" | "deleted" | "unknown" })
              : new Error(String(object.$error)),
        ),
      };
    },
    async getObject(params: Wire) {
      try {
        return await call("getObject", params);
      } catch (error) {
        // The node's typed not-found, as the SDK's readers expect it.
        if (error instanceof Error && /does not exist/.test(error.message)) {
          throw new ObjectError("NOT_FOUND", error.message, { reason: "notFound", objectId: String(params.objectId) });
        }
        throw error;
      }
    },
    async getDynamicField(params: Wire) {
      try {
        return await call("getDynamicField", params);
      } catch (error) {
        if (error instanceof Error && /No such field/.test(error.message)) {
          throw new ObjectError("NOT_FOUND", error.message, { reason: "notFound", objectId: String(params.parentId) });
        }
        throw error;
      }
    },
    // A node that holds dynamic fields (the presale fixture node) lists them: claim delivery's enumeration.
    listDynamicFields: (params: Wire) => call("listDynamicFields", params),
    listOwnedObjects: (params: Wire) => call("listOwnedObjects", params),
    getBalance: (params: Wire) => call("getBalance", params),
    simulateTransaction: (params: Wire) => call("simulateTransaction", params),
    executeTransaction: (params: Wire) => call("executeTransaction", params),
    async getTransaction(params: Wire) {
      try {
        return await call("getTransaction", params);
      } catch (error) {
        // The node's typed not-found, as the SDK's clients raise it.
        if (error instanceof Error && /^Transaction \S+ not found/.test(error.message)) {
          throw new TransactionError("notFound", String(params.digest));
        }
        throw error;
      }
    },
    getCurrentSystemState: (params?: Wire) => call("getCurrentSystemState", params),
    async waitForTransaction(params: Wire & { timeout?: number }) {
      const deadline = Date.now() + (params.timeout ?? 0);
      for (; ;) {
        try {
          return await call("getTransaction", { digest: params.digest, include: params.include, signal: params.signal });
        } catch (error) {
          if (Date.now() >= deadline || (params.signal as AbortSignal | undefined)?.aborted) throw error;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    },
    resolveTransactionPlugin() {
      return fixtureResolver(() => core as unknown as ClientWithCoreApi["core"]);
    },
  };
  return { core } as unknown as ClientWithCoreApi;
}

/** Drives a served fixture node from a test. */
export async function controlFixtureNode(origin: string, body: Wire): Promise<Wire> {
  const response = await fetch(new URL("/control", origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`fixture control answered ${response.status}`);
  return (await response.json()) as Wire;
}
