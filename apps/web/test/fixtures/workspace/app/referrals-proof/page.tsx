import { ReferralFixture } from "../../ReferralFixture";
export const metadata = {
  title: "Referral tracking test fixture",
  robots: { index: false, follow: false },
};
export default async function Page({
  searchParams,
}: Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const params = await searchParams;
  return (
    <ReferralFixture
      view={typeof params.view === "string" ? params.view : undefined}
      theme={typeof params.theme === "string" ? params.theme : undefined}
      state={typeof params.state === "string" ? params.state : undefined}
    />
  );
}
