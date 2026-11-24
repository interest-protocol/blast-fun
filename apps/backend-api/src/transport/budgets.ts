import { TRANSPORT_LIMITS } from "./contracts.ts";
import type { RequestTarget } from "./request.ts";

export function workBudget(target: RequestTarget, maxPrivateWorkMs?: number): number {
  if (target.cronContract) {
    return target.cronContract.workBudgetMs;
  }
  if (target.privateContract) {
    return privateWorkBudget(target.privateContract, maxPrivateWorkMs);
  }
  return target.operator?.workBudgetMs ?? TRANSPORT_LIMITS.deadlineMs;
}

export function privateWorkBudget(
  contract: Readonly<{ workBudgetMs?: number }>,
  maximum?: number,
): number {
  return Math.min(contract.workBudgetMs ?? TRANSPORT_LIMITS.privateDeadlineMs, maximum ?? Infinity);
}
