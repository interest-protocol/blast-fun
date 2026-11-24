import "server-only";
import type { SocialHappeningResponse } from "@blast/core/modules/social/contracts/happening.ts";
import type { SocialFeedPage } from "@blast/core/modules/social/contracts/feed.ts";
import type { SocialItemResponse } from "@blast/core/modules/social/contracts/item-routes.ts";
import type { SocialProfileCalls } from "@blast/core/modules/social/contracts/profile-page.ts";
import { socialProfilePath, withProfileBio, type SocialProfile } from "@blast/core/modules/social/contracts/profiles.ts";
import { HOME_DEFAULT_WINDOW, socialHomePath, socialHomeCoinsPath, socialHomeTradersPath, withHomeDiscoverDetails, type HomeQuery, type HomeWindow, type HomeCoinsPage, type HomeCoinsByIds, type HomeTradersPage } from "@blast/core/modules/social/contracts/home.ts";
import { readPrivateBackendPage } from "./private-page-read.ts";
import { testPresaleIds, withoutTestCoins, withoutTestHappening, withoutTestPosts } from "#web/lib/test-launches.ts";

/** Only HTTP adaptation lives here; Bun owns visibility, clocks, account materialization and SQL. */
async function socialRead<Result>(path: string): Promise<Result | null> {
  const response = await readPrivateBackendPage(path);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Social backend read unavailable.");
  return await response.json() as Result;
}

export async function readFeedPageFromBackend(): Promise<SocialFeedPage> {
  const page = await socialRead<SocialFeedPage>("/api/social/feed");
  if (!page) throw new Error("Social feed unavailable.");
  return withoutTestPosts(page);
}

export function readPostFromBackend(entryId: string): Promise<SocialItemResponse | null> {
  return socialRead(`/api/social/items/${encodeURIComponent(entryId)}`);
}

export function readProfileFromBackend(callsign: string): Promise<SocialProfile | null> {
  return socialRead(withProfileBio(socialProfilePath(callsign)));
}

export function readProfileCallsFromBackend(callsign: string): Promise<SocialProfileCalls | null> {
  return socialRead(`/api/social/profiles/${encodeURIComponent(callsign)}/calls`);
}

export async function readHappeningFromBackend(): Promise<SocialHappeningResponse | null> {
  const read = await socialRead<SocialHappeningResponse>("/api/social/happening");
  if (!read) return null;
  const testIds = await testPresaleIds(read, async (ids) => (await readHomeCoinsFromBackend(ids, HOME_DEFAULT_WINDOW, 1))?.coins ?? null);
  return withoutTestHappening(read, testIds);
}

export function readHomeFromBackend(query: Partial<HomeQuery> = {}): Promise<HomeCoinsPage | null> {
  return socialRead<HomeCoinsPage>(withHomeDiscoverDetails(socialHomePath(query))).then((page) => page && withoutTestCoins(page));
}

export function readHomeCoinsFromBackend(ids: readonly string[], window: HomeWindow, holderLimit?: number): Promise<HomeCoinsByIds | null> {
  return ids.length === 0 ? Promise.resolve(null) : socialRead(socialHomeCoinsPath(ids, window, holderLimit));
}

export function readHomeTradersFromBackend(window: HomeWindow): Promise<HomeTradersPage | null> {
  return socialRead(socialHomeTradersPath(window));
}
