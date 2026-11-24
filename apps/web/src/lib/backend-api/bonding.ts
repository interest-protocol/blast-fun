import "server-only";
import { headers } from "next/headers";
import { SITE_ORIGIN } from "#web/lib/site.ts";
import { backendFirstPartyRead } from "#web/modules/partner-api/v1/relay.ts";
import { backendPrivateServerRead } from "@blast/server/private/relay.ts";
import { boundedPageText } from "#web/lib/backend-api/private-page-read.ts";
import {
  parseDiscoveryResponse,
  type DiscoveryResponse,
} from "@blast/core/modules/launchpad-discovery/rows.ts";
import {
  launchDetailsPath,
  parseLaunchDetails,
  type LaunchPageDetails,
} from "@blast/core/modules/launchpad-coin/transfer.ts";
import { withoutTestLaunches } from "#web/lib/test-launches.ts";

/** The Bonding hero as the server read it: the featured answer, and the details of each slide that answered. */
export type BondingHeroSeed = Readonly<{
  answer: DiscoveryResponse;
  /** By launch ID. A launch whose details read failed is left out, so the browser reads it. */
  details: Readonly<Record<string, LaunchPageDetails | null>>;
  nowMs: number;
}>;

type Relay = (request: Request) => Promise<Response>;

type Dependencies = Readonly<{
  origin: string;
  headers: () => Promise<Headers>;
  publicRelay: Relay;
  privateRelay: Relay;
  /** The whole hero read's budget; a slow backend leaves the hero to the browser instead of holding the page. */
  deadlineMs: number;
}>;

/** Featured answers and launch details are small; anything larger is not a hero. */
const HERO_READ_MAX_BYTES = 1024 * 1024;
/** Details reads in flight at once, as the backend bounds its reads of the featured list. */
const DETAILS_AT_ONCE = 4;

/** SSR reads the featured answer and launch details the browser reads, so the hero is in the first paint. */
export function bondingHeroRead(dependencies: Dependencies) {
  async function json(relay: Relay, path: string, signal: AbortSignal): Promise<unknown> {
    const read = (async () => {
      const response = await relay(
        new Request(dependencies.origin + path, { headers: await dependencies.headers(), signal }),
      );
      return boundedPageText(response, HERO_READ_MAX_BYTES, "Bonding hero read unavailable");
    })();
    return JSON.parse(await beforeDeadline(read, signal));
  }
  async function details(launchId: string, signal: AbortSignal) {
    try {
      const body = (await json(dependencies.privateRelay, launchDetailsPath(launchId), signal)) as { details?: unknown };
      return [[launchId, parseLaunchDetails(body.details)] as const];
    } catch {
      return [];
    }
  }
  return async (): Promise<BondingHeroSeed | null> => {
    const nowMs = Date.now();
    const signal = AbortSignal.timeout(dependencies.deadlineMs);
    let answer: DiscoveryResponse;
    try {
      answer = withoutTestLaunches(parseDiscoveryResponse(await json(dependencies.publicRelay, "/api/launchpad/discovery?catalog=featured", signal)));
    } catch {
      return null;
    }
    const { section } = answer;
    const rows = section.state === "available" || section.state === "stale" ? section.data.rows : [];
    const queue = rows.map(({ launchId }) => launchId);
    const entries: (readonly [string, LaunchPageDetails | null])[] = [];
    await Promise.all(
      Array.from({ length: Math.min(DETAILS_AT_ONCE, queue.length) }, async () => {
        for (let launchId = queue.shift(); launchId !== undefined && !signal.aborted; launchId = queue.shift()) {
          // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Each of the four workers finishes its current read before taking another launch.
          entries.push(...(await details(launchId, signal)));
        }
      }),
    );
    return { answer, details: Object.fromEntries(entries), nowMs };
  };
}

/**
 * `read`, or a rejection once `signal` aborts. The relays stop waiting for headers on abort, but a
 * Request's signal stops reaching its fetch once the Request is collected, and nothing bounds a
 * stalled body, so the deadline is kept here. An abandoned read ends at its relay's own timeout.
 */
function beforeDeadline<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  read.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    read.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export const readBondingHeroFromBackend = bondingHeroRead({
  origin: SITE_ORIGIN,
  headers: async () => new Headers(await headers()),
  publicRelay: backendFirstPartyRead,
  privateRelay: backendPrivateServerRead,
  deadlineMs: 2_000,
});
