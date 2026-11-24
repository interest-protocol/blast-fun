import type { ReactNode } from "react";
import { PortfolioDetailNavigation } from "#web/components/social/portfolio/PortfolioDetailNavigation.tsx";
export default function VestingLayout({ children }: Readonly<{ children: ReactNode }>) {
  return <><PortfolioDetailNavigation />{children}</>;
}
