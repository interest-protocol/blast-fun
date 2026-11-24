"use client";

import { createContext, useContext, type ReactNode } from "react";

import { type ShellPortfolio, NO_SHELL_PORTFOLIO } from "./shell-portfolio-context-model";

const ShellPortfolioContext = createContext<ShellPortfolio>(NO_SHELL_PORTFOLIO);

export function ShellPortfolioProvider({ value, children }: Readonly<{ value: ShellPortfolio; children: ReactNode }>) {
  return <ShellPortfolioContext value={value}>{children}</ShellPortfolioContext>;
}

/** The viewer's portfolio as the shell read it. */
export function useShellPortfolioContext(): ShellPortfolio {
  return useContext(ShellPortfolioContext);
}
