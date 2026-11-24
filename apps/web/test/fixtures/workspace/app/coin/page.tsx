import { CoinFixture } from "../../CoinFixture";
export const metadata = {
  title: "Coin panel controlled provider fixture",
  robots: { index: false, follow: false },
};
export default function Page() {
  return <CoinFixture />;
}
