import { Suspense, type ReactNode } from "react";

import { PresaleLayout } from "#web/components/presale/layout/PresaleLayout.tsx";

import Loading from "../loading";

/**
 * The presales list and sale pages (canonical UI §9, §10). While the social
 * feed is on they sit in the app shell (`(app)/layout.tsx`), whose right
 * column `(app)/@rail/presale` fills; with it off the presale shell renders
 * them as before.
 */
export default function Layout({ children }: Readonly<{ children: ReactNode }>) {
  return <Suspense fallback={<Loading />}><PresaleLayout socialShell>{children}</PresaleLayout></Suspense>;
}
