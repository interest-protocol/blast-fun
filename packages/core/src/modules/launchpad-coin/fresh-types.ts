import type { LaunchState } from "@interest-protocol/blast-sdk/launchpad";


/**
 * The migration adapter a launch recorded at creation (its
 * `venue`) with its pool tier, and whether this app can use it.
 */
export type RecordedRoute = Readonly<{
  /** The adapter module, such as `bluefin` or `cetus`. */
  venue: string;
  tickSpacing: number | null;
  feeRate: bigint | null;
  /** The SDK routes the witness and this deployment admits its venue. */
  supported: boolean;
  /** Why the route is unsupported; null when supported. */
  reason: string | null;
}>;


/**
 * The launch object as the Sui node reported it for this request. It is the
 * only input to transaction eligibility; indexed facts never are.
 *
 * - `read`: a launch of this deployment, decoded by the SDK;
 * - `absent`: the node has no object with this ID;
 * - `foreign`: the object is not a launch of this deployment;
 * - `unavailable`: the node could not be asked or did not answer.
 */
export type FreshLaunch =
  | Readonly<{ status: "read"; launch: LaunchState; route: RecordedRoute; readAtMs: number }>
  | Readonly<{ status: "absent"; readAtMs: number }>
  | Readonly<{ status: "foreign"; readAtMs: number; reason: string }>
  | Readonly<{ status: "unavailable"; reason: string }>;


export type FreshLaunchReader = (launchId: string) => Promise<FreshLaunch>;
