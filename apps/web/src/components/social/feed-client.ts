import { PublicError, responseError, responseDiagnostic } from "#web/lib/errors.ts";
import { gatedFetch } from "#web/lib/api-gate-client.ts";
import {
  SOCIAL_FEED_PATH,
  socialFeedPageSchema,
  type SocialFeedPage,
} from "@blast/core/web/contracts/feed.ts";
import { withoutTestPosts } from "#web/lib/test-launches.ts";

/** The For You endpoint the home page pages through. */
export const HOME_FEED_ENDPOINT = `${SOCIAL_FEED_PATH}?tab=for_you`;

/** `endpoint` with `cursor` added (replacing any), for the next page. */
export function feedPageUrl(endpoint: string, cursor: string | null): string {
  const url = new URL(endpoint, "http://feed.invalid");
  if (cursor === null) url.searchParams.delete("cursor");
  else url.searchParams.set("cursor", cursor);
  return `${url.pathname}${url.search}`;
}

/**
 * One page of a public feed. No access token is sent (only the API gate
 * cookie, which names nobody): the answer is the same for everyone. A non-200 answer or an unexpected body throws.
 */
export async function fetchFeedPage(
  endpoint: string,
  cursor: string | null,
  fetchImpl: typeof fetch = gatedFetch,
  signal?: AbortSignal,
): Promise<SocialFeedPage> {
  const response = await fetchImpl(feedPageUrl(endpoint, cursor), {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) throw responseError(await response.json().catch(() => null), response);
  const body: unknown = await response.json().catch(() => null);
  const parsed = socialFeedPageSchema.safeParse(body);
  if (!parsed.success)
    throw new PublicError("The feed returned an unreadable response. Try again.", {
      ...responseDiagnostic(response),
      code: "invalid_response",
    });
  // The main feed drops posts about test sales; profile feeds keep them.
  return endpoint.startsWith(SOCIAL_FEED_PATH) ? withoutTestPosts(parsed.data) : parsed.data;
}
