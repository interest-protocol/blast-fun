import "../../../../../../src/app/globals.css";
import { AcceptanceFixture } from "../../../AcceptanceFixture";
export const metadata = { title: "Portfolio persistence fixture", robots: { index: false, follow: false } };
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  return <AcceptanceFixture initial={{ ...await searchParams, surface: "portfolio" }} />;
}
