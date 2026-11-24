import { z } from "zod";
import type { bcs } from "@mysten/sui/bcs";
import { fromBase64, normalizeSuiAddress, normalizeTypeTag, toHex } from "@mysten/sui/utils";

import type { BlastTradeFee } from "@blast/core/lib/blast-trade-fee.ts";
import type { SuiBurnIds } from "../presale/bridge/sui-burn.ts";
import {
  namesPresale,
  presalePolicy,
  SPONSOR_INTENTS,
  type PresaleSponsorIntent,
  type SponsorCall,
} from "./intents.ts";
import { AFTERMATH_DAO_PACKAGE, AFTERMATH_DAO_SWAP_CALL } from "./aftermath-dao.ts";
import { argumentKind, describeArgumentKind, type SponsorArgumentKind } from "./argument-kinds.ts";
import { SWAP_CONTEXT, SWAP_OUTPUT } from "./cetus-router.ts";
import { SPONSOR_FRAMEWORK_CALLS } from "./framework-calls.ts";
import {
  LINEAR_VESTING_CLAIM_CALL,
  LINEAR_VESTING_MODULE,
  type LinearVestingSchedule,
} from "./linear-vesting.ts";
import { VESTING_PACKAGE } from "@blast/core/modules/vesting/model.ts";
import { SPONSOR_SWAP_CALLS } from "./swap-calls.ts";

/** A decoded Sui `TransactionKind` (`bcs.TransactionKind.parse`). */
export type SponsorTransactionKind = typeof bcs.TransactionKind.$inferType;

/** A `Round` the kind references, with its vault and that vault's presale. */
export type SponsorRewardRound = { roundId: string; vaultId: string; vaultPresaleId: string };

/** One configured swap target: the derived swap functions of `module` in `packageId`. */
export type SponsorSwapTarget = { packageId: string; module: string };

/**
 * A function the commit intent may call, derived from SDK and Cetus
 * sponsored-mode transactions: a full `0x1`/`0x2` target in
 * `framework-calls.ts`, or a swap `module::function` in `swap-calls.ts`. A
 * call must have exactly `argumentCount` arguments and `typeArgumentCount`
 * type arguments, and each argument must be of a kind its builds passed at
 * that position (`argumentKinds`). Each argument at `recipientArguments` must
 * be the sender and
 * each at `fixedArguments` its derived address; no other argument may be a
 * 32-byte pure value. Only `sharedObjects` positions may take a shared object:
 * the pinned `objectId`, or any object where it is `null` (the route's pool).
 */
export type SponsorDerivedCall = {
  target: string;
  argumentCount: number;
  typeArgumentCount: number;
  argumentKinds: readonly (readonly SponsorArgumentKind[])[];
  recipientArguments: readonly number[];
  fixedArguments: readonly { position: number; value: string }[];
  sharedObjects: readonly { position: number; objectId: string | null }[];
};

/** Chain facts the caller resolves; the policy itself reads nothing. */
export type SponsorPolicyFacts = {
  presalePackageId: string;
  vaultPackageId?: string;
  /** The sale's on-chain `SaleToken` (Meme) type. */
  saleToken: string;
  quote: string;
  rewardRounds: readonly SponsorRewardRound[];
  swapTargets: readonly SponsorSwapTarget[];
  /** Configured app fee for an atomic swap-and-commit; absent means zero. */
  commitSwapFee?: BlastTradeFee | null;
  /** The vesting schedules a `claim` kind names (`referencedVestingSchedules`), as the chain holds them; unknown ones are left out. */
  vestingSchedules?: readonly Pick<
    LinearVestingSchedule,
    "objectId" | "coinType" | "beneficiary"
  >[];
};

export type SponsorPolicyRequest = {
  kind: SponsorTransactionKind;
  intent: PresaleSponsorIntent;
  presaleId: string;
  sender: string;
  facts: SponsorPolicyFacts;
};

export type SponsorPolicyDecision =
  | { allowed: true }
  | { allowed: false; code: "target_not_allowed"; reason: string };

type ProgrammableTransaction = NonNullable<SponsorTransactionKind["ProgrammableTransaction"]>;
type Command = ProgrammableTransaction["commands"][number];
type Argument = NonNullable<Command["MoveCall"]>["arguments"][number];
type MoveCall = { package: string; module: string; function: string };
type FullMoveCall = NonNullable<Command["MoveCall"]>;
type KindReader = ReturnType<typeof kindReader>;

/**
 * Besides the presale's own: `blast_fun_linear_vesting::claim<T>(vesting,
 * clock)` of a schedule paying the sender in one of the sale's two coins
 * (P-13, `linear-vesting.ts`).
 */
const VESTING_CLAIM = `${LINEAR_VESTING_MODULE}::claim`;

const FRAMEWORK_PACKAGES = new Set([normalizeSuiAddress("0x1"), normalizeSuiAddress("0x2")]);
const FRAMEWORK_CALLS = new Map(SPONSOR_FRAMEWORK_CALLS.map((call) => [call.target, call]));
const SWAP_CALLS = new Map(SPONSOR_SWAP_CALLS.map((call) => [call.target, call]));

class Refusal extends Error {}

/**
 * Whether Blast's gas pool may pay for `kind` under `intent`. Pure: callers
 * supply every chain fact. Refusals carry `target_not_allowed` and a reason
 * for logs.
 */
export function evaluateSponsorPolicy(request: SponsorPolicyRequest): SponsorPolicyDecision {
  try {
    check(request);
    return { allowed: true };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return { allowed: false, code: "target_not_allowed", reason: error.message };
  }
}

/**
 * Reads one programmable kind's inputs for its sender: the input an argument
 * names, its pure bytes and 32-byte address, whether it is the sender, and the
 * derived-call check every sponsored framework or swap call passes. Refuses a
 * kind that is not programmable or withdraws funds from anyone but the sender.
 */
function kindReader(kind: SponsorTransactionKind, sender: string) {
  if (kind.$kind !== "ProgrammableTransaction")
    refuse(`${kind.$kind} is not a programmable transaction`);
  const { inputs, commands } = kind.ProgrammableTransaction;
  inputs.forEach((input, index) => {
    const from = input.FundsWithdrawal?.withdrawFrom.$kind;
    if (from && from !== "Sender") refuse(`input ${index} withdraws from ${from}, not the sender`);
  });
  const owner = normalizeSuiAddress(sender);
  const input = (argument: Argument | undefined) =>
    argument?.$kind === "Input" ? inputs[argument.Input] : undefined;
  const pureBytes = (argument: Argument | undefined): Uint8Array | undefined => {
    const pure = input(argument)?.Pure;
    return pure && fromBase64(pure.bytes);
  };
  /** The address a pure 32-byte argument holds. */
  const addressOf = (argument: Argument | undefined): string | undefined => {
    const bytes = pureBytes(argument);
    return bytes?.length === 32 ? normalizeSuiAddress(toHex(bytes)) : undefined;
  };
  const isSender = (argument: Argument | undefined): boolean => addressOf(argument) === owner;
  const sharedObjectId = (argument: Argument | undefined): string | undefined => {
    const shared = input(argument)?.Object?.SharedObject;
    return shared && normalizeSuiAddress(shared.objectId);
  };
  /**
   * Exact counts; recipients hold the sender, pinned positions their derived
   * address, and no other argument an address; each argument of a derived
   * kind, and shared objects at their pinned id.
   */
  const checkDerivedCall = (
    at: string,
    call: NonNullable<Command["MoveCall"]>,
    derived: SponsorDerivedCall,
  ): void => {
    const args = call.arguments;
    if (args.length !== derived.argumentCount)
      refuse(`${at} takes ${args.length} arguments, not the derived ${derived.argumentCount}`);
    if (call.typeArguments.length !== derived.typeArgumentCount) {
      refuse(
        `${at} takes ${call.typeArguments.length} type arguments, not the derived ${derived.typeArgumentCount}`,
      );
    }
    const objects = new Map(
      derived.sharedObjects.map(({ position, objectId }) => [position, objectId]),
    );
    args.forEach((argument, position) => {
      const kind = argumentKind(inputs, argument);
      const allowed = derived.argumentKinds[position] ?? [];
      if (!allowed.includes(kind))
        refuse(
          `${at} argument ${position} is ${describeArgumentKind(kind)}, not ${allowed.join(" or ")}`,
        );
      // A shared object passed the kind check, so its position is derived: pinned, or null for the route pool.
      const shared = input(argument)?.Object?.SharedObject;
      const pinned = objects.get(position);
      if (shared && pinned && normalizeSuiAddress(shared.objectId) !== pinned) {
        refuse(`${at} argument ${position} is not the derived object ${pinned}`);
      }
    });
    const recipients = new Set(derived.recipientArguments);
    const fixed = new Map(derived.fixedArguments.map(({ position, value }) => [position, value]));
    for (const position of recipients) {
      if (!isSender(args[position])) refuse(`${at} argument ${position} is not the sender`);
    }
    args.forEach((argument, position) => {
      if (recipients.has(position)) return;
      const address = addressOf(argument);
      const pinned = fixed.get(position);
      if (pinned !== undefined && address !== pinned)
        refuse(`${at} argument ${position} is not the derived address ${pinned}`);
      if (pinned === undefined && address !== undefined && address !== owner) {
        refuse(`${at} argument ${position} holds an address that is not the sender`);
      }
    });
  };
  return {
    inputs,
    commands,
    owner,
    input,
    pureBytes,
    addressOf,
    isSender,
    sharedObjectId,
    checkDerivedCall,
  };
}

/**
 * How many coins a client-built sponsored kind may split off in all. Every new
 * object is storage the sponsor pre-pays and whoever later deletes it is
 * refunded, so a kind may not fan one coin out into many: a commit splits its
 * amount and at most Blast's fee (with room for the coin resolver), a withdraw
 * exactly the one coin it sends (`coinWithBalance`).
 */
export const SPONSOR_MAX_COMMIT_SPLITS = 4;
export const SPONSOR_MAX_WITHDRAW_SPLITS = 1;

/** Refuses a kind whose `SplitCoins` commands make more than `max` coins together. */
function refuseSplitFanOut(commands: readonly Command[], max: number): void {
  const splits = commands.reduce((total, command) => total + (command.SplitCoins?.amounts.length ?? 0), 0);
  if (splits > max) refuse(`the kind splits off ${splits} coins, more than ${max}`);
}

/** Refuses a command that uses the gas coin, publishes or upgrades a package. */
function refuseSponsorSpend(command: Command, at: string): void {
  if (commandArguments(command).some((argument) => argument.$kind === "GasCoin"))
    refuse(`${at} uses the gas coin`);
  if (command.$kind === "Publish" || command.$kind === "Upgrade")
    refuse(`${at}: ${command.$kind} is not allowed`);
}

function check(request: SponsorPolicyRequest): void {
  const { kind, intent, sender, facts } = request;
  // Callers outside the type system (a parsed body) may still pass any intent.
  if (!Object.hasOwn(SPONSOR_INTENTS, intent) || !namesPresale(intent)) {
    refuse(`unknown intent ${intent}`);
  }
  const { package: protocol, calls } = presalePolicy(intent);
  const { commands, isSender, addressOf, pureBytes, sharedObjectId, checkDerivedCall } = kindReader(
    kind,
    sender,
  );
  const daoRoute =
    intent === "commit" &&
    commands.some((command) => command.MoveCall && isAftermathDaoSwap(command.MoveCall));
  const swapFee = facts.commitSwapFee ?? null;
  const feeReceiver = daoRoute && swapFee ? normalizeSuiAddress(swapFee.receiver) : null;
  let feeTransfers = 0;
  function checkCommitTransfer(
    at: string,
    transfer: NonNullable<Command["TransferObjects"]>,
  ): void {
    if (isSender(transfer.address)) return;
    if (feeReceiver === null || addressOf(transfer.address) !== feeReceiver || ++feeTransfers > 1) {
      refuse(`${at}: TransferObjects to an address that is not the sender`);
    }
    for (const object of transfer.objects) {
      const splitIndex = resultCommand(object);
      const split = splitIndex === null ? undefined : commands[splitIndex]?.SplitCoins;
      const sourceIndex = split && resultCommand(split.coin);
      const source =
        sourceIndex === null || sourceIndex === undefined
          ? undefined
          : commands[sourceIndex]?.MoveCall;
      if (
        !split ||
        !source ||
        !(isAftermathDaoSwap(source) || `${source.module}::${source.function}` === SWAP_OUTPUT)
      ) {
        refuse(`${at}: Blast's fee is not a coin split from a swap's output`);
      }
      checkSplitAmounts(at, split.amounts, pureBytes);
    }
  }
  // Commands that could spend the sponsor's gas or reach another wallet come first.
  commands.forEach((command, index) => {
    const at = `command ${index}`;
    refuseSponsorSpend(command, at);
    if (command.$kind === "TransferObjects") checkCommitTransfer(at, command.TransferObjects);
  });
  refuseSplitFanOut(commands, SPONSOR_MAX_COMMIT_SPLITS);
  const presalePackage = normalizeSuiAddress(facts.presalePackageId);
  if (protocol === "vault" && !facts.vaultPackageId) {
    refuse("vault package is unavailable");
  }
  const protocolPackage = protocol === "vault" ? normalizeSuiAddress(facts.vaultPackageId!) : presalePackage;
  const presaleId = normalizeSuiAddress(request.presaleId);
  const saleTypes = [normalizeType(facts.saleToken), normalizeType(facts.quote)];
  const rounds = new Map(
    facts.rewardRounds.map((round) => [normalizeSuiAddress(round.roundId), round]),
  );
  const swapTargets = new Set(
    facts.swapTargets.map(({ packageId, module }) => {
      const pkg = normalizeSuiAddress(packageId);
      if (FRAMEWORK_PACKAGES.has(pkg)) refuse(`framework package ${pkg} is not a swap target`);
      if (pkg === presalePackage) refuse(`presale package ${pkg} is not a swap target`);
      return `${pkg}::${module}`;
    }),
  );
  const quote = saleTypes[1];
  function checkCommitSwap(at: string, call: FullMoveCall): boolean {
    if (isAftermathDaoSwap(call)) {
      checkDerivedCall(at, call, AFTERMATH_DAO_SWAP_CALL);
      return true;
    }
    if (!swapTargets.has(`${normalizeSuiAddress(call.package)}::${call.module}`)) return false;
    const name = `${call.module}::${call.function}`;
    const swap = SWAP_CALLS.get(name);
    if (!swap) refuse(`${at} is not a derived swap function`);
    const fee = daoRoute ? null : swapFee;
    const context = name === SWAP_CONTEXT.function;
    checkDerivedCall(at, call, context && fee ? withFeeRecipient(swap, fee) : swap);
    if (context) checkSwapFee(at, call, pureBytes, fee);
    if (name === SWAP_OUTPUT && normalizeType(call.typeArguments[0] ?? "") !== quote) {
      refuse(`${at}: swap ends in ${call.typeArguments[0]}, not the sale's Quote`);
    }
    return true;
  }
  const schedules = new Map(
    (facts.vestingSchedules ?? []).map((schedule) => [
      normalizeSuiAddress(schedule.objectId),
      schedule,
    ]),
  );
  /** The registry's sender argument, when the call has one, holds the sender's address. */
  function checkSenderArgument(at: string, call: FullMoveCall, allowed: SponsorCall): void {
    if (allowed.sender === null) {
      return;
    }

    const argument = call.arguments[allowed.sender.argument];
    if (!isSender(argument)) {
      refuse(`${at} ${allowed.sender.role} ${addressOf(argument) ?? "argument"} is not the sender`);
    }
  }

  function checkRewardClaim(at: string, call: FullMoveCall, allowed: SponsorCall): void {
    const roundId = sharedObjectId(call.arguments[0]);
    const round = roundId && rounds.get(roundId);
    if (!round) refuse(`${at} round ${roundId ?? "argument"} is unknown`);
    if (normalizeSuiAddress(round.vaultPresaleId) !== presaleId) {
      refuse(
        `${at} round ${roundId} of vault ${round.vaultId} belongs to presale ${normalizeSuiAddress(round.vaultPresaleId)}`,
      );
    }
    checkSenderArgument(at, call, allowed);
  }

  function checkPresaleCall(at: string, call: FullMoveCall): void {
    const name = `${call.module}::${call.function}`;
    const allowed = calls.find((entry) => entry.target === name);
    if (!allowed) {
      refuse(`${at} is not allowed for intent ${intent}`);
    }
    const typeArguments = call.typeArguments.map(normalizeType);
    if (String(typeArguments) !== String(saleTypes)) {
      refuse(`${at} type arguments <${typeArguments}> are not <${saleTypes}>`);
    }
    // Vault calls take the round, not the presale, as argument 0.
    if (protocol === "vault") return checkRewardClaim(at, call, allowed);
    const presaleArgument = sharedObjectId(call.arguments[0]);
    if (presaleArgument !== presaleId)
      refuse(`${at} object ${presaleArgument ?? "argument"} is not presale ${presaleId}`);
    checkSenderArgument(at, call, allowed);
  }

  function checkVestingClaim(at: string, call: FullMoveCall): void {
    if (`${call.module}::${call.function}` !== VESTING_CLAIM)
      refuse(`${at} is not allowed for intent ${intent}`);
    checkDerivedCall(at, call, LINEAR_VESTING_CLAIM_CALL);
    const scheduleId = sharedObjectId(call.arguments[0]);
    const schedule = scheduleId && schedules.get(scheduleId);
    if (!schedule) refuse(`${at} vesting schedule ${scheduleId ?? "argument"} is unknown`);
    if (normalizeSuiAddress(schedule.beneficiary) !== normalizeSuiAddress(sender))
      refuse(`${at} vesting schedule ${scheduleId} does not pay the sender`);
    const coin = normalizeType(call.typeArguments[0]!);
    if (coin !== normalizeType(schedule.coinType))
      refuse(
        `${at} type argument <${coin}> is not the schedule's <${normalizeType(schedule.coinType)}>`,
      );
    if (!saleTypes.includes(coin)) refuse(`${at} vests <${coin}>, not one of the sale's coins`);
  }

  let intentCalls = 0;
  commands.forEach((command, index) => {
    if (command.$kind !== "MoveCall") return;
    const call = command.MoveCall;
    const at = `command ${index}: ${target(call)}`;
    const pkg = normalizeSuiAddress(call.package);
    if (pkg === protocolPackage) {
      checkPresaleCall(at, call);
      intentCalls += 1;
      return;
    }
    if (intent === "claim" && pkg === VESTING_PACKAGE) {
      checkVestingClaim(at, call);
      intentCalls += 1;
      return;
    }
    if (intent === "commit" && checkCommitSwap(at, call)) return;
    const framework = FRAMEWORK_CALLS.get(target(call));
    if (intent !== "commit" || !FRAMEWORK_PACKAGES.has(pkg) || !framework)
      refuse(`${at} is not allowed for intent ${intent}`);
    checkDerivedCall(at, call, framework);
  });
  if (intentCalls === 0) {
    const targets = [...calls.map((entry) => entry.target), ...(intent === "claim" ? [VESTING_CLAIM] : [])];
    refuse(`no ${targets.join(" or ")} call for intent ${intent}`);
  }
}

/**
 * Whether Blast's gas pool may pay for a `withdraw` (social UI-14, canonical
 * UI §14.2): the sender sends some of its own coins to one address. Pure, like
 * `evaluateSponsorPolicy`, and it needs no chain fact: the kind names no
 * presale, and every object it moves is the sender's. Exactly what Sui's coin
 * resolver (`coinWithBalance`) and one `TransferObjects` emit is allowed:
 *
 * - the derived framework calls (`coin::redeem_funds` from the sender's own
 *   address balance, `coin::send_funds` back to the sender, `coin::destroy_zero`,
 *   `coin::zero`), checked as for a commit;
 * - `MergeCoins` and `SplitCoins` over the sender's owned coins or earlier
 *   results, split by pure amounts;
 * - exactly one `TransferObjects`, of `SplitCoins` results only (coins, never
 *   another owned object), to a 32-byte address.
 *
 * Refused: any other Move call, `MakeMoveVec`, the gas coin, a publish or an
 * upgrade, a shared or Receiving object, and a withdrawal from anyone but the
 * sender. The recipient is any address: that is the point of a withdrawal.
 */
export function evaluateWithdrawPolicy(
  request: Readonly<{ kind: SponsorTransactionKind; sender: string }>,
): SponsorPolicyDecision {
  try {
    checkWithdraw(request.kind, request.sender);
    return { allowed: true };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return { allowed: false, code: "target_not_allowed", reason: error.message };
  }
}

function checkWithdraw(kind: SponsorTransactionKind, sender: string): void {
  const { commands, input, pureBytes, addressOf, checkDerivedCall } = kindReader(kind, sender);
  /** A coin operand: the sender's owned object or an earlier command's result. */
  const coinOperand = (at: string, argument: Argument): void => {
    if (argument.$kind === "Result" || argument.$kind === "NestedResult") return;
    const object = input(argument)?.Object;
    if (!object?.ImmOrOwnedObject)
      refuse(
        `${at} takes ${argument.$kind === "Input" ? "an input that is not an owned object" : argument.$kind}`,
      );
  };
  function checkWithdrawTransfer(
    at: string,
    transfer: NonNullable<Command["TransferObjects"]>,
  ): void {
    for (const object of transfer.objects) {
      const from =
        object.$kind === "NestedResult"
          ? object.NestedResult[0]
          : object.$kind === "Result"
            ? object.Result
            : null;
      if (from === null || !splits.has(from))
        refuse(`${at}: TransferObjects moves something that is not a split coin`);
    }
    if (transfer.objects.length !== 1) refuse(`${at}: a withdraw sends exactly one coin, not ${transfer.objects.length}`);
    if (addressOf(transfer.address) === undefined)
      refuse(`${at}: TransferObjects to something that is not a pure address`);
  }
  const splits = new Set<number>();
  let transfers = 0;
  commands.forEach((command, index) => {
    const at = `command ${index}`;
    refuseSponsorSpend(command, at);
    switch (command.$kind) {
      case "MoveCall": {
        const call = command.MoveCall;
        const pkg = normalizeSuiAddress(call.package);
        const framework = FRAMEWORK_PACKAGES.has(pkg)
          ? FRAMEWORK_CALLS.get(target(call))
          : undefined;
        if (!framework) refuse(`${at}: ${target(call)} is not allowed for intent withdraw`);
        checkDerivedCall(`${at}: ${target(call)}`, call, framework);
        return;
      }
      case "SplitCoins": {
        coinOperand(`${at}: SplitCoins`, command.SplitCoins.coin);
        checkSplitAmounts(at, command.SplitCoins.amounts, pureBytes);
        splits.add(index);
        return;
      }
      case "MergeCoins": {
        coinOperand(`${at}: MergeCoins`, command.MergeCoins.destination);
        for (const source of command.MergeCoins.sources) coinOperand(`${at}: MergeCoins`, source);
        return;
      }
      case "TransferObjects": {
        transfers += 1;
        checkWithdrawTransfer(at, command.TransferObjects);
        return;
      }
      default:
        refuse(`${at}: ${command.$kind} is not allowed for intent withdraw`);
    }
  });
  if (transfers !== 1) refuse(`a withdraw makes exactly one TransferObjects, not ${transfers}`);
  refuseSplitFanOut(commands, SPONSOR_MAX_WITHDRAW_SPLITS);
}

/** The burn's three calls (Circle's V2 PTB), each with its arity. */
const BURN_CALLS = [
  ["deposit_for_burn", "deposit_for_burn", 8],
  ["handler", "burn", 5],
  ["deposit_for_burn", "complete_burn", 3],
] as const;
const BURN_DOMAINS = new Set([0, 3, 5, 6]);
/** `cctp-forward` in 24 bytes, then version 0 (Circle's Forwarding Service hook, version 0), as hex. */
const FORWARD_MAGIC = "636374702d666f7277617264" + "0".repeat(32);

/**
 * Whether Blast's gas pool may pay for a `bridge_withdraw` (social coins,
 * withdraw to another chain): the sender burns some of its own USDC with
 * Circle's CCTP V2 for Circle's Forwarding Service to mint on another chain.
 * Pure, like `evaluateWithdrawPolicy`; the burn's ids are the deployment
 * identity's (`suiBurnIds`). The social withdrawal route builds the kind on
 * the server and is the only caller: the sponsor's HTTP route takes no
 * `bridge_withdraw` intent. Allowed, and nothing else:
 *
 * - the coin plumbing `coinWithBalance` emits for the sender's USDC: the
 *   derived framework calls, `MergeCoins` and `SplitCoins` of the sender's
 *   own coins or earlier results;
 * - then, last and in order, exactly the burn: `deposit_for_burn<USDC>` of a
 *   coin from an earlier command, to Ethereum, Arbitrum, Solana or Base, with
 *   no destination caller and the Forwarding Service's hook;
 *   `handler::burn` of its two results; `complete_burn<USDC, handler::Auth>`
 *   of its ticket — each shared object the identity's, at its initial shared
 *   version and with the mutability the signatures take.
 *
 * Refused: any other Move call, `TransferObjects`, `MakeMoveVec`, the gas
 * coin, a publish or an upgrade, and a withdrawal from anyone but the sender.
 */
export function evaluateBridgeWithdrawPolicy(
  request: Readonly<{ kind: SponsorTransactionKind; sender: string; ids: SuiBurnIds }>,
): SponsorPolicyDecision {
  try {
    checkBridgeWithdraw(request.kind, request.sender, request.ids);
    return { allowed: true };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return { allowed: false, code: "target_not_allowed", reason: error.message };
  }
}

function checkBridgeWithdraw(kind: SponsorTransactionKind, sender: string, ids: SuiBurnIds): void {
  const { commands, input, pureBytes, addressOf, checkDerivedCall } = kindReader(kind, sender);
  const tmm = normalizeSuiAddress(ids.tokenMessengerMinter);
  const handler = normalizeSuiAddress(ids.stablecoinHandler);
  const usdc = normalizeType(ids.usdcType);
  const burnAt = commands.length - BURN_CALLS.length;
  if (burnAt < 1) refuse("a bridge withdrawal is the coin, then the three burn calls");
  const coinOperand = (at: string, argument: Argument): void => {
    if (argument.$kind === "Result" || argument.$kind === "NestedResult") return;
    if (!input(argument)?.Object?.ImmOrOwnedObject)
      refuse(`${at} takes something that is not the sender's coin or a result`);
  };
  const sharedIs = (
    at: string,
    argument: Argument | undefined,
    object: SuiBurnIds["tmmState"],
    mutable: boolean,
  ): void => {
    const ref = input(argument)?.Object?.SharedObject;
    if (
      !ref ||
      normalizeSuiAddress(ref.objectId) !== normalizeSuiAddress(object.objectId) ||
      String(ref.initialSharedVersion) !== object.initialSharedVersion ||
      ref.mutable !== mutable
    ) {
      refuse(`${at} is not the identity's object ${normalizeSuiAddress(object.objectId)}`);
    }
  };
  const resultOf = (
    at: string,
    argument: Argument | undefined,
    command: number,
    index: number,
  ): void => {
    if (
      argument?.$kind !== "NestedResult" ||
      argument.NestedResult[0] !== command ||
      argument.NestedResult[1] !== index
    ) {
      refuse(`${at} is not result ${index} of command ${command}`);
    }
  };
  const u32Of = (argument: Argument | undefined): number | undefined => {
    const bytes = pureBytes(argument);
    return bytes?.length === 4
      ? new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true)
      : undefined;
  };

  function checkBurnCall(command: Command, index: number): void {
    const at = `command ${index}`;
    const [module, fn, arity] = BURN_CALLS[index - burnAt]!;
    const call = command.MoveCall;
    const pkg = index - burnAt === 1 ? handler : tmm;
    if (
      !call ||
      normalizeSuiAddress(call.package) !== pkg ||
      call.module !== module ||
      call.function !== fn
    ) {
      refuse(`${at} is not ${pkg}::${module}::${fn}`);
    }
    if (call.arguments.length !== arity)
      refuse(`${at} takes ${call.arguments.length} arguments, not ${arity}`);
  }

  commands.forEach((command, index) => {
    const at = `command ${index}`;
    refuseSponsorSpend(command, at);
    if (index >= burnAt) {
      checkBurnCall(command, index);
      return;
    }
    switch (command.$kind) {
      case "MoveCall": {
        const call = command.MoveCall;
        const framework = FRAMEWORK_PACKAGES.has(normalizeSuiAddress(call.package))
          ? FRAMEWORK_CALLS.get(target(call))
          : undefined;
        if (!framework) refuse(`${at}: ${target(call)} is not allowed for intent bridge_withdraw`);
        checkDerivedCall(`${at}: ${target(call)}`, call, framework);
        return;
      }
      case "SplitCoins":
        coinOperand(`${at}: SplitCoins`, command.SplitCoins.coin);
        checkSplitAmounts(at, command.SplitCoins.amounts, pureBytes);
        return;
      case "MergeCoins":
        coinOperand(`${at}: MergeCoins`, command.MergeCoins.destination);
        for (const source of command.MergeCoins.sources) coinOperand(`${at}: MergeCoins`, source);
        return;
      default:
        refuse(`${at}: ${command.$kind} is not allowed for intent bridge_withdraw`);
    }
  });

  const [deposit, burn, complete] = commands.slice(burnAt).map((command) => command.MoveCall!);
  const types = (call: NonNullable<Command["MoveCall"]>) => call.typeArguments.map(normalizeType);
  if (String(types(deposit!)) !== String([usdc])) refuse(`deposit_for_burn's type is not ${usdc}`);
  if (burn!.typeArguments.length !== 0) refuse("handler::burn takes no type argument");
  if (String(types(complete!)) !== String([usdc, normalizeType(`${handler}::handler::Auth`)]))
    refuse("complete_burn's types are not USDC and the handler's Auth");

  checkBurnDeposit(deposit!, burnAt, { pureBytes, addressOf, u32Of });
  sharedIs("deposit_for_burn's state", deposit!.arguments[7], ids.tmmState, false);

  const at = burnAt;
  sharedIs("handler::burn's state", burn!.arguments[0], ids.handlerState, false);
  resultOf("handler::burn's receipt", burn!.arguments[1], at, 0);
  resultOf("handler::burn's coin", burn!.arguments[2], at, 1);
  sharedIs("handler::burn's deny list", burn!.arguments[3], ids.denyList, false);
  sharedIs("handler::burn's treasury", burn!.arguments[4], ids.usdcTreasury, true);

  resultOf("complete_burn's ticket", complete!.arguments[0], at + 1, 0);
  sharedIs("complete_burn's state", complete!.arguments[1], ids.tmmState, false);
  sharedIs("complete_burn's message transmitter", complete!.arguments[2], ids.mtState, false);
}

function checkBurnDeposit(
  deposit: FullMoveCall,
  burnAt: number,
  reader: Pick<KindReader, "pureBytes" | "addressOf"> & {
    u32Of(argument: Argument | undefined): number | undefined;
  },
): void {
  const { pureBytes, addressOf, u32Of } = reader;
  const [coin, domain, recipient, caller, maxFee, finality, hook] = deposit.arguments;
  const source =
    coin?.$kind === "NestedResult"
      ? coin.NestedResult[0]
      : coin?.$kind === "Result"
        ? coin.Result
        : null;
  if (source === null || source >= burnAt)
    refuse("deposit_for_burn burns something that is not an earlier command's coin");
  if (!BURN_DOMAINS.has(u32Of(domain) ?? -1))
    refuse("deposit_for_burn's destination is not Ethereum, Arbitrum, Solana or Base");
  const mintRecipient = addressOf(recipient);
  if (mintRecipient === undefined || BigInt(mintRecipient) === 0n)
    refuse("deposit_for_burn's mint recipient is not a nonzero address");
  if (addressOf(caller) !== normalizeSuiAddress("0x0"))
    refuse("deposit_for_burn names a destination caller");
  if (pureBytes(maxFee)?.length !== 32) refuse("deposit_for_burn's max fee is not a pure u256");
  // Standard only: Circle lists Sui's Fast Transfer as N/A (`WITHDRAW_FINALITY_THRESHOLD`).
  if (u32Of(finality) !== 2000) refuse("deposit_for_burn's finality is not Standard");
  checkForwardHook(pureBytes(hook), u32Of(domain));
}

function checkForwardHook(hookBytes: Uint8Array | undefined, domain: number | undefined): void {
  // Solana's hook asks Circle to set up the recipient's token account (65 bytes); an EVM chain's is the bare 32.
  if (hookBytes?.[0] !== (domain === 5 ? 65 : 32))
    refuse("deposit_for_burn's hook does not fit its destination");
  // `vector<u8>`: a ULEB128 length, then the hook (32 bytes, or 65 for Solana's account setup).
  const hookHex = hookBytes && hookBytes.length > 1 ? toHex(hookBytes.subarray(1)) : "";
  if (
    !hookHex.startsWith(FORWARD_MAGIC) ||
    (hookBytes![0] !== 32 && hookBytes![0] !== 65) ||
    hookBytes!.length - 1 !== hookBytes![0]
  ) {
    refuse("deposit_for_burn's hook is not the Forwarding Service's");
  }
  const tail = hookHex.slice(56, 64);
  if (hookBytes![0] === 32 ? tail !== "00000000" : tail !== "00000021")
    refuse("deposit_for_burn's hook is not the Forwarding Service's");
}

/**
 * Whether Blast's gas pool may pay for a `trade` (social feed R3-31): a swap
 * of the sender's own coins through the Cetus aggregator, delivered to the
 * sender. Pure, like `evaluateSponsorPolicy`. The social swap path builds the
 * kind on the server from the quote it pinned, and is the only caller: the
 * sponsor's HTTP route takes no `trade` intent. Allowed, and nothing else:
 *
 * - the derived swap functions (`swap-calls.ts`) of a configured swap target,
 *   each checked as for a swap-and-commit, with a zero fee rate to `0x0` —
 *   or, when Blast charges its app fee (`fee`, `BLAST_TRADE_FEE_BPS`), the
 *   swap context's fee at exactly that rate to exactly its receiver (the
 *   aggregator splits it off the swap's output inside `confirm_swap_v3`;
 *   no command of the kind moves it), and no swap context without it;
 * - Aftermath's DAO-fee swap (`aftermath-dao.ts`), pinned whole; a kind that
 *   calls it carries Blast's fee itself, so its swap contexts (a USDC ↔ SUI
 *   leg) take a zero fee to `0x0`, and with a fee configured it may make one
 *   `TransferObjects` to exactly the fee receiver, of coins split only from a
 *   swap's output (the DAO swap's or `confirm_swap_v3`'s);
 * - the derived framework calls the coin resolver emits (`framework-calls.ts`);
 * - `SplitCoins` and `MergeCoins` of the sender's own coins or earlier results;
 * - `TransferObjects` to the sender, and only that fee transfer besides.
 *
 * It must swap (`router::confirm_swap_v3` or the DAO-fee swap at least once). Refused: any other
 * Move call (a presale's included), `MakeMoveVec`, the gas coin, a publish or
 * an upgrade, a shared or receiving object outside a derived position, and a
 * withdrawal from anyone but the sender.
 */
export function evaluateTradePolicy(
  request: Readonly<{
    kind: SponsorTransactionKind;
    sender: string;
    swapTargets: readonly SponsorSwapTarget[];
    /** Blast's app fee as the deployment configures it; null for none. */
    fee: BlastTradeFee | null;
  }>,
): SponsorPolicyDecision {
  try {
    checkTrade(request.kind, request.sender, request.swapTargets, request.fee);
    return { allowed: true };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return { allowed: false, code: "target_not_allowed", reason: error.message };
  }
}

/**
 * The derived swap context with Blast's fee receiver in place of the derived
 * `0x0`: the one address besides the sender a trade's swap may name, and
 * only at the fee recipient's position.
 */
function withFeeRecipient(derived: SponsorDerivedCall, fee: BlastTradeFee): SponsorDerivedCall {
  const fixed = derived.fixedArguments.filter(
    ({ position }) => position !== SWAP_CONTEXT.feeRecipient,
  );
  if (fixed.length !== derived.fixedArguments.length - 1)
    refuse(`${SWAP_CONTEXT.function} has no derived fee recipient`);
  return {
    ...derived,
    fixedArguments: [
      ...fixed,
      { position: SWAP_CONTEXT.feeRecipient, value: normalizeSuiAddress(fee.receiver) },
    ],
  };
}

/** Whether a call is Aftermath's DAO-fee swap: the pinned package, module and function. */
function isAftermathDaoSwap(call: MoveCall): boolean {
  return (
    normalizeSuiAddress(call.package) === AFTERMATH_DAO_PACKAGE &&
    `${call.module}::${call.function}` === AFTERMATH_DAO_SWAP_CALL.target
  );
}

/** The command an argument is the result of; null for an input or the gas coin. */
function resultCommand(argument: Argument): number | null {
  return argument.$kind === "NestedResult"
    ? argument.NestedResult[0]
    : argument.$kind === "Result"
      ? argument.Result
      : null;
}

function checkTrade(
  kind: SponsorTransactionKind,
  sender: string,
  targets: readonly SponsorSwapTarget[],
  blastFee: BlastTradeFee | null,
): void {
  const { commands, input, isSender, addressOf, pureBytes, checkDerivedCall } = kindReader(
    kind,
    sender,
  );
  // A kind with the DAO-fee swap takes Blast's fee itself (`social/trades/aftermath.ts`), never in a swap context.
  const daoRoute = commands.some(
    (command) => command.$kind === "MoveCall" && isAftermathDaoSwap(command.MoveCall),
  );
  const contextFee = daoRoute ? null : blastFee;
  const feeReceiver = blastFee && daoRoute ? normalizeSuiAddress(blastFee.receiver) : null;
  /** Commands whose result is a swap's output coin, and splits of one. */
  const swapOutputs = new Set<number>();
  const outputSplits = new Set<number>();
  let feeTransfers = 0;
  const swapTargets = new Set(
    targets.map(({ packageId, module }) => {
      const pkg = normalizeSuiAddress(packageId);
      if (FRAMEWORK_PACKAGES.has(pkg)) refuse(`framework package ${pkg} is not a swap target`);
      return `${pkg}::${module}`;
    }),
  );
  const coinOperand = (at: string, argument: Argument): void => {
    if (argument.$kind === "Result" || argument.$kind === "NestedResult") return;
    if (!input(argument)?.Object?.ImmOrOwnedObject)
      refuse(`${at} takes something that is not the sender's coin or a result`);
  };
  function checkTradeCall(at: string, call: FullMoveCall): boolean {
    const pkg = normalizeSuiAddress(call.package);
    const name = `${call.module}::${call.function}`;
    const where = `${at}: ${target(call)}`;
    if (isAftermathDaoSwap(call)) {
      checkDerivedCall(where, call, AFTERMATH_DAO_SWAP_CALL);
      return true;
    }
    if (swapTargets.has(`${pkg}::${call.module}`)) {
      const swap = SWAP_CALLS.get(name);
      if (!swap) refuse(`${where} is not a derived swap function`);
      const context = name === SWAP_CONTEXT.function;
      checkDerivedCall(
        where,
        call,
        context && contextFee ? withFeeRecipient(swap, contextFee) : swap,
      );
      if (context) checkSwapFee(where, call, pureBytes, contextFee);
      return name === SWAP_OUTPUT;
    }
    const framework = FRAMEWORK_PACKAGES.has(pkg) ? FRAMEWORK_CALLS.get(target(call)) : undefined;
    if (!framework) refuse(`${where} is not allowed for intent trade`);
    checkDerivedCall(where, call, framework);
    return false;
  }

  function checkTradeTransfer(at: string, transfer: NonNullable<Command["TransferObjects"]>): void {
    if (isSender(transfer.address)) return;
    if (feeReceiver === null || addressOf(transfer.address) !== feeReceiver) {
      refuse(`${at}: TransferObjects to an address that is not the sender`);
    }
    feeTransfers += 1;
    if (feeTransfers > 1) refuse(`${at}: a second TransferObjects to Blast's fee receiver`);
    for (const object of transfer.objects) {
      const from = resultCommand(object);
      if (from === null || !outputSplits.has(from))
        refuse(`${at}: Blast's fee is not a coin split from a swap's output`);
    }
  }

  let swaps = 0;
  commands.forEach((command, index) => {
    const at = `command ${index}`;
    refuseSponsorSpend(command, at);
    switch (command.$kind) {
      case "MoveCall": {
        if (checkTradeCall(at, command.MoveCall)) {
          swapOutputs.add(index);
          swaps += 1;
        }
        return;
      }
      case "SplitCoins": {
        coinOperand(`${at}: SplitCoins`, command.SplitCoins.coin);
        checkSplitAmounts(at, command.SplitCoins.amounts, pureBytes);
        const source = resultCommand(command.SplitCoins.coin);
        if (source !== null && swapOutputs.has(source)) outputSplits.add(index);
        return;
      }
      case "MergeCoins":
        coinOperand(`${at}: MergeCoins`, command.MergeCoins.destination);
        for (const source of command.MergeCoins.sources) coinOperand(`${at}: MergeCoins`, source);
        return;
      case "TransferObjects": {
        checkTradeTransfer(at, command.TransferObjects);
        return;
      }
      default:
        refuse(`${at}: ${command.$kind} is not allowed for intent trade`);
    }
  });
  if (swaps === 0)
    refuse(`a trade calls ${SWAP_OUTPUT} or ${AFTERMATH_DAO_SWAP_CALL.target} at least once`);
}

function checkSplitAmounts(
  at: string,
  amounts: readonly Argument[],
  pureBytes: KindReader["pureBytes"],
): void {
  for (const amount of amounts) {
    if (pureBytes(amount)?.length !== 8) refuse(`${at}: SplitCoins amount is not a pure u64`);
  }
}

function checkSwapFee(
  at: string,
  call: FullMoveCall,
  pureBytes: KindReader["pureBytes"],
  contextFee: BlastTradeFee | null,
): void {
  const rate = pureBytes(call.arguments[SWAP_CONTEXT.feeRate]);
  const fee =
    rate?.length === 4 ? new DataView(rate.buffer, rate.byteOffset).getUint32(0, true) : undefined;
  const expected = contextFee?.ppm ?? 0;
  if (fee === undefined) refuse(`${at} fee rate is not a literal u32`);
  if (fee !== expected)
    refuse(`${at} fee rate ${fee} ppm is not ${contextFee ? `Blast's ${expected} ppm` : "zero"}`);
}

/**
 * The `Round` objects a kind's `holder_rewards::claim` calls name, so the
 * caller can resolve each one's vault and that vault's presale before
 * evaluating a `reward_claim`.
 */
export function referencedRewardRounds(
  kind: SponsorTransactionKind,
  vaultPackageId: string,
): string[] {
  const { inputs = [], commands = [] } = kind.ProgrammableTransaction ?? {};
  const vaultPackage = normalizeSuiAddress(vaultPackageId);
  const rounds = new Set<string>();
  for (const call of commands.map((command) => command.MoveCall)) {
    if (!call || normalizeSuiAddress(call.package) !== vaultPackage) continue;
    if (`${call.module}::${call.function}` !== SPONSOR_INTENTS.reward_claim.policy.calls[0].target) continue;
    const argument = call.arguments[0];
    const round =
      argument?.$kind === "Input" ? inputs[argument.Input]?.Object?.SharedObject : undefined;
    if (round) rounds.add(normalizeSuiAddress(round.objectId));
  }
  return [...rounds];
}

/**
 * The schedules a kind's `blast_fun_linear_vesting::claim` calls name, so the
 * caller can read each one (its coin and beneficiary) before evaluating a
 * `claim`.
 */
export function referencedVestingSchedules(kind: SponsorTransactionKind): string[] {
  const { inputs = [], commands = [] } = kind.ProgrammableTransaction ?? {};
  const schedules = new Set<string>();
  for (const call of commands.map((command) => command.MoveCall)) {
    if (
      !call ||
      normalizeSuiAddress(call.package) !== VESTING_PACKAGE ||
      `${call.module}::${call.function}` !== VESTING_CLAIM
    )
      continue;
    const argument = call.arguments[0];
    const schedule =
      argument?.$kind === "Input" ? inputs[argument.Input]?.Object?.SharedObject : undefined;
    if (schedule) schedules.add(normalizeSuiAddress(schedule.objectId));
  }
  return [...schedules];
}

/** The environment variable holding the Cetus swap targets the commit intent sponsors. */
export const SWAP_TARGETS_ENV = "PRESALE_SPONSOR_SWAP_TARGETS";

/**
 * Parses `PRESALE_SPONSOR_SWAP_TARGETS`: comma-separated `<package>::<module>`
 * entries, such as the Cetus aggregator's `router` and each DEX adapter module
 * its routes call. A configured module admits only its functions derived in
 * `swap-calls.ts`. Unset or blank permits no configured modules in client-supplied
 * kinds. Server-built trades do not use this allowlist. Framework
 * packages are refused here and again by the policy: their functions come only
 * from the derived framework list.
 */
export function parseSwapTargets(value: string | undefined): SponsorSwapTarget[] {
  const targets = new Map<string, SponsorSwapTarget>();
  for (const entry of (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const parsed = z
      .string()
      .regex(/^(0x[0-9a-fA-F]{1,64})::([A-Za-z][A-Za-z0-9_]*)$/)
      .safeParse(entry);
    const match = parsed.success ? parsed.data.split("::") : null;
    const packageId = match && normalizeSuiAddress(match[0]);
    if (!match || !packageId)
      throw new Error(`${SWAP_TARGETS_ENV}: "${entry}" is not <package>::<module>`);
    if (FRAMEWORK_PACKAGES.has(packageId))
      throw new Error(`${SWAP_TARGETS_ENV}: "${entry}" is a framework package`);
    targets.set(`${packageId}::${match[1]}`, { packageId, module: match[1] });
  }
  return [...targets.values()];
}

function commandArguments(command: Command): Argument[] {
  switch (command.$kind) {
    case "MoveCall":
      return command.MoveCall.arguments;
    case "TransferObjects":
      return [...command.TransferObjects.objects, command.TransferObjects.address];
    case "SplitCoins":
      return [command.SplitCoins.coin, ...command.SplitCoins.amounts];
    case "MergeCoins":
      return [command.MergeCoins.destination, ...command.MergeCoins.sources];
    case "MakeMoveVec":
      return command.MakeMoveVec.elements;
    case "Upgrade":
      return [command.Upgrade.ticket];
    case "Publish":
      return [];
  }
}

function normalizeType(type: string): string {
  try {
    return normalizeTypeTag(type);
  } catch {
    return refuse(`type ${type} is malformed`);
  }
}

function target(call: MoveCall): string {
  return `${normalizeSuiAddress(call.package)}::${call.module}::${call.function}`;
}

function refuse(reason: string): never {
  throw new Refusal(reason);
}
