import type { ReactNode } from "react";

import { PresaleLayout } from "#web/components/presale/layout/PresaleLayout.tsx";

// Its right column ("Your wallet") is `(app)/@rail/settings`.
export default function Layout({ children }: Readonly<{ children: ReactNode }>) {
  return <PresaleLayout socialShell>{children}</PresaleLayout>;
}
