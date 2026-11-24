import "../../../../../src/app/globals.css";
import { ParityFixture } from "../../ParityFixture";
import { COMPETITION, NOW, termsDetail } from "../../parity-fixtures";
export const metadata = {
  title: "Parity gaps proof",
  robots: { index: false, follow: false },
};
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const value = (key: string, fallback = "") => typeof params[key] === "string" ? params[key] as string : fallback;
  const surface = value("surface", "portfolio");
  const variant = value("variant");
  // Serialize generated values once: independent server/browser clocks and PRNGs are not hydration fixtures.
  return <ParityFixture initial={{ surface, variant, theme: value("theme", "light"), shell: value("shell", "member"), transition: value("transition"), ...(surface === "terms" ? { detail: termsDetail(variant) } : {}), ...(surface === "competitions" ? { competition: COMPETITION, nowMs: NOW } : {}) }} />;
}
