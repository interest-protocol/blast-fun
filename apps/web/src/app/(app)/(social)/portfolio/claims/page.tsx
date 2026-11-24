import { cache } from "react";
import { connection } from "next/server";
import { PortfolioScreen } from "#web/components/social/portfolio/PortfolioScreen.tsx";
export const metadata = { title: "Portfolio · Claims", robots: { index: false, follow: false } };
const requestNow = cache(() => Date.now());
export default async function SectionPage() {
  await connection();
  return <PortfolioScreen initialTab="claims" nowMs={requestNow()} />;
}
