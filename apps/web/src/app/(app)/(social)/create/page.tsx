import type { Metadata } from "next";

import { CreateScreen } from "#web/components/social/create/CreateScreen.tsx";
import { readCreateContextFromBackend } from "#web/lib/backend-api/create-context.ts";

export const metadata: Metadata = { title: "Create a presale", robots: { index: false, follow: false } };

/**
 * `/create` (the live canonical UI's Create, UI-20): the signed-in account's
 * presale draft, read and saved in the browser with the viewer's
 * credentials (personal data, never server-rendered or cached). The server
 * passes only what is the same for everyone: Blast's rates and whether
 * publishing is on for the deployed mainnet presale.
 * The social layout answers not-found while the social feed is off.
 */
export default async function CreatePage() {
  const { fees, publish, ...quoteOptions } = await readCreateContextFromBackend();
  return <CreateScreen fees={fees} publish={publish} {...quoteOptions} />;
}
