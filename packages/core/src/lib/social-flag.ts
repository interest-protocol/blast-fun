import { isLaunchEnabled } from "./launch-flags.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export function isSocialEnabled(environment: Environment = process.env): boolean {
  return isLaunchEnabled("social", environment);
}

export const isSocialWorkerEnabled = isSocialEnabled;

export function isTradingVisible(environment: Environment = process.env): boolean {
  return isLaunchEnabled("trading", environment);
}
