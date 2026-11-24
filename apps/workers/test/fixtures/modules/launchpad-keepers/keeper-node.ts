import { SUI_COIN_TYPE as SUI } from "@blast/core/lib/sui/coin-types.ts";
import type { BlastDeployment } from "@interest-protocol/blast-deployments-sdk";
import { launchBcs } from "@interest-protocol/blast-launchpad-sdk";
import { partnerBcs } from "@interest-protocol/blast-partners-sdk/state";
import { bcs } from "@mysten/sui/bcs";
import { ObjectError, TransactionError, type ClientWithCoreApi } from "@mysten/sui/client";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { fromBase64, normalizeStructTag, normalizeSuiAddress, normalizeSuiObjectId } from "@mysten/sui/utils";

import { launchObjectFixture } from "../../final-stack/launch-object.ts";

/** What one fixture transaction charges: computation 1,000,000 plus storage 500,000 MIST. */
export const KEEPER_GAS_COST = 1_500_000n;
const KEEPER_CHAIN = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S";
const KEEPER_EPOCH = 1;

export type KeeperLaunch = {
  objectId: string;
  memeType: string;
  quoteType: string;
  lifecycle: "OpeningRound" | "Live" | "MigrationReady" | "Migrated";
  publicStartMs: bigint | null;
  openingRoundMs: bigint;
  bids: Map<string, bigint>;
  roundMeme: bigint;
  protocolMeme: bigint;
  protocolQuote: bigint;
  protocolSui: bigint;
  partnerId: string | null;
  memeReserve: bigint;
  virtualQuote: bigint;
  realQuote: bigint;
};


export type KeeperCall = Readonly<{ digest: string; sender: string; target: string; launchOrVault: string; bidder?: string; partner?: string }>;

type Landed = { success: boolean; sender: string; calls: KeeperCall[] };

type TransactionData = ReturnType<Transaction["getData"]>;
type MoveCall = NonNullable<TransactionData["commands"][number]["MoveCall"]>;

function sharedInput(data: TransactionData, argument: { $kind: string; Input?: number }): string {
  const input = argument.$kind === "Input" ? data.inputs[argument.Input!] : undefined;
  const object = input?.Object?.SharedObject;
  if (!object) {
    abort("expected a shared object");
  }
  return normalizeSuiObjectId(object.objectId);
}

let counter = 0;
const id = () => normalizeSuiObjectId(`0x${(++counter).toString(16).padStart(8, "0")}${"5e".repeat(28)}`);

function abort(message: string): never {
  throw Object.assign(new Error(message), { abort: true });
}

export function createKeeperNode(deployment: BlastDeployment) {
  const launchpad = normalizeSuiAddress(deployment.packages.launchpad.packageId);
  const launchpadOriginal = normalizeSuiAddress(deployment.packages.launchpad.originalPackageId);
  const partners = normalizeSuiAddress(deployment.packages.partners.originalPackageId);
  const launches = new Map<string, KeeperLaunch>();
  const partnerIds = new Set<string>();
  const addressBalances = new Map<string, bigint>();
  const landed = new Map<string, Landed>();
  const calls: KeeperCall[] = [];
  const executions: number[] = [];
  const behavior: {
    clockMs: () => number;
    /** Runs between a submission's arrival and its execution: another wallet acting first. */
    beforeExecute: (() => void) | null;
    /** Every simulation fails, as a transaction the chain would reject. */
    simulationAborts: boolean;
  } = { clockMs: () => Date.now(), beforeExecute: null, simulationAborts: false };
  const base = launchBcs.parse(launchObjectFixture("live").content);

  function launchContent(launch: KeeperLaunch): Uint8Array {
    const total = [...launch.bids.values()].reduce((sum, bid) => sum + bid, 0n);
    return launchBcs.serialize({
      ...base,
      id: { id: { bytes: launch.objectId } },
      lifecycle: { [launch.lifecycle]: true } as never,
      public_start_ms: launch.publicStartMs,
      opening_round_ms: launch.openingRoundMs,
      opening_round_bids: total,
      opening_round_quote: 0n,
      opening_round_meme: launch.roundMeme,
      meme_reserve: launch.memeReserve,
      real_quote_reserve: launch.realQuote,
      virtual_quote: launch.virtualQuote,
      protocol_fees: { packageWitness: `${launchpadOriginal}::blast_fun::PackageWitness`, origin: launch.objectId, partnerId: launch.partnerId, meme: launch.protocolMeme, quote: launch.protocolQuote, sui: launch.protocolSui },
      partner_id: launch.partnerId ? { bytes: launch.partnerId } : null,
    } as never).toBytes();
  }

  function partnerContent(partnerId: string): Uint8Array {
    return partnerBcs.serialize({
      id: { id: { bytes: partnerId } },
      recipient: normalizeSuiAddress(`0x${"aa".repeat(32)}`),
      share_bps: { parent: partnerId, key: null, value: 2_000n, pending: null, delay_ms: 1n },
      cap_id: { parent: partnerId, key: null, value: normalizeSuiObjectId("0xcc"), pending: null, delay_ms: 1n },
    } as never).toBytes();
  }

  function object(objectId: string) {
    const key = normalizeSuiObjectId(objectId);
    const shared = (version: string, type: string, content: Uint8Array) => ({
      objectId: key, version: "10", digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
      owner: { $kind: "Shared", Shared: { initialSharedVersion: version } }, type, content,
    });
    const launch = launches.get(key);
    if (launch) return shared("5", `${launchpadOriginal}::launch::Launch<${launch.memeType}, ${launch.quoteType}>`, launchContent(launch));
    if (partnerIds.has(key)) return shared("7", `${partners}::blast_partners::Partner`, partnerContent(key));
    return new ObjectError("NOT_FOUND", `Object ${key} does not exist.`, { reason: "notFound", objectId: key });
  }

  function settleRound(launch: KeeperLaunch): void {
    if (launch.lifecycle !== "OpeningRound") {
      abort("invalid_launch_lifecycle");
    }
    if (
      launch.publicStartMs === null ||
      BigInt(behavior.clockMs()) < launch.publicStartMs + launch.openingRoundMs
    ) {
      abort("opening_round_not_ended");
    }
    launch.lifecycle = "Live";
    launch.roundMeme = [...launch.bids.values()].reduce((sum, bid) => sum + bid, 0n) * 10n;
  }

  function deliverBid(
    launch: KeeperLaunch,
    input: TransactionData["inputs"][number] | undefined,
  ): string {
    if (launch.lifecycle === "OpeningRound") {
      abort("invalid_launch_lifecycle");
    }
    const bidder = normalizeSuiAddress(bcs.Address.parse(fromBase64(input?.Pure?.bytes ?? "")));
    if (!launch.bids.has(bidder)) {
      abort("dynamic_field::remove: no bid");
    }
    launch.bids.delete(bidder);
    return bidder;
  }

  function claimCurveFees(launch: KeeperLaunch, partner: string | null): void {
    if (partner !== (launch.partnerId ? normalizeSuiObjectId(launch.partnerId) : null)) {
      abort("partner_mismatch");
    }
    launch.protocolMeme = 0n;
    launch.protocolQuote = 0n;
    launch.protocolSui = 0n;
  }


  function runLaunchCall(data: TransactionData, call: MoveCall, result: KeeperCall): KeeperCall {
    const launch = launches.get(result.launchOrVault) ?? abort("no such launch");
    switch (result.target) {
      case "launch::settle_opening_round":
        settleRound(launch);
        return result;
      case "launch::deliver_opening_round": {
        const argument = call.arguments[2]!;
        const input = argument.$kind === "Input" ? data.inputs[argument.Input!] : undefined;
        return { ...result, bidder: deliverBid(launch, input) };
      }
      case "launch::claim_protocol_fees":
        claimCurveFees(launch, null);
        return result;
      case "launch::claim_protocol_fees_with_partner": {
        const partner = sharedInput(data, call.arguments[3]!);
        claimCurveFees(launch, partner);
        return { ...result, partner };
      }
      default:
        return abort(`unexpected ${result.target}`);
    }
  }

  /** Runs the transaction's calls against `state` (mutating it); throws an abort. */
  function run(bytes: Uint8Array, digest: string): { sender: string; calls: KeeperCall[] } {
    const data = Transaction.from(bytes).getData();
    const sender = normalizeSuiAddress(data.sender!);
    const ran: KeeperCall[] = [];
    for (const [index, command] of data.commands.entries()) {
      try {
        ran.push(runCommand(data, command, digest, sender));
      } catch (error) {
        // As the node does, the error names the command that aborted.
        if ((error as { abort?: boolean }).abort) Object.assign(error as object, { command: index });
        throw error;
      }
    }
    return { sender, calls: ran };
  }

  function runCommand(data: TransactionData, command: TransactionData["commands"][number], digest: string, sender: string): KeeperCall {
    const call = command.MoveCall;
    if (!call) {
      abort("only Move calls");
    }
    const pkg = normalizeSuiAddress(call.package);
    const target = `${call.module}::${call.function}`;
    const first = sharedInput(data, call.arguments[0]!);
    const result = { digest, sender, target, launchOrVault: first };
    if (pkg === launchpad && call.module === "launch") {
      return runLaunchCall(data, call, result);
    }

    return abort(`unexpected ${pkg}::${target}`);
  }

  /** Runs `bytes` on a copy of the state; commits only when asked and it succeeds. */
  function attempt(
    bytes: Uint8Array,
    digest: string,
    commit: boolean,
  ): { ok: boolean; sender: string; calls: KeeperCall[]; error?: string; command?: number } {
    const saved = snapshot();
    try {
      const result = run(bytes, digest);
      if (!commit) restore(saved);
      return { ok: true, ...result };
    } catch (error) {
      restore(saved);
      if (!(error as { abort?: boolean }).abort) throw error;
      return {
        ok: false,
        sender: normalizeSuiAddress(Transaction.from(bytes).getData().sender!),
        calls: [],
        error: (error as Error).message,
        command: (error as { command?: number }).command,
      };
    }
  }

  function snapshot() {
    return {
      launches: new Map([...launches].map(([key, launch]) => [key, { ...launch, bids: new Map(launch.bids) }])),
    };
  }

  function restore(saved: ReturnType<typeof snapshot>) {
    launches.clear();
    for (const [key, launch] of saved.launches) launches.set(key, launch);
  }

  const effects = (digest: string, success: boolean, error?: string, command?: number) => ({
    transactionDigest: digest,
    status: success
      ? { success: true, error: null }
      : { success: false, error: { message: error ?? "abort", ...(command === undefined ? {} : { command }) } },
    gasUsed: { computationCost: "1000000", storageCost: "500000", storageRebate: "0", nonRefundableStorageFee: "0" },
  });

  const answer = (digest: string, found: Landed, error?: string, command?: number) => {
    const transaction = {
      digest,
      status: found.success ? { success: true } : { success: false },
      effects: effects(digest, found.success, error, command),
      checkpoint: "41",
    };
    return found.success ? { $kind: "Transaction", Transaction: transaction } : { $kind: "FailedTransaction", FailedTransaction: transaction };
  };

  const core = {
    async getObjects({ objectIds }: Readonly<{ objectIds: string[] }>) {
      return { objects: objectIds.map(object) };
    },
    async getDynamicField({ parentId, name }: Readonly<{ parentId: string; name: { type: string; bcs: Uint8Array } }>) {
      const launch = launches.get(normalizeSuiObjectId(parentId));
      const bidder = normalizeSuiAddress(bcs.Address.parse(name.bcs));
      const bid = name.type === `${launchpadOriginal}::launch::OpeningRoundBidKey` ? launch?.bids.get(bidder) : undefined;
      if (bid === undefined) throw new ObjectError("NOT_FOUND", `No such field of ${parentId}.`, { reason: "notFound", objectId: parentId });
      return { dynamicField: { value: { type: "u64", bcs: bcs.u64().serialize(bid).toBytes() } } };
    },
    async getChainIdentifier() {
      return { chainIdentifier: KEEPER_CHAIN };
    },
    async getBalance({ owner }: Readonly<{ owner: string }>) {
      const balance = String(addressBalances.get(normalizeSuiAddress(owner)) ?? 0n);
      return { balance: { coinType: SUI, balance, coinBalance: "0", addressBalance: balance } };
    },
    async getCurrentSystemState() {
      return { systemState: { epoch: String(KEEPER_EPOCH), referenceGasPrice: "1000" } };
    },
    async simulateTransaction({ transaction }: Readonly<{ transaction: Uint8Array }>) {
      const digest = TransactionDataBuilder.getDigestFromBytes(transaction);
      const result = behavior.simulationAborts ? { ok: false, sender: "", calls: [], error: "fixture abort" } : attempt(transaction, digest, false);
      return answer(digest, { success: result.ok, sender: result.sender, calls: [] }, result.error, result.command);
    },
    async executeTransaction({ transaction }: Readonly<{ transaction: Uint8Array; signatures: string[] }>) {
      const digest = TransactionDataBuilder.getDigestFromBytes(transaction);
      const found = landed.get(digest);
      if (found) return answer(digest, found);
      // As on Sui: no gas coin, so the address balance pays, under a `ValidDuring` expiration for the current epoch on this chain.
      const data = Transaction.from(transaction).getData();
      const validDuring = data.expiration?.$kind === "ValidDuring" ? data.expiration.ValidDuring : null;
      if (data.gasData.payment?.length) throw new Error("The keeper node holds no gas coin.");
      if (!validDuring || validDuring.chain !== KEEPER_CHAIN || Number(validDuring.minEpoch) > KEEPER_EPOCH || Number(validDuring.maxEpoch) < KEEPER_EPOCH) {
        throw new Error("The transaction expired.");
      }
      const hook = behavior.beforeExecute;
      behavior.beforeExecute = null;
      hook?.();
      const result = attempt(transaction, digest, true);
      const sender = normalizeSuiAddress(data.sender!);
      const available = addressBalances.get(sender) ?? 0n;
      if (available < KEEPER_GAS_COST) throw new Error("The address balance cannot pay for this transaction.");
      addressBalances.set(sender, available - KEEPER_GAS_COST);
      const outcome: Landed = { success: result.ok, sender: result.sender, calls: result.calls };
      landed.set(digest, outcome);
      calls.push(...result.calls);
      executions.push(result.calls.length);
      return answer(digest, outcome, result.error, result.command);
    },
    async getTransaction({ digest }: Readonly<{ digest: string }>) {
      const found = landed.get(digest);
      if (!found) throw new TransactionError("notFound", digest);
      return answer(digest, found);
    },
    async waitForTransaction({ digest }: Readonly<{ digest: string }>) {
      return core.getTransaction({ digest });
    },
  };

  return {
    client: { core } as unknown as ClientWithCoreApi,
    behavior,
    /** Every call that landed, in order. */
    calls,
    /** How many calls each executed transaction ran, in order (0 for one that aborted). */
    executions,
    /** Sets `owner`'s SUI address balance, which pays its gas. */
    fundAddressBalance(owner: string, mist: bigint) {
      addressBalances.set(normalizeSuiAddress(owner), mist);
    },
    addLaunch(options: Partial<Omit<KeeperLaunch, "bids">> & { bids?: Record<string, bigint> } = {}): KeeperLaunch {
      const launch: KeeperLaunch = {
        objectId: id(),
        memeType: normalizeStructTag(`${id()}::meme::MEME`),
        quoteType: SUI,
        lifecycle: "OpeningRound",
        publicStartMs: BigInt(Date.now() - 120_000),
        openingRoundMs: 60_000n,
        roundMeme: 0n,
        protocolMeme: 0n,
        protocolQuote: 0n,
        protocolSui: 0n,
        partnerId: null,
        memeReserve: 800_000_000_000_000n,
        virtualQuote: 1_000_000_000_000n,
        realQuote: 0n,
        ...options,
        bids: new Map(Object.entries(options.bids ?? {}).map(([bidder, bid]) => [normalizeSuiAddress(bidder), bid])),
      };
      launches.set(launch.objectId, launch);
      return launch;
    },
    addPartner(): string {
      const partner = id();
      partnerIds.add(partner);
      return partner;
    },
    launch: (launchId: string) => launches.get(normalizeSuiObjectId(launchId))!,
    /** Another wallet's transaction, landing now. */
    externally(change: () => void) {
      change();
    },
  };
}

export type KeeperNode = ReturnType<typeof createKeeperNode>;
