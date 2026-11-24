import { Suspense } from "react";
import type { Metadata } from "next";
import { CompetitionDirectoryScreen, CompetitionReadPending } from "#web/components/social/competitions/CompetitionScreen.tsx";
export const metadata: Metadata = { title: "Competitions" };
export default function CompetitionsPage() {
  return <Suspense fallback={<CompetitionReadPending />}><CompetitionDirectoryScreen /></Suspense>;
}
