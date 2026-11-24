// Every worker key pays gas from its SUI address balance: no gas coin, and a
// `ValidDuring` expiration for one epoch on this chain with a random nonce.
// Nothing owned remains for two transactions to equivocate over: the
// expiration bounds the bytes to the epoch they were built in, and the nonce
// keeps two otherwise identical transactions apart. A key is funded by sending
// SUI to its address balance (`0x2::coin::send_funds`); coin objects at its
// address never pay.

import { SUI_COIN_TYPE as SUI } from "@blast/core/lib/sui/coin-types.ts";
import { randomInt } from "node:crypto";

import type { ClientWithCoreApi } from "@mysten/sui/client";
import type { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag } from "@mysten/sui/utils";

import type { Provider } from "./provider.ts";

type TransactionData = ReturnType<Transaction["getData"]>;

/** The SUI, in MIST, the transaction's inputs withdraw from the sender's address balance besides gas. */
function suiWithdrawalMist(data: TransactionData): bigint {
  let total = 0n;
  for (const input of data.inputs) {
    const withdrawal = input.FundsWithdrawal;
    if (!withdrawal || withdrawal.withdrawFrom.$kind !== "Sender") continue;
    if (normalizeStructTag(withdrawal.typeArg.Balance) !== SUI) continue;
    total += BigInt(withdrawal.reservation.MaxAmountU64);
  }
  return total;
}

const chains = new WeakMap<ClientWithCoreApi, string>();

/** The chain identifier a `ValidDuring` expiration names, read once per client. */
export async function chainIdentifier(client: ClientWithCoreApi, provider: Provider): Promise<string> {
  const known = chains.get(client);
  if (known !== undefined) return known;
  const { chainIdentifier: chain } = await provider((signal) => client.core.getChainIdentifier({ signal }));
  chains.set(client, chain);
  return chain;
}

/**
 * Sets `transaction`'s sender, gas budget and price, no gas payment (the
 * sender's address balance pays) and a `ValidDuring` expiration for `epoch`
 * alone on `chain`, with a random nonce.
 */
export function payFromAddressBalance(
  transaction: Transaction,
  gas: Readonly<{ sender: string; gasBudgetMist: bigint; referenceGasPrice: bigint; epoch: string; chain: string }>,
): void {
  transaction.setSender(gas.sender);
  transaction.setGasBudget(gas.gasBudgetMist);
  transaction.setGasPrice(gas.referenceGasPrice);
  transaction.setGasPayment([]);
  transaction.setExpiration({
    ValidDuring: {
      minEpoch: gas.epoch,
      maxEpoch: gas.epoch,
      minTimestamp: null,
      maxTimestamp: null,
      chain: gas.chain,
      nonce: randomInt(2 ** 32),
    },
  });
}

/** The node serves another chain than the deployment's: nothing is built for it. */
export class ChainMismatch extends Error {
  readonly code = "chain-mismatch";

  constructor() {
    super("The Sui node serves another chain than the deployment.");
    this.name = "ChainMismatch";
  }
}

type SenderBalancePayment =
  | Readonly<{ kind: "ready"; epoch: string; gasBudgetMist: bigint }>
  | Readonly<{ kind: "wrong-chain" }>
  | Readonly<{ kind: "insufficient-gas" }>;

type SenderGasSource = Readonly<{
  client: ClientWithCoreApi;
  provider: Provider;
  sender: string;
  chainIdentifier: string;
}>;

export type SenderBalanceGas = Readonly<{
  sender: string;
  balanceMist: bigint;
  epoch: string;
  referenceGasPrice: bigint;
  chain: string;
}>;

/** Read the chain and sender data once for a visit's unsigned gas probes. */
export async function readSenderBalanceGas(source: SenderGasSource): Promise<SenderBalanceGas | null> {
  const { client, provider, sender } = source;
  const [{ systemState }, { balance }, chain] = await Promise.all([
    provider((signal) => client.core.getCurrentSystemState({ signal })),
    provider((signal) => client.core.getBalance({ owner: sender, signal })),
    chainIdentifier(client, provider),
  ]);
  if (chain !== source.chainIdentifier) return null;
  return {
    sender,
    balanceMist: BigInt(balance.addressBalance),
    epoch: String(systemState.epoch),
    referenceGasPrice: BigInt(systemState.referenceGasPrice),
    chain,
  };
}

export function budgetSenderBalanceGas(
  transaction: Transaction,
  gas: SenderBalanceGas,
  ceiling: bigint,
  useAvailableBudget = false,
): SenderBalancePayment {
  const available = gas.balanceMist - suiWithdrawalMist(transaction.getData());
  const budget = useAvailableBudget && available < ceiling ? available : ceiling;
  if (budget <= 0n || available < budget) return { kind: "insufficient-gas" };
  payFromAddressBalance(transaction, { ...gas, gasBudgetMist: budget });
  return { kind: "ready", epoch: gas.epoch, gasBudgetMist: budget };
}

/** Prepare the requested budget against fresh address balance and epoch data. */
export async function payFromSenderBalance(
  transaction: Transaction,
  source: SenderGasSource & Readonly<{ gasBudgetMist: bigint }>,
): Promise<SenderBalancePayment> {
  const gas = await readSenderBalanceGas(source);
  return gas ? budgetSenderBalanceGas(transaction, gas, source.gasBudgetMist) : { kind: "wrong-chain" };
}
