import { bcs } from "@mysten/sui/bcs";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { fromBase64, normalizeStructTag, toHex } from "@mysten/sui/utils";
import { z } from "zod";
import { AFTERMATH_DAO_SWAP_CALL } from "../sponsor/aftermath-dao.ts";
import { SWAP_CONTEXT, SWAP_OUTPUT } from "../sponsor/cetus-router.ts";
import type { FrontendFeePolicy } from "./contracts.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

const CETUS_CONFIRM_EVENTS = new Set([
  "0xffd4058af7d6f6d66c335930cced8c91e38ec943e2392232aee27e8127e684e9::router::ConfirmSwapEventV3",
  "0x33ec64e9bb369bf045ddc198c81adbf2acab424da37465d95296ee02045d2b17::router::ConfirmSwapEvent",
]);

const ZERO_FEE_RATE = bcs.u32().serialize(0).toBase64();

export type FrontendFee = {
  id: string;
  venue: "cetus" | "aftermath";
  coin: string;
  amount: bigint;
};

const cetusFee = z.object({
  fee_recipient: z.string().regex(SUI_OBJECT_ID_PATTERN),
  fee_amount: z.string().regex(/^(0|[1-9][0-9]{0,19})$/).transform(BigInt)
    .refine((value) => value <= 18_446_744_073_709_551_615n),
  target: z.string(),
});

export function readCetusFee(
  digest: string,
  index: number,
  type: string,
  emitter: string,
  json: unknown,
  policy: FrontendFeePolicy,
): FrontendFee | null {
  if (!CETUS_CONFIRM_EVENTS.has(type)) {
    if (policy.cetus_packages.includes(emitter) && type.includes("::router::ConfirmSwapEvent")) {
      throw new Error("Unsupported Cetus fee receipt version");
    }
    return null;
  }
  const fee = cetusFee.parse(json);
  if (!policy.receivers.includes(fee.fee_recipient) || fee.fee_amount === 0n) return null;
  if (!policy.cetus_packages.includes(emitter)) throw new Error("Unreviewed Cetus fee receipt emitter");
  return {
    id: `${digest}:event:${index}`,
    venue: "cetus",
    coin: normalizeStructTag(fee.target),
    amount: fee.fee_amount,
  };
}

type Ptb = NonNullable<(typeof bcs.TransactionKind.$inferType)["ProgrammableTransaction"]>;
type Argument = NonNullable<Ptb["commands"][number]["MoveCall"]>["arguments"][number];
type MoveCall = NonNullable<Ptb["commands"][number]["MoveCall"]>;

function sourceCommand(argument: Argument | undefined): number | undefined {
  if (argument?.$kind === "Result") return argument.Result;
  if (argument?.$kind === "NestedResult" && argument.NestedResult[1] === 0) return argument.NestedResult[0];
}

function target(call: MoveCall): string {
  return `${call.module}::${call.function}`;
}

/** The DAO swap that a fee-free Cetus suffix at `index` consumes, if any. */
function cetusSuffixDao(
  ptb: Ptb,
  index: number,
  call: MoveCall,
  policy: FrontendFeePolicy,
): MoveCall | undefined {
  const { inputs, commands } = ptb;
  if (target(call) !== SWAP_OUTPUT || !policy.cetus_packages.includes(call.package)) return;
  const contextIndex = sourceCommand(call.arguments[0]);
  if (contextIndex === undefined || contextIndex >= index) return;
  const context = commands[contextIndex]?.MoveCall;
  if (!context || context.package !== call.package || target(context) !== SWAP_CONTEXT.function) return;
  const rate = context.arguments[SWAP_CONTEXT.feeRate];
  if (rate?.$kind !== "Input" || inputs[rate.Input]?.Pure?.bytes !== ZERO_FEE_RATE) return;
  const daoIndex = sourceCommand(context.arguments[SWAP_CONTEXT.inputCoin]);
  if (daoIndex === undefined || daoIndex >= contextIndex) return;
  const preceding = commands[daoIndex]?.MoveCall;
  if (!preceding || context.typeArguments[0] !== preceding.typeArguments[2] ||
      context.typeArguments[1] !== call.typeArguments[0]) return;
  return preceding;
}

function isReviewedDaoSwap(ptb: Ptb, dao: MoveCall, policy: FrontendFeePolicy): boolean {
  if (dao.package !== policy.aftermath_package ||
      target(dao) !== AFTERMATH_DAO_SWAP_CALL.target ||
      dao.arguments.length !== AFTERMATH_DAO_SWAP_CALL.argumentCount ||
      dao.typeArguments.length !== AFTERMATH_DAO_SWAP_CALL.typeArgumentCount) return false;
  return AFTERMATH_DAO_SWAP_CALL.sharedObjects.every(({ position, objectId }) => {
    const arg = dao.arguments[position];
    const shared = arg?.$kind === "Input" ? ptb.inputs[arg.Input]?.Object?.SharedObject : undefined;
    if (!shared) return false;
    return objectId === null || shared.objectId === objectId;
  });
}

/** The swap output is the DAO result, or a fee-free Cetus suffix consuming that result. */
function aftermathOutput(
  ptb: Ptb,
  index: number,
  policy: FrontendFeePolicy,
): string | undefined {
  const call = ptb.commands[index]?.MoveCall;
  if (!call) return;
  const direct = target(call) === AFTERMATH_DAO_SWAP_CALL.target;
  const dao = direct ? call : cetusSuffixDao(ptb, index, call, policy);
  if (!dao || !isReviewedDaoSwap(ptb, dao, policy)) return;
  return direct ? dao.typeArguments[2] : call.typeArguments[0];
}

/** Call only for successful finalized effects. A successful PTB executed the
 * literal split and transfer atomically, even when a separate address paid gas. */
export function readAftermathFees(
  digest: string,
  transactionBcs: string,
  policy: FrontendFeePolicy,
): FrontendFee[] {
  const bytes = fromBase64(transactionBcs);
  if (TransactionDataBuilder.getDigestFromBytes(bytes) !== digest) {
    throw new Error("Frontend fee transaction bytes do not match the finalized digest");
  }
  if (!policy.aftermath_package) return [];
  const ptb = bcs.TransactionData.parse(bytes).V1?.kind.ProgrammableTransaction;
  if (!ptb) return [];
  const { inputs, commands } = ptb;
  return commands.flatMap((command, index) => {
    const transfer = command.TransferObjects;
    if (!transfer || transfer.address.$kind !== "Input" || transfer.objects.length !== 1) return [];
    const recipient = inputs[transfer.address.Input]?.Pure;
    if (!recipient || !policy.receivers.includes(`0x${toHex(fromBase64(recipient.bytes))}`)) return [];
    const transferred = transfer.objects[0];
    if (sourceCommand(transferred) !== index - 1) return [];
    const split = commands[index - 1]?.SplitCoins;
    if (!split || split.amounts.length !== 1 || split.amounts[0]?.$kind !== "Input") return [];
    const output = sourceCommand(split.coin);
    // The builder immediately splits from its final swap result.
    if (output === undefined || output !== index - 2) return [];
    const coin = aftermathOutput(ptb, output, policy);
    if (!coin) return [];
    const amountBytes = inputs[split.amounts[0].Input]?.Pure;
    if (!amountBytes) return [];
    const atoms = fromBase64(amountBytes.bytes);
    if (atoms.length !== 8) return [];
    const amount = BigInt(bcs.u64().parse(atoms));
    return amount > 0n
      ? [{ id: `${digest}:command:${index}`, venue: "aftermath", coin: normalizeStructTag(coin), amount }]
      : [];
  });
}
