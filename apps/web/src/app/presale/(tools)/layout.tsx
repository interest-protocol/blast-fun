import type { ReactNode } from "react";
import { PresaleLayout } from "#web/components/presale/layout/PresaleLayout.tsx";
import AppLayout from "../../(app)/layout";

export default function Layout({ children }: Readonly<{ children: ReactNode }>) {
  return <PresaleLayout socialShell><AppLayout rail={null} banner={null}>{children}</AppLayout></PresaleLayout>;
}
