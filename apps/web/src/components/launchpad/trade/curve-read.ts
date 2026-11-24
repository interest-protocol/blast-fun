// The curve a trade acts on, read from the node and decoded through the SDK:
// the shared `Launch` with its reserves, lifecycle, fees, and sell burn, the
// object version it was observed at, and the coin's decimals and ticker.

import type { BlastDeployment } from "@interest-protocol/blast-sdk/deployments";
import { decodeLaunchObject, memeAtomicSupply, type LaunchState } from "@interest-protocol/blast-sdk/launchpad";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { parseStructTag } from "@mysten/sui/utils";

import { readQuoteAsset, type QuoteAsset } from "./quote-asset.ts";

import { describeError } from "../transaction/errors.ts";

export type CurveObservation = Readonly<{ version: string; observedAtMs: number }>;

export type Curve = Readonly<{
  launch: LaunchState;
  /** The launch object's full Move type, for lineage checks. */
  objectType: string;
  /** The object version and time this curve was read; an indicative preview names both. */
  observation: CurveObservation;
  decimals: number;
  quote: QuoteAsset;
  /** The coin's ticker as its Move type names it. */
  symbol: string;
}>;

export type CurveRead = Readonly<{ status: "ok"; curve: Curve }> | Readonly<{ status: "unavailable"; message: string }>;

/** The decimals whose canonical one-billion supply is `atomicSupply`, through the SDK; null if none. */
function decimalsOf(atomicSupply: bigint): number | null {
  for (let decimals = 0; decimals <= 19; decimals += 1) {
    try {
      if (memeAtomicSupply(decimals) === atomicSupply) return decimals;
    } catch {
      return null;
    }
  }
  return null;
}

export async function readCurve(
  client: ClientWithCoreApi,
  deployment: BlastDeployment,
  launchId: string,
  nowMs: number,
): Promise<CurveRead> {
  try {
    const { object } = await client.core.getObject({ objectId: launchId, include: { content: true } });
    if (object.owner.$kind !== "Shared") return { status: "unavailable", message: "This launch is not a shared Blast launch." };
    const launch = decodeLaunchObject(
      {
        objectId: object.objectId,
        initialSharedVersion: object.owner.Shared.initialSharedVersion,
        mutable: true,
        type: object.type,
        content: object.content,
      },
      deployment.packages.launchpad.originalPackageId,
    );
    const decimals = decimalsOf(launch.atomicSupply);
    if (decimals === null) return { status: "unavailable", message: "This launch's supply is not a canonical Blast supply." };
    return {
      status: "ok",
      curve: {
        launch,
        objectType: object.type,
        observation: { version: object.version, observedAtMs: nowMs },
        decimals,
        quote: await readQuoteAsset(client, launch.quoteType),
        symbol: parseStructTag(launch.memeType).name,
      },
    };
  } catch (error) {
    return { status: "unavailable", message: `The launch could not be read from Sui: ${describeError(error)}` };
  }
}
