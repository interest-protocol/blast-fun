import { Suspense, type ReactNode } from "react";
import { connectionsPage } from "../connections-page";
import { ConnectionsLoading } from "#web/components/social/profile/ConnectionsRoute.tsx";

export default function ConnectionsLayout({ params, children }: Readonly<{ params: Promise<{ callsign: string }>; children: ReactNode }>) {
  return <Suspense fallback={<ConnectionsLoading />}>{connectionsPage(params)}{children}</Suspense>;
}
