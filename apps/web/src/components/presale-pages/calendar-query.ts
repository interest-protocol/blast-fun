import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { presaleListQuery } from "#web/components/social/queries.ts";
import { PUBLIC_STALE_MS } from "#web/lib/query/client.ts";
import type { PresaleListStatus } from "@blast/core/web/contracts/presales.ts";
import { readCalendarPages } from "./calendar-pages";

export function calendarListQuery(client: QueryClient, status: PresaleListStatus) {
  const sort = { upcoming: "opening", live: "ending", ended: "recent" }[status];
  const first = presaleListQuery({ status, sort, limit: 50 });
  return queryOptions({
    queryKey: [...first.queryKey, "calendar"],
    queryFn: () => readCalendarPages((cursor) => client.fetchQuery(presaleListQuery({ status, sort, limit: 50, cursor }))),
    staleTime: PUBLIC_STALE_MS,
  });
}
