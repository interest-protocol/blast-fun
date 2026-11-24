import type { ReactNode } from "react";

import { PresaleLayout } from "#web/components/presale/layout/PresaleLayout.tsx";

export default function Layout({ children }: Readonly<{ children: ReactNode }>) {
  return <PresaleLayout socialShell>{children}</PresaleLayout>;
}
