import { normalizeFeeSplit, type FeeSplit, type Route } from "@interest-protocol/blast-sdk";

type FeeAmount = string | bigint;

type DraftFeeSplit = Readonly<{
  creatorBps: FeeAmount;
  autoLpBps: FeeAmount;
  rewardsBps: FeeAmount;
  burnBps: FeeAmount;
  recipients: readonly Readonly<{ destination: string; bps: FeeAmount }>[];
}>;

/** Converts saved form fields to the contract's ordered, positive fee routes. */
export function launchFeeSplit(split: DraftFeeSplit): FeeSplit {
  const routes: Route[] = [
    { destination: { kind: "Owner" }, bps: BigInt(split.creatorBps) },
    { destination: { kind: "AutoLp" }, bps: BigInt(split.autoLpBps) },
    { destination: { kind: "HolderRewards" }, bps: BigInt(split.rewardsBps) },
    { destination: { kind: "Burn" }, bps: BigInt(split.burnBps) },
    ...split.recipients.map(({ destination, bps }): Route => ({
      destination: { kind: "Address", address: destination },
      bps: BigInt(bps),
    })),
  ];
  return normalizeFeeSplit({ routes: routes.filter((route, index) => index >= 4 || route.bps !== 0n) });
}
