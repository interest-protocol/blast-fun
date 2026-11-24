import type { Metadata } from "next";
import { InvitesPage } from "#web/components/social/referrals/InvitesPage.tsx";

export const metadata: Metadata = { title: "Invites", robots: { index: false, follow: false } };

export default function Page() {
  return <InvitesPage />;
}
