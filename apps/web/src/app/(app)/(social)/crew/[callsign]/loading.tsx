import { ProfileLoading } from "#web/components/social/profile/ProfileLoading.tsx";
import { ProfileRouteLoading } from "#web/components/social/profile/ConnectionsRoute.tsx";

export default function Loading() {
  return <ProfileRouteLoading><ProfileLoading /></ProfileRouteLoading>;
}
