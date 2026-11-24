import type { Metadata } from "next";
import { PortfolioFixture } from "../../portfolio/PortfolioFixture";
export const metadata: Metadata = { title: "Portfolio fixture" };
export default function Page() { return <PortfolioFixture />; }
