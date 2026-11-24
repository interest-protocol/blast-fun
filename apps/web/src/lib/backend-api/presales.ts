import "server-only";
import { headers } from "next/headers";
import { SITE_ORIGIN } from "#web/lib/site.ts";
import {
  socialPresaleListPath,
  socialPresalePath,
  type SocialPresaleDetail,
  type SocialPresaleListPage,
  type SocialPresaleSummary,
} from "@blast/core/modules/social/contracts/presales.ts";
import { backendFirstPartyRead } from "#web/modules/partner-api/v1/relay.ts";
import { readVisiblePage, withoutTestPresalePage, withoutTestPresales } from "#web/lib/test-launches.ts";

type Dependencies = Readonly<{
  headers: () => Promise<Headers>;
  relay: (request: Request) => Promise<Response>;
  origin: string;
}>;

/** SSR reads the same anonymous API and cache as the browser; Bun owns the data clock. */
export function presaleBackendPageReads(dependencies: Dependencies) {
  async function read(path: string): Promise<Response> {
    return dependencies.relay(
      new Request(dependencies.origin + path, {
        headers: await dependencies.headers(),
      }),
    );
  }
  async function json<Value>(response: Response): Promise<Value> {
    if (!response.ok) throw new Error("Public presale read unavailable");
    return response.json() as Promise<Value>;
  }
  return Object.freeze({
    list: async (
      query: Parameters<typeof socialPresaleListPath>[0],
    ): Promise<SocialPresaleListPage> =>
      readVisiblePage(
        query?.cursor ?? null,
        async (cursor) => json<SocialPresaleListPage>(await read(socialPresaleListPath({ ...query, cursor }))),
        withoutTestPresalePage,
        (page) => page.presales.length,
        (page) => page.next_cursor,
      ),
    featured: async (): Promise<SocialPresaleSummary[]> =>
      withoutTestPresales(
        (
          await json<{ presales: SocialPresaleSummary[] }>(
            await read("/api/social/presales/featured"),
          )
        ).presales,
      ),
    detail: async (id: string): Promise<SocialPresaleDetail | null> => {
      const response = await read(socialPresalePath(id));
      return response.status === 404
        ? null
        : json<SocialPresaleDetail>(response);
    },
  });
}

const reads = () =>
  presaleBackendPageReads({
    headers: async () => new Headers(await headers()),
    relay: backendFirstPartyRead,
    origin: SITE_ORIGIN,
  });
export const readPresaleListFromBackend = (
  query: Parameters<typeof socialPresaleListPath>[0],
) => reads().list(query);
export const readFeaturedPresalesFromBackend = () => reads().featured();
export const readPresaleFromBackend = (id: string) => reads().detail(id);
