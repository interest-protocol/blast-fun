const MAX_U64 = 18446744073709551615n;

type Environment = Readonly<Record<string, string | undefined>>;

/** Operator-approved bound; unset keeps positive creation fees disabled. */
export function bluefinCreationFeeCap(environment: Environment): bigint {
  const value = environment.BLAST_WORKER_BLUEFIN_CREATION_FEE_CAP_MIST?.trim() ?? "0";
  if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > MAX_U64) {
    throw new Error("BLAST_WORKER_BLUEFIN_CREATION_FEE_CAP_MIST must be u64 MIST.");
  }
  return BigInt(value);
}

export function permittedBluefinFee(fee: bigint, cap: bigint): boolean {
  return fee >= 0n && fee <= MAX_U64 && fee <= cap;
}

export class BluefinFeeRefusal extends Error {}

export function requireBluefinFee(value: unknown, cap: bigint): bigint {
  if (typeof value !== "bigint") throw new BluefinFeeRefusal("bluefin-fee-unreadable");
  if (!permittedBluefinFee(value, cap)) throw new BluefinFeeRefusal("creation-fee-exceeds-cap");
  return value;
}
