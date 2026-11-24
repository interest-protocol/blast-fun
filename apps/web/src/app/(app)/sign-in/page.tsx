import type { Metadata } from "next";

import { SignInCard } from "#web/components/sign-in/SignIn.tsx";
import { signInReturnPath } from "#web/lib/sign-in-next.ts";
import { requestLaunchFlags } from "#web/lib/launch-flags.server.ts";

/** In the app shell (feed on) the social pages' title form ("Sign in · Blast"); unchanged with the feed off. */
export async function generateMetadata(): Promise<Metadata> {
  return (await requestLaunchFlags()).social ? { title: { absolute: "Sign in · Blast" } } : {};
}

// The sign-in fallback (FEATURE-MAP §8.2): the sign-in sheet's content as a
// card, for deep links, a new tab and no JavaScript. In the app the shell's
// "Sign in" opens the sheet over the page instead. `next` is resolved here
// through the allowlist: after sign-in the page returns to `returnTo`, and
// Back goes there too.
export default async function SignInPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ [key: string]: string | string[] | undefined }> }>) {
  const returnTo = signInReturnPath((await searchParams).next);
  // In the app shell (social feed on) the shell owns the page's <main>.
  const Root = (await requestLaunchFlags()).social ? "div" : "main";
  return (
    <Root>
      <h1 className="sr">Sign in</h1>
      <SignInCard returnTo={returnTo} />
    </Root>
  );
}
