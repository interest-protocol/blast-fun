// Fixtures for the shared transaction boundary: a non-production deployment, a
// mutable in-memory Sui node, fixture signers built through the real signer
// adapters, a fixture buy action, and one named state per action phase. They
// serve reducer, provider, and harness checks, never real value.

import { fixtureSharedContent, runtimeFor } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/deployment-runtime.ts";
import { sharedObjectEntries, type BlastDeploymentInput } from "@interest-protocol/blast-sdk/deployments";
import { launchpadEventBcs, previewBuy, type CurveState } from "@interest-protocol/blast-sdk/launchpad";
import { bcs } from "@mysten/sui/bcs";
import { SimulationError, type ClientWithCoreApi, type SuiClientTypes } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { fromBase64, fromHex, normalizeSuiAddress, parseToMist, toHex } from "@mysten/sui/utils";
import { verifyTransactionSignature } from "@mysten/sui/verify";

import { NON_PRODUCTION_MANIFEST } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/manifest-fixtures.ts";
import {
  initialActionState,
  reduceAction,
  type ActionEvent,
  type ActionPhase,
  type ActionState,
  type FreshReview,
} from "#web/components/launchpad/transaction/action-machine.ts";
import type { DirectWalletState, PrivyState } from "#web/components/launchpad/transaction/bridge-signers.ts";
import type { LaunchpadActionAdapter } from "#web/components/launchpad/transaction/preflight.ts";
import { privySigner, walletSigner, type LaunchpadSigner } from "#web/components/launchpad/transaction/signer.ts";
import { atomsGrouped } from "@blast/core/web/format.ts";

export { FOREIGN_CHAIN_IDENTIFIER, MAINNET_CHAIN_IDENTIFIER, NON_PRODUCTION_MANIFEST } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/manifest-fixtures.ts";

/** Blast deploys to Sui mainnet only, so the fixture names one network. */
export type FixtureNetwork = "mainnet";

/** The fixture manifest; Blast runs on mainnet only. */
export function fixtureManifest(): BlastDeploymentInput {
  return NON_PRODUCTION_MANIFEST;
}

const LAUNCHPAD = NON_PRODUCTION_MANIFEST.packages.launchpad.originalPackageId;
const FOREIGN_PACKAGE = normalizeSuiAddress(`0x${"f0".repeat(32)}`);
const MEME_TYPE = `${normalizeSuiAddress(`0x${"4d".repeat(32)}`)}::meme::MEME`;
const SUI = "0x2::sui::SUI";

export const FIXTURE_LAUNCH_ID = normalizeSuiAddress(`0x${"1a".repeat(32)}`);
const GAS_COIN = {
  objectId: normalizeSuiAddress(`0x${"6a".repeat(32)}`),
  version: "7",
  digest: "BMwg3HvPTPQaKr9Lnk5jjNkw1bseCftzVgdaGksass4W",
};

const SHARED_OBJECTS = runtimeFor(NON_PRODUCTION_MANIFEST).sharedObjects;

export type FixtureLaunch = {
  lineage: "blast" | "foreign";
  lifecycle: "trading" | "migrated";
  version: number;
  curve: CurveState;
};

/** Every fact of the fixture node a harness or test may change between steps. */
export type FixtureChainState = {
  chainIdentifier: string;
  launch: FixtureLaunch | null;
  /** Atomic SUI per owner; an absent owner holds 100 SUI. */
  balances: Record<string, bigint>;
  reads: "available" | "unavailable";
  simulation: "success" | "failure" | "unavailable";
  /**
   * How the client's build resolves the transaction. A Core API client with
   * no gas budget simulates while building: `execution-error` fails that
   * simulation with a Move abort (`FIXTURE_BUILD_ABORT`, Sui's refusal);
   * `transport-error` is the client's `SimulationError` without an execution
   * error, as the gRPC client wraps a dropped connection; `error` is any other
   * failure. `resolves` builds normally.
   */
  build: "resolves" | "execution-error" | "transport-error" | "error";
  /** `unknown`: the transaction lands but the submission call fails. */
  execution: "complete" | "abort" | "unknown";
  confirmation: "checkpointed" | "pending";
  evidence: "event" | "missing" | "foreign";
};

export type FixtureChainCalls = { simulate: number; execute: number; lookup: number };

export type FixtureChain = Readonly<{
  client: ClientWithCoreApi;
  state: FixtureChainState;
  calls: FixtureChainCalls;
}>;

export function fixtureLaunch(overrides: Partial<FixtureLaunch> = {}): FixtureLaunch {
  return {
    lineage: "blast",
    lifecycle: "trading",
    version: 40,
    curve: {
      memeReserve: 800_000_000_000_000_000n,
      realQuoteReserve: 1_000_000_000_000n,
      virtualQuote: 3_000_000_000_000n,
      graduationTarget: 12_000_000_000_000n,
      quoteFeeBps: 100n,
      memeFeeBps: 0n,
    },
    ...overrides,
  };
}

const DEFAULT_BALANCE = 100_000_000_000n;

function sharedObject(name: string, identity: Readonly<{ objectId: string; initialSharedVersion: string | number }>) {
  return {
    objectId: identity.objectId,
    version: "90",
    digest: GAS_COIN.digest,
    owner: { $kind: "Shared", Shared: { initialSharedVersion: identity.initialSharedVersion } },
    type: SHARED_OBJECTS[name]?.type,
    content: fixtureSharedContent(name, identity.objectId),
    json: null,
  };
}

function launchObject(launch: FixtureLaunch) {
  const packageId = launch.lineage === "blast" ? LAUNCHPAD : FOREIGN_PACKAGE;
  return {
    objectId: FIXTURE_LAUNCH_ID,
    version: String(launch.version),
    digest: GAS_COIN.digest,
    owner: { $kind: "Shared", Shared: { initialSharedVersion: "12" } },
    type: `${packageId}::launch::Launch<${MEME_TYPE}, ${SUI}>`,
    json: {
      lifecycle: launch.lifecycle,
      meme_reserve: String(launch.curve.memeReserve),
      real_quote_reserve: String(launch.curve.realQuoteReserve),
      virtual_quote: String(launch.curve.virtualQuote),
      graduation_target: String(launch.curve.graduationTarget),
      quote_fee_bps: String(launch.curve.quoteFeeBps),
      meme_fee_bps: String(launch.curve.memeFeeBps),
    },
  };
}

type Landed = { status: SuiClientTypes.ExecutionStatus; events: SuiClientTypes.Event[]; sender: string };

function successStatus(): SuiClientTypes.ExecutionStatus {
  return { success: true, error: null };
}

/** The Move abort the fixture client's build-time simulation reports for `build: "execution-error"`. */
export const FIXTURE_BUILD_ABORT = `MoveAbort in 2nd command, abort code: 7, in '${normalizeSuiAddress(LAUNCHPAD)}::launch::buy' (instruction 3)`;

function abortStatus(message: string): SuiClientTypes.ExecutionStatus {
  return {
    success: false,
    error: { $kind: "MoveAbort", message, MoveAbort: { abortCode: "7" } } as SuiClientTypes.ExecutionError,
  };
}

function effects(digest: string, status: SuiClientTypes.ExecutionStatus): SuiClientTypes.TransactionEffects {
  return {
    bcs: null,
    version: 2,
    status,
    gasUsed: { computationCost: "1000", storageCost: "0", storageRebate: "0", nonRefundableStorageFee: "0" },
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

function transactionResult(
  digest: string,
  landed: Landed,
  checkpoint: string | null,
): SuiClientTypes.TransactionResult<{ effects: true; events: true; objectTypes: true }> {
  const transaction = {
    digest,
    sender: landed.sender,
    signatures: [],
    epoch: "3",
    timestampMs: null,
    checkpoint,
    status: landed.status,
    balanceChanges: undefined,
    effects: effects(digest, landed.status),
    events: landed.events,
    objectTypes: {},
    transaction: undefined,
    bcs: undefined,
  };
  return landed.status.success
    ? { $kind: "Transaction", Transaction: transaction }
    : { $kind: "FailedTransaction", FailedTransaction: transaction };
}

function purchasedQuote(bytes: Uint8Array): bigint {
  const pure = Transaction.from(bytes)
    .getData()
    .inputs.find((input) => input.Pure);
  if (!pure?.Pure) throw new Error("The fixture purchase has no amount.");
  return BigInt(bcs.u64().parse(fromBase64(pure.Pure.bytes)));
}

function boughtEvent(state: FixtureChainState, quoteIn: bigint, sender: string): SuiClientTypes.Event[] {
  if (state.evidence === "missing" || !state.launch) return [];
  const preview = previewBuy(state.launch.curve, quoteIn);
  state.launch.curve = {
    ...state.launch.curve,
    memeReserve: preview.memeReserveAfter,
    realQuoteReserve: preview.realQuoteReserveAfter,
  };
  state.launch.version += 1;
  const packageId = state.evidence === "event" ? LAUNCHPAD : FOREIGN_PACKAGE;
  const payload = launchpadEventBcs.Bought.serialize({
    launch_id: FIXTURE_LAUNCH_ID,
    quote_in: preview.quoteInGross,
    meme_out_gross: preview.memeOutGross,
    meme_out_net: preview.memeOutNet,
    quote_refund: preview.quoteRefund,
    protocol_meme_fee: 0n,
    creator_meme_fee: preview.memeFee,
    protocol_quote_fee: preview.quoteFee,
    creator_quote_fee: 0n,
    meme_reserve: preview.memeReserveAfter,
    real_quote_reserve: preview.realQuoteReserveAfter,
  });
  return [
    {
      packageId,
      module: "launch",
      sender,
      eventType: `${packageId}::events::Bought<${MEME_TYPE},${SUI}>`,
      bcs: payload.toBytes(),
      json: null,
    },
  ];
}

/** An in-memory Sui node whose objects and failure modes the caller controls. */
export function createFixtureChain(overrides: Partial<FixtureChainState> = {}): FixtureChain {
  const state: FixtureChainState = {
    chainIdentifier: NON_PRODUCTION_MANIFEST.chainIdentifier,
    launch: fixtureLaunch(),
    balances: {},
    reads: "available",
    simulation: "success",
    build: "resolves",
    execution: "complete",
    confirmation: "checkpointed",
    evidence: "event",
    ...overrides,
  };
  const calls: FixtureChainCalls = { simulate: 0, execute: 0, lookup: 0 };
  const landed = new Map<string, Landed>();
  // Each execution spends the gas coin, so the next transaction has a new digest.
  let gasVersion = Number(GAS_COIN.version);
  const sharedIds = new Map<string, Readonly<{ objectId: string; initialSharedVersion: string | number }>>(
    sharedObjectEntries(NON_PRODUCTION_MANIFEST.sharedObjects).map(([path, identity]) => [path, identity]),
  );
  const sharedPaths = new Map<string, string>(
    sharedObjectEntries(NON_PRODUCTION_MANIFEST.sharedObjects).map(([path, identity]) => [identity.objectId, path]),
  );

  function requireReads() {
    if (state.reads === "unavailable") throw new Error("The fixture node is not answering reads.");
  }

  function lookup(digest: string) {
    calls.lookup += 1;
    requireReads();
    const found = landed.get(digest);
    if (!found || state.confirmation === "pending") throw new Error(`Transaction ${digest} is not confirmed yet.`);
    return transactionResult(digest, found, "41");
  }

  const core = {
    async getChainIdentifier() {
      requireReads();
      return { chainIdentifier: state.chainIdentifier };
    },
    async getObjects({ objectIds }: Readonly<{ objectIds: readonly string[] }>) {
      requireReads();
      return {
        objects: objectIds.map((id) => {
          const shared = sharedPaths.get(id);
          if (shared) return sharedObject(shared, sharedIds.get(shared)!);
          if (id === FIXTURE_LAUNCH_ID && state.launch) return launchObject(state.launch);
          return new Error(`Object ${id} does not exist.`);
        }),
      };
    },
    async getBalance({ owner }: Readonly<{ owner: string }>) {
      requireReads();
      const balance = String(state.balances[normalizeSuiAddress(owner)] ?? DEFAULT_BALANCE);
      return { balance: { coinType: SUI, balance, coinBalance: balance, addressBalance: "0" } };
    },
    resolveTransactionPlugin() {
      return async (data: TransactionDataBuilder, _options: unknown, next: () => Promise<void>) => {
        switch (state.build) {
          case "execution-error": {
            const executionError = abortStatus(FIXTURE_BUILD_ABORT).error!;
            throw new SimulationError(`Transaction resolution failed: ${executionError.message}`, { executionError });
          }
          case "transport-error":
            throw new SimulationError("14 UNAVAILABLE: Connection dropped", { cause: new Error("14 UNAVAILABLE") });
          case "error":
            throw new Error("socket hang up");
        }
        data.gasData.price ??= "1000";
        data.gasData.budget ??= "50000000";
        data.gasData.payment ??= [{ ...GAS_COIN, version: String(gasVersion) }];
        await next();
      };
    },
    async simulateTransaction({ transaction }: Readonly<{ transaction: Uint8Array }>) {
      calls.simulate += 1;
      if (state.simulation === "unavailable") throw new Error("The fixture node cannot simulate right now.");
      const digest = TransactionDataBuilder.getDigestFromBytes(transaction);
      const status =
        state.simulation === "success" ? successStatus() : abortStatus("The launch rejected this purchase (abort 7).");
      return { ...transactionResult(digest, { status, events: [], sender: "" }, null), commandResults: undefined };
    },
    async executeTransaction({ transaction, signatures }: Readonly<{ transaction: Uint8Array; signatures: string[] }>) {
      calls.execute += 1;
      const signer = await verifyTransactionSignature(transaction, signatures[0] ?? "", { offline: true });
      const digest = TransactionDataBuilder.getDigestFromBytes(transaction);
      const sender = signer.toSuiAddress();
      gasVersion += 1;
      const executed: Landed =
        state.execution === "abort"
          ? { status: abortStatus("The launch rejected this purchase (abort 7)."), events: [], sender }
          : { status: successStatus(), events: boughtEvent(state, purchasedQuote(transaction), sender), sender };
      landed.set(digest, executed);
      if (state.execution === "unknown") {
        throw new Error("The Sui node closed the connection before answering.");
      }
      return transactionResult(digest, executed, null);
    },
    async waitForTransaction({ digest }: Readonly<{ digest: string }>) {
      return lookup(digest);
    },
    async getTransaction({ digest }: Readonly<{ digest: string }>) {
      return lookup(digest);
    },
  };
  return { client: { core } as unknown as ClientWithCoreApi, state, calls };
}

const PRIVY_KEY = Ed25519Keypair.fromSecretKey(Uint8Array.from({ length: 32 }, (_, index) => index + 101));
const WALLET_KEY = Ed25519Keypair.fromSecretKey(Uint8Array.from({ length: 32 }, (_, index) => index + 201));

export type FixtureSignerBehavior = Readonly<{
  /** Called once per signature request; return `reject` to decline it. */
  decide?: () => "sign" | "reject";
  onRequest?: () => void;
}>;

function decline(): never {
  throw Object.assign(new Error("User rejected the request."), { code: 4001 });
}

/** A Privy embedded wallet built through the real Privy signer adapter. */
export function fixturePrivySigner(behavior: FixtureSignerBehavior = {}, network = "mainnet"): LaunchpadSigner {
  return privySigner({
    wallet: { address: PRIVY_KEY.toSuiAddress(), publicKey: PRIVY_KEY.getPublicKey().toBase64() },
    network,
    async signRawHash({ hash }) {
      behavior.onRequest?.();
      if (behavior.decide?.() === "reject") decline();
      return { signature: `0x${toHex(await PRIVY_KEY.sign(fromHex(hash.slice(2))))}` };
    },
  });
}

/** A direct wallet built through the real wallet signer adapter. */
export function fixtureWalletSigner(
  behavior: FixtureSignerBehavior = {},
  chains: readonly string[] = ["sui:mainnet"],
  network = "mainnet",
): LaunchpadSigner {
  return walletSigner({
    walletName: "Fixture wallet",
    account: { address: WALLET_KEY.toSuiAddress(), chains },
    network,
    async signTransaction({ transaction }) {
      behavior.onRequest?.();
      if (behavior.decide?.() === "reject") decline();
      return WALLET_KEY.signTransaction(fromBase64(transaction));
    },
  });
}

type FixtureWallet = Readonly<{ name: string }>;
type FixtureAccount = Readonly<{ address: string; chains: readonly string[] }>;

/**
 * A direct wallet as the production bridge sees it, for `connectDirectWalletSigner`.
 * `connected` says whether the account is already connected.
 */
export function fixtureDirectWallet(
  behavior: FixtureSignerBehavior,
  { network, chains, connected }: Readonly<{ network: string; chains: readonly string[]; connected: boolean }>,
): DirectWalletState<FixtureWallet, FixtureAccount> {
  const wallet = { name: "Fixture wallet" };
  const account = { address: WALLET_KEY.toSuiAddress(), chains };
  return {
    network,
    account: connected ? account : null,
    wallet: connected ? wallet : null,
    wallets: [wallet],
    connect: async () => [account],
    async sign(transaction) {
      behavior.onRequest?.();
      if (behavior.decide?.() === "reject") decline();
      return WALLET_KEY.signTransaction(fromBase64(transaction));
    },
  };
}

const PRIVY_USER = {
  linkedAccounts: [
    {
      type: "wallet",
      chainType: "sui",
      connectorType: "embedded",
      walletClientType: "privy",
      imported: false,
      id: "fixture-embedded-wallet",
      recoveryMethod: "privy-v2",
      address: PRIVY_KEY.toSuiAddress(),
      publicKey: PRIVY_KEY.getPublicKey().toBase64(),
    },
  ],
};

/** A signed-in Privy session with an embedded Sui wallet, for `connectPrivySigner`. */
export function fixturePrivySession(behavior: FixtureSignerBehavior, network: string): PrivyState {
  return {
    network,
    ready: async () => ({ authenticated: true, user: PRIVY_USER }),
    login: async () => PRIVY_USER,
    createWallet: async () => ({ user: PRIVY_USER }),
    async signRawHash({ hash }) {
      behavior.onRequest?.();
      if (behavior.decide?.() === "reject") decline();
      return { signature: `0x${toHex(await PRIVY_KEY.sign(fromHex(hash.slice(2))))}` };
    },
  };
}

export type FixtureBuyInput = Readonly<{ launchId: string; amount: string }>;

type FixtureBuyFresh = Readonly<{ lifecycle: string; curve: CurveState; balance: bigint }>;

function quoteAmount(amount: string): bigint {
  const mist = parseToMist(amount.trim());
  if (mist <= 0n) throw new RangeError("Enter an amount above zero.");
  return mist;
}

function launchState(object: SuiClientTypes.Object<{ json: true }>): FixtureBuyFresh["curve"] & { lifecycle: string } {
  const json = object.json ?? {};
  const read = (field: string) => BigInt(String(json[field]));
  return {
    lifecycle: String(json.lifecycle),
    memeReserve: read("meme_reserve"),
    realQuoteReserve: read("real_quote_reserve"),
    virtualQuote: read("virtual_quote"),
    graduationTarget: read("graduation_target"),
    quoteFeeBps: read("quote_fee_bps"),
    memeFeeBps: read("meme_fee_bps"),
  };
}

/**
 * A fixture curve purchase. It reads the launch and balance fresh, previews
 * with the SDK's `previewBuy`, and builds a fixture Move call the fixture node
 * understands. Concrete buy forms own their real adapters.
 */
export const fixtureBuyAdapter: LaunchpadActionAdapter<FixtureBuyInput, FixtureBuyFresh> = {
  action: "fixture-buy",
  async readFresh({ client, signer, input }) {
    const [{ objects }, { balance }] = await Promise.all([
      client.core.getObjects({ objectIds: [input.launchId], include: { json: true } }),
      client.core.getBalance({ owner: signer.address }),
    ]);
    const object = objects[0];
    if (!object || object instanceof Error) {
      return { objects: [{ role: "The launch", objectId: input.launchId, type: null, lineage: "launchpad" }], value: null };
    }
    const { lifecycle, ...curve } = launchState(object);
    return {
      objects: [{ role: "The launch", objectId: object.objectId, type: object.type, lineage: "launchpad" }],
      value: { lifecycle, curve, balance: BigInt(balance.balance) },
    };
  },
  eligibility(fresh, { input }) {
    if (fresh.lifecycle !== "trading") {
      return {
        eligible: false,
        code: "stale-lifecycle",
        message: "This launch has left its bonding curve, so curve purchases are closed.",
      };
    }
    if (fresh.balance < quoteAmount(input.amount)) {
      return {
        eligible: false,
        code: "insufficient-balance",
        message: `Your wallet holds ${atomsGrouped(fresh.balance, 9)} SUI, less than this purchase.`,
      };
    }
    return { eligible: true };
  },
  preview(fresh, { input }) {
    const preview = previewBuy(fresh.curve, quoteAmount(input.amount));
    return [
      { key: "quote-in", label: "You pay", value: `${atomsGrouped(preview.quoteInGross, 9)} SUI` },
      { key: "meme-out", label: "You receive", value: `${atomsGrouped(preview.memeOutNet, 9)} MEME` },
      { key: "fee", label: "Curve fee", value: `${atomsGrouped(preview.quoteFee, 9)} SUI` },
      { key: "refund", label: "Refund above target", value: `${atomsGrouped(preview.quoteRefund, 9)} SUI` },
      { key: "lifecycle", label: "Launch state", value: fresh.lifecycle === "trading" ? "Bonding curve open" : fresh.lifecycle },
    ];
  },
  build(fresh, { deployment, input }) {
    const transaction = new Transaction();
    transaction.moveCall({
      target: `${deployment.packages.launchpad.packageId}::launch::buy`,
      typeArguments: [MEME_TYPE, SUI],
      arguments: [
        transaction.sharedObjectRef({ objectId: input.launchId, initialSharedVersion: "12", mutable: true }),
        transaction.pure.u64(quoteAmount(input.amount)),
      ],
    });
    return transaction;
  },
  completion: { kind: "event", source: "launchpad", event: "Bought" },
  affectedReads: (input) => [`launch:${input.launchId}`, "wallet:balances"],
};

const STATE_FIXTURE_INPUT: FixtureBuyInput = { launchId: FIXTURE_LAUNCH_ID, amount: "12.5" };

const STATE_FIXTURE_REVIEW: FreshReview = {
  id: "fixture-review",
  facts: [
    { key: "network", label: "Network", value: "Sui mainnet" },
    { key: "quote-in", label: "You pay", value: "12.5 SUI" },
  ],
  signer: { kind: "wallet", address: WALLET_KEY.toSuiAddress(), chain: "sui:mainnet" },
  deploymentFingerprint: "fixture",
  transactionBytes: new Uint8Array([1]),
};

/**
 * One reachable state per action phase, built by replaying events through
 * the reducer, for every financial vertical's presentation tests.
 */
export function actionStateFixtures<Input = FixtureBuyInput>(
  input: Input = STATE_FIXTURE_INPUT as Input,
): Readonly<Record<ActionPhase, ActionState<Input>>> {
  const signer = STATE_FIXTURE_REVIEW.signer;
  const replay = (events: readonly ((state: ActionState<Input>) => ActionEvent<Input>)[]) =>
    events.reduce((state, event) => reduceAction(state, event(state)), initialActionState(input));
  const ready = (review: FreshReview) => (state: ActionState<Input>): ActionEvent<Input> => ({
    type: "preflight-resolved",
    attempt: state.attempt,
    outcome: { status: "ready", review },
  });
  const submit = (): ActionEvent<Input> => ({ type: "submit", signer });
  const approve = (): ActionEvent<Input> => ({ type: "approve", reviewId: STATE_FIXTURE_REVIEW.id });
  const signing = [submit, ready(STATE_FIXTURE_REVIEW), approve, ready(STATE_FIXTURE_REVIEW)];
  const submitted = [...signing, (state: ActionState<Input>): ActionEvent<Input> => ({
    type: "submitted",
    attempt: state.attempt,
    digest: GAS_COIN.digest,
  })];
  const reconciled = (outcome: Extract<ActionEvent<Input>, { type: "reconciled" }>["outcome"]) =>
    (state: ActionState<Input>): ActionEvent<Input> => ({ type: "reconciled", attempt: state.attempt, outcome });
  return {
    editing: initialActionState(input),
    "choosing-signer": replay([() => ({ type: "submit", signer: null })]),
    connecting: replay([() => ({ type: "submit", signer: null }), () => ({ type: "choose-signer", kind: "privy" })]),
    preflighting: replay([submit]),
    blocked: replay([
      submit,
      (state) => ({
        type: "preflight-resolved",
        attempt: state.attempt,
        outcome: {
          status: "blocked",
          block: {
            stage: "signer",
            code: "wrong-network",
            message: "Your wallet is set to Sui testnet. Switch it to Sui mainnet, then review again.",
            details: [],
          },
        },
      }),
    ]),
    review: replay([submit, ready(STATE_FIXTURE_REVIEW)]),
    signing: replay(signing),
    rejected: replay([...signing, (state) => ({ type: "signature-rejected", attempt: state.attempt })]),
    reconciling: replay(submitted),
    succeeded: replay([
      ...submitted,
      reconciled({ status: "succeeded", explorerUrl: `http://127.0.0.1:9001/tx/${GAS_COIN.digest}`, checkpoint: 41 }),
    ]),
    failed: replay([
      ...submitted,
      reconciled({ status: "failed", explorerUrl: null, message: "The launch rejected this purchase (abort 7)." }),
    ]),
    ambiguous: replay([
      ...signing,
      (state) => ({
        type: "submission-unknown",
        attempt: state.attempt,
        digest: GAS_COIN.digest,
        message: "The Sui node closed the connection before answering.",
      }),
    ]),
  };
}
