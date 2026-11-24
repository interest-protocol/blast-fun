import type { RecordedRoute, FreshLaunchReader } from "@blast/core/modules/launchpad-coin/fresh-types.ts";
import { defineBlastDeployment, migratorsDeployment, type BlastDeployment, type BlastDeploymentInput } from "@interest-protocol/blast-sdk/deployments";
import { getLaunch, type LaunchState } from "@interest-protocol/blast-sdk/launchpad";
import { MigratorsClient, venueOf } from "@interest-protocol/blast-sdk/migrators";
import { ObjectError, type ClientWithCoreApi } from "@mysten/sui/client";
import { parseStructTag } from "@mysten/sui/utils";

/** The node and deployment identity fresh launch reads use. */
export type LaunchReadChain = Readonly<{ client: ClientWithCoreApi; manifest: BlastDeploymentInput }>;

const NOT_CONNECTED = "This app is not connected to a released Blast deployment, so launch objects cannot be read.";
const NO_ANSWER = "The launch object could not be read from Sui just now.";
/** The SDK's refusals of an object that is not a shared launch of the deployment's package. */
const NOT_A_LAUNCH = /is not a launch|unexpected package|must have two type arguments|is not a shared object|mismatched UID/;

async function recordedRoute(launch: LaunchState, deployment: BlastDeployment, client: ClientWithCoreApi): Promise<RecordedRoute> {
  const configured = migratorsDeployment(deployment);
  const venue = venueOf(configured, launch.venue);
  const tiers = deployment.routes.find((entry) => entry.venue === venue)?.tiers;
  const unavailable = (reason: string): RecordedRoute => ({
    venue: venue ?? parseStructTag(launch.venue).module,
    tickSpacing: null,
    feeRate: null,
    supported: false,
    reason,
  });
  if (!venue || !tiers) return unavailable("This migration route is not admitted by the deployment.");
  const migrators = new MigratorsClient(client, configured);
  switch (venue) {
    case "cetus": {
      const spacing = await migrators.getCetusPoolTier(launch.memeType);
      const tier = tiers.find((entry) => entry.tickSpacing === spacing);
      return tier
        ? { venue, tickSpacing: tier.tickSpacing, feeRate: BigInt(tier.feeRate), supported: true, reason: null }
        : unavailable("The recorded Cetus spacing is not admitted by the deployment.");
    }
    case "bluefin": {
      const tier = await migrators.getBluefinPoolTier(launch.memeType);
      return tier && tiers.some((entry) => entry.tickSpacing === tier.tickSpacing && entry.feeRate === String(tier.feeRate))
        ? { venue, ...tier, supported: true, reason: null }
        : unavailable("The recorded Bluefin tier is not admitted by the deployment.");
    }
    default:
      throw new Error(`Unhandled migration venue: ${String(venue satisfies never)}`);
  }
}

/** How long the node may take to return a launch object, like blast-infra's `/v1` budget. */
export const FRESH_READ_TIMEOUT_MS = 2_500;

/** `client` with every `getObject` bound to `signal` (the SDK's `getLaunch` passes none). */
function abortable(client: ClientWithCoreApi, signal: AbortSignal): ClientWithCoreApi {
  return {
    core: {
      getObject: (options: Parameters<ClientWithCoreApi["core"]["getObject"]>[0]) => client.core.getObject({ ...options, signal }),
      getDynamicField: (options: Parameters<ClientWithCoreApi["core"]["getDynamicField"]>[0]) => client.core.getDynamicField({ ...options, signal }),
    },
  } as unknown as ClientWithCoreApi;
}

class FreshReadTimeout extends Error {}

/**
 * Reads launch objects from `chain` through the SDK (`getLaunch`, checked
 * against the deployment's launchpad package, and the migrators tier reader).
 * A read that takes longer than `timeoutMs` is aborted and Unavailable, so a
 * stalled node never holds the page or a telemetry check. Without a chain
 * every read is Unavailable.
 */
export function createFreshLaunchReader(
  chain: LaunchReadChain | null,
  now: () => number = Date.now,
  options: Readonly<{ timeoutMs?: number; trackWork?: <T>(promise: Promise<T>) => Promise<T> }> = {},
): FreshLaunchReader {
  const timeoutMs = options.timeoutMs ?? FRESH_READ_TIMEOUT_MS;
  return async (launchId) => {
    if (!chain) return { status: "unavailable", reason: NOT_CONNECTED };
    let deployment: BlastDeployment;
    try {
      deployment = defineBlastDeployment(chain.manifest);
    } catch {
      return { status: "unavailable", reason: NOT_CONNECTED };
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new FreshReadTimeout());
      }, timeoutMs);
    });
    try {
      const client = abortable(chain.client, controller.signal);
      const read = async () => {
        const launch = await getLaunch(client, launchId, deployment.packages.launchpad.originalPackageId);
        const route = await recordedRoute(launch, deployment, client).catch((): RecordedRoute => ({
          venue: parseStructTag(launch.venue).module,
          tickSpacing: null,
          feeRate: null,
          supported: false,
          reason: "The venue tier could not be read.",
        }));
        return { launch, route };
      };
      const reading = (options.trackWork ?? ((promise) => promise))(read());
      reading.catch(() => undefined);
      const result = await Promise.race([reading, deadline]);
      return { status: "read", ...result, readAtMs: now() };
    } catch (error) {
      if (error instanceof ObjectError && (error.reason === "notFound" || error.reason === "deleted")) {
        return { status: "absent", readAtMs: now() };
      }
      if (error instanceof TypeError && NOT_A_LAUNCH.test(error.message)) return { status: "foreign", readAtMs: now(), reason: "This object does not belong to the selected launch deployment." };
      return { status: "unavailable", reason: NO_ANSWER };
    } finally {
      clearTimeout(timer);
    }
  };
}
