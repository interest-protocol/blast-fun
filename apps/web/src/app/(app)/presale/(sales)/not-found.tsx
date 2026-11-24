import { PresaleNotFound } from "#web/components/presale/PresaleNotFound.tsx";
import { SocialNotFound } from "#web/components/social/SocialPlaceholders.tsx";
import { requestLaunchFlags } from "#web/lib/launch-flags.server.ts";

// `notFound()` from the list or a sale page: the shell's "Nothing here" while the feed is on.
export default async function PresaleSalesNotFound() {
  return (await requestLaunchFlags()).social ? <SocialNotFound /> : <PresaleNotFound />;
}
