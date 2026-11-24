"use client";

import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

import { analyticsUrl } from "./analytics-url";

export function SiteAnalytics() {
  return (
    <>
      <Analytics beforeSend={analyticsUrl} />
      <SpeedInsights beforeSend={analyticsUrl} />
    </>
  );
}
