import { queryKeys } from "#web/lib/query/keys.ts";
import { homeActivityStreamReadSchema } from "@blast/core/web/contracts/home-read-schemas.ts";
import { queryOptions } from "@tanstack/react-query";
import {
  SOCIAL_HOME_ACTIVITY_STREAM_PATH,
  type HomeWindow,
} from "@blast/core/web/contracts/home.ts";

export class ActivityCursorError extends Error {}

/** Discovery and the activity browser share one public read and cache key. */
export function activityStreamQuery(
  window: HomeWindow,
  rows = 20,
  cursor: string | null = null,
) {
  return queryOptions({
    queryKey: queryKeys.workspace.activity(window, rows, cursor),
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ window, limit: String(rows) });
      if (cursor !== null) params.set("cursor", cursor);
      const response = await fetch(
        `${SOCIAL_HOME_ACTIVITY_STREAM_PATH}?${params}`,
        { signal },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        if (response.status === 400 && body?.error?.parameter === "cursor")
          throw new ActivityCursorError();
        throw new Error("Activity could not load");
      }
      const parsed = homeActivityStreamReadSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error("Activity response is incomplete");
      return parsed.data;
    },
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
  });
}
