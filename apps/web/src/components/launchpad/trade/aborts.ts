import { launchpadAbortName, type LaunchpadAbortName } from "@interest-protocol/blast-launchpad-sdk/aborts";
import type { BlastDeployment } from "@interest-protocol/blast-sdk/deployments";

import { launchpadAbortOf } from "../launch/advanced/contract-errors.ts";

export type CurveAbort = "lifecycle" | "slippage" | "zero-output";

const CURVE_ABORTS: Readonly<Partial<Record<LaunchpadAbortName, CurveAbort>>> = {
  EInvalidLaunchLifecycle: "lifecycle",
  ESlippageExceeded: "slippage",
  EZeroTradeOutput: "zero-output",
};

export function curveAbortOf(message: string, deployment: BlastDeployment | null): CurveAbort | null {
  if (!deployment) return null;
  const abort = launchpadAbortOf(message, deployment);
  if (!abort || abort.module !== "launch") return null;
  const name = launchpadAbortName(abort.code);
  return name ? (CURVE_ABORTS[name] ?? null) : null;
}
