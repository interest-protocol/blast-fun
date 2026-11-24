"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { calendarListQuery } from "./calendar-query";
import { presaleListQuery } from "#web/components/social/queries.ts";
import type { SocialPresaleListPage } from "@blast/core/web/contracts/presales.ts";
import { PresalesList } from "./PresalesList";
import { PresalesControls } from "./PresalesControls";
import {
  PresaleCalendarSkeleton,
  PresaleRowsSkeleton,
} from "./PresalesSkeleton";
import { discoveryState } from "./discovery-state";

function PendingPresales() {
  const params = useSearchParams();
  const selection = discoveryState({ status: params?.get("status"), sort: params?.get("sort"), scope: params?.get("scope"), layout: params?.get("layout"), view: params?.get("view"), calendarRange: params?.get("calendarRange") });
  const { status, sort, scope, view, layout, calendarRange } = selection;
  const client = useAppQueryClient();
  const [nowMs] = useState(() => Date.now());
  if (view === "backed")
    return (
      <PresalesList
        calendarRange={calendarRange}
        layout={layout}
        initial={null}
        nowMs={nowMs}
        sort={sort}
        scope={scope}
        status={status}
        view={view}
      />
    );
  const query = view === "calendar" ? calendarListQuery(client, "upcoming") : presaleListQuery({ status, sort });
  const cached = client.getQueryData<SocialPresaleListPage>(query.queryKey);
  if (cached && scope === "all")
    return (
      <PresalesList
        calendarRange={calendarRange}
        layout={layout}
        initial={view === "list" ? cached : null}
        calendar={view === "calendar" ? cached : null}
        calendarLive={view === "calendar" ? client.getQueryData<SocialPresaleListPage>(calendarListQuery(client, "live").queryKey) : undefined}
        calendarEnded={view === "calendar" ? client.getQueryData<SocialPresaleListPage>(calendarListQuery(client, "ended").queryKey) : undefined}
        status={status}
        sort={sort}
        view={view}
        nowMs={nowMs}
      />
    );
  return (
    <div
      aria-busy="true"
      aria-label="Loading presales"
      data-route-loading="presales"
    >
      <PresalesControls layout={layout} scope={scope} sort={sort} status={status} view={view}>
        {view === "calendar" ? (
          <PresaleCalendarSkeleton />
        ) : (
          <PresaleRowsSkeleton />
        )}
      </PresalesControls>
    </div>
  );
}

export function PresalesLoading() {
  return (
    <Suspense
      fallback={
        <div data-route-loading="presales">
          <PresalesControls sort="pinned" status="live" view="list">
            <PresaleRowsSkeleton />
          </PresalesControls>
        </div>
      }
    >
      <PendingPresales />
    </Suspense>
  );
}
