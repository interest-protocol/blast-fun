import { HomeTabsFixture, type HomeTabsState } from "../../HomeTabsFixture";

export const metadata = { title: "Home coin tabs proof", robots: { index: false, follow: false } };

const STATES: readonly HomeTabsState[] = ["populated", "worst", "empty", "loading", "error"];

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const state = STATES.find((value) => value === params.state) ?? "populated";
  return <HomeTabsFixture state={state} theme={params.theme === "dark" ? "dark" : "light"} />;
}
