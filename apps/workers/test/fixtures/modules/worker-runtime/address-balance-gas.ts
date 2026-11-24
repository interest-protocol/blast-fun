// Prepares bytes a test signs as the runtime prepares them: the runtime's own
// `payFromAddressBalance` (no gas payment object, a one-epoch `ValidDuring`
// expiration) on the deployment's chain, at a fixed epoch.

import type { Transaction } from "@mysten/sui/transactions";

import { payFromAddressBalance } from "../../../../src/modules/worker-runtime/address-balance.ts";

export function addressBalanceGas(
  transaction: Transaction,
  gas: Readonly<{ sender: string; gasBudgetMist: bigint; chainIdentifier: string; referenceGasPrice?: bigint; epoch?: string }>,
): void {
  payFromAddressBalance(transaction, {
    sender: gas.sender,
    gasBudgetMist: gas.gasBudgetMist,
    referenceGasPrice: gas.referenceGasPrice ?? 1_000n,
    epoch: gas.epoch ?? "1",
    chain: gas.chainIdentifier,
  });
}
