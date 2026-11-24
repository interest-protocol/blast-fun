import { TradingViewFixture } from "../../TradingViewFixture";
export const metadata = {
  title: "TradingView chart verification",
  robots: { index: false, follow: false },
};
export default function Page() {
  return <TradingViewFixture />;
}
