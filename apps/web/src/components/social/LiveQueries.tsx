"use client";

import { useEffect } from "react";

import { useAppQueryClient } from "#web/lib/query/provider.tsx";

import { activityHints, tabActivityHints } from "./home/activity-hints";
import { hintInvalidation, LIVE_QUERIES_SURFACE } from "./live-queries";

/** Infra hints invalidate the active public queries through the tab's shared stream. */
export function LiveQueries() {
  const client = useAppQueryClient();
  useEffect(() => {
    const hints = tabActivityHints();
    if (hints === null) return undefined;
    return hintInvalidation(client, activityHints(LIVE_QUERIES_SURFACE, hints));
  }, [client]);
  return null;
}
