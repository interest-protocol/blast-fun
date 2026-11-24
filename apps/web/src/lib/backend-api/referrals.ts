import "server-only";

import { referralCallsign } from "@blast/core/modules/social/referrals/contracts.ts";
import {
  REFERRAL_CONTEXT_MAX_BYTES,
  decodeReferralContext,
} from "@blast/core/modules/social/referrals/share-context.ts";
import { referralMetadataFor, type ReferralSearchParams } from "#web/modules/social/referrals/share.ts";
import {
  boundedPageText,
  readPrivateBackendPage,
  type BackendPageReadDependencies,
} from "./private-page-read.ts";

export function referralBackendPageRead(dependencies?: BackendPageReadDependencies) {
  return async (value: string) => {
    const callsign = referralCallsign(value);
    if (!callsign) return null;
    const response = await readPrivateBackendPage(
      `/api/social/referral-inviter/${encodeURIComponent(callsign)}`,
      dependencies,
    );
    return decodeReferralContext(
      await boundedPageText(response, REFERRAL_CONTEXT_MAX_BYTES, "Referral context unavailable"),
      callsign,
    );
  };
}

const read = referralBackendPageRead();

export async function referralPageMetadata(searchParams: ReferralSearchParams) {
  return referralMetadataFor((await searchParams).ref, read);
}
