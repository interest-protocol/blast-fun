import { createHash } from "node:crypto";
import type { Metadata } from "next";
import { referralCallsign, referralPath } from "@blast/core/modules/social/referrals/contracts.ts";
import { SITE_ORIGIN } from "#web/lib/site.ts";
import { referralRank, type ReferralInviter } from "@blast/core/modules/social/referrals/share.ts";
export type ReferralSearchParams = Promise<Record<string, string | string[] | undefined>>;

export function referralMetadata(inviter: ReferralInviter): Metadata {
  const title = `${inviter.callsign} invites you to BLAST.FUN`;
  const rank = referralRank(inviter);
  const description = rank
    ? `Join @${inviter.callsign} on BLAST.FUN. Season Zero: ${inviter.title ? `${inviter.title} · ` : ""}${rank}.`
    : `Join @${inviter.callsign} on BLAST.FUN.`;
  const revision = createHash("sha256").update(JSON.stringify(inviter)).digest("hex").slice(0, 16);
  const image = new URL(`/referral/${inviter.callsign}/image?v=3-${revision}`, SITE_ORIGIN).href;
  return {
    title: { absolute: title }, description,
    alternates: { canonical: "/" },
    openGraph: {
      type: "website", siteName: "BLAST.FUN", title, description,
      url: new URL(referralPath(inviter.callsign), SITE_ORIGIN).href,
      images: [{ url: image, width: 1200, height: 675, type: "image/png", alt: description }],
    },
    twitter: { card: "summary_large_image", site: "@blastdotfun", title, description, images: [{ url: image, alt: description }] },
  };
}

/** Invalid, unknown and temporarily unavailable referrals retain the page's normal metadata. */
export async function referralMetadataFor(
  value: unknown,
  read: (callsign: string) => Promise<ReferralInviter | null>,
): Promise<Metadata | null> {
  const callsign = referralCallsign(value);
  if (!callsign) return null;
  try {
    const inviter = await read(callsign);
    return inviter ? referralMetadata(inviter) : null;
  } catch {
    return null;
  }
}
