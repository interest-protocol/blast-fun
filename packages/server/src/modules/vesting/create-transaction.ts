import {
  Transaction,
  type TransactionObjectArgument,
} from "@mysten/sui/transactions";
import {
  VestingCalls,
  validateLinearSchedule,
  validateCheckpointSchedule,
} from "@interest-protocol/blast-util-sdk/vesting";
import { VESTING_DEPLOYMENT, type CreateVesting } from "@blast/core/modules/vesting/model.ts";

const calls = new VestingCalls(VESTING_DEPLOYMENT);

/** Every creation is sponsored, so SUI principal comes from the sender's own coins, never the sponsor's gas coin. */
export function createVestingTransaction(
  intent: CreateVesting,
  now: bigint,
): Transaction {
  const tx = new Transaction();
  const totalAmount = BigInt(intent.total);
  const funds = tx.coin({
    type: intent.coinType,
    balance: totalAmount,
    useGasCoin: false,
  });
  const common = {
    coinType: intent.coinType,
    beneficiary: intent.beneficiary,
    funds,
  };
  const cancel =
    intent.refundRecipient && intent.cancelCapRecipient
      ? {
          refundRecipient: intent.refundRecipient,
          cancelCapRecipient: intent.cancelCapRecipient,
        }
      : null;
  let vesting: TransactionObjectArgument;
  if (intent.schedule.kind === "linear") {
    const terms = intent.schedule;
    const schedule = {
      startMs: BigInt(terms.start_ms),
      cliffMs: BigInt(terms.cliff_ms),
      periodMs: BigInt(terms.period_ms),
      periods: BigInt(terms.periods),
    };
    validateLinearSchedule(schedule, now);
    if (cancel) {
      const result = tx.add(
        calls.newLinearCancelable({ ...common, schedule, ...cancel }),
      );
      vesting = result[0]!;
      tx.transferObjects([result[1]!], cancel.cancelCapRecipient);
    } else {
      vesting = tx.add(calls.newLinearIrrevocable({ ...common, schedule }));
    }
  } else {
    const checkpoints = intent.schedule.checkpoints.map((point) => ({
      timestampMs: BigInt(point.timestamp_ms),
      cumulativeAmount: BigInt(point.cumulative_amount),
    }));
    validateCheckpointSchedule(checkpoints, totalAmount, now);
    const schedule = tx.add(calls.newCheckpointSchedule());
    for (const checkpoint of checkpoints)
      tx.add(calls.addCheckpoint({ schedule, checkpoint }));
    if (cancel) {
      const result = tx.add(
        calls.newCheckpointCancelable({ ...common, schedule, ...cancel }),
      );
      vesting = result[0]!;
      tx.transferObjects([result[1]!], cancel.cancelCapRecipient);
    } else {
      vesting = tx.add(calls.newCheckpointIrrevocable({ ...common, schedule }));
    }
  }
  tx.add(
    calls.share({
      kind: intent.schedule.kind,
      coinType: intent.coinType,
      vesting,
    }),
  );
  return tx;
}
