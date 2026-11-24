import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CompetitionScreen } from "#web/components/social/competitions/CompetitionScreen.tsx";
import { competitionSlug } from "@blast/core/modules/social/competitions/config.ts";
export const metadata: Metadata = { title: "Competition" };
export default async function CompetitionPage({
  params,
}: Readonly<{ params: Promise<{ slug: string }> }>) {
  const { slug } = await params;
  if (!competitionSlug.safeParse(slug).success) notFound();
  return <CompetitionScreen key={slug} slug={slug} />;
}
