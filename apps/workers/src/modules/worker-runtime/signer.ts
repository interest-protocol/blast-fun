import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";

export const MAX_RECORDS_PER_TRANSACTION = 32;
export const MAX_GAS_BUDGET_MIST = 50_000_000_000_000n;

export function gasBudgetFor(perRecordMist: bigint, records: number): bigint {
  if (!Number.isSafeInteger(records) || records < 1 || records > MAX_RECORDS_PER_TRANSACTION || perRecordMist <= 0n)
    throw new SignerRefusal("invalid gas budget");
  const total = perRecordMist * BigInt(records);
  return total < MAX_GAS_BUDGET_MIST ? total : MAX_GAS_BUDGET_MIST;
}

export type SignedTransaction = Readonly<{ digest: string; signature: string }>;

export class SignerRefusal extends Error {
  readonly code = "signer-refused";
  readonly reason: string;
  constructor(reason: string) {
    super(`Worker signature refused: ${reason}.`);
    this.name = "SignerRefusal";
    this.reason = reason;
  }
}

export type TransactionData = ReturnType<Transaction["getData"]>;

export type AddressBalanceEnvelope = Readonly<{
  /** The signing key's address. */
  sender: string;
  /** The most gas, in MIST, the bytes may name. */
  gasBudgetMist: bigint;
  /** The deployment's chain: the only one the expiration may name. */
  chainIdentifier: string;
  /** `"allowed"` lets inputs withdraw from the sender's address balance; the caller then binds each one. */
  withdrawals?: "allowed";
}>;

/**
 * The bytes' data, refused unless they are what `payFromAddressBalance` built
 * for `envelope.sender`: sent and paid by the sender within the gas budget,
 * no gas payment object and no command naming the gas coin, a `ValidDuring`
 * expiration for one epoch on the deployment's chain, and no balance
 * withdrawal unless allowed. Every worker signer runs this before its own
 * job-specific checks.
 */
export function assertAddressBalanceEnvelope(bytes: Uint8Array, envelope: AddressBalanceEnvelope): TransactionData {
  let data: TransactionData;
  try {
    data = Transaction.from(bytes).getData();
  } catch {
    throw new SignerRefusal("unreadable transaction bytes");
  }
  const sender = normalizeSuiAddress(envelope.sender);
  if (!data.sender || normalizeSuiAddress(data.sender) !== sender) {
    throw new SignerRefusal("another sender");
  }
  if (data.gasData.owner && normalizeSuiAddress(data.gasData.owner) !== sender) {
    throw new SignerRefusal("another gas owner");
  }
  const budget = data.gasData.budget;
  if (budget === null || budget === undefined || BigInt(budget) <= 0n || BigInt(budget) > envelope.gasBudgetMist) {
    throw new SignerRefusal("a gas budget that is zero or above the configured cap");
  }
  if ((data.gasData.payment ?? []).length > 0) {
    throw new SignerRefusal("a gas coin payment");
  }
  if (data.commands.some((command) => JSON.stringify(command).includes('"GasCoin"'))) {
    throw new SignerRefusal("a command that uses the gas coin");
  }
  const expiration = data.expiration?.ValidDuring;
  if (
    !expiration ||
    expiration.minEpoch === null ||
    expiration.minEpoch !== expiration.maxEpoch ||
    expiration.minTimestamp !== null ||
    expiration.maxTimestamp !== null ||
    expiration.chain !== envelope.chainIdentifier
  ) {
    throw new SignerRefusal("an expiration other than one epoch on the deployment chain");
  }
  if (envelope.withdrawals !== "allowed" && data.inputs.some((input) => input.$kind === "FundsWithdrawal")) {
    throw new SignerRefusal("a balance withdrawal");
  }
  return data;
}
