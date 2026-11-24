import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { referralCallsign } from "@blast/core/modules/social/referrals/contracts.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { trackRequestWork } from "@blast/server/lib/request-work.ts";
import { cachedCoinLogo, fetchCoinLogo } from "@blast/server/modules/presale/receipts/logo.ts";
import { fetchReferralAvatar } from "./share-avatar.ts";
import { renderShareImage } from "@blast/server/modules/share-images/renderer.ts";
import { createReferralImageRoute } from "./share-route.ts";
import { readReferralInviter } from "./share-read.ts";

// Published cards use the primary; their tables are unavailable to the replica role.
export function referralInviter(value: string) {
  const callsign = referralCallsign(value);
  if (!callsign) return Promise.resolve(null);
  return readReferralInviter(autocommitReader(primaryPool(), "social", { label: "social.referral_share" }), callsign);
}

export function referralShareRoute() {
  return processSingleton("social.referral-image", () => createReferralImageRoute({
    read: referralInviter,
    avatar: cachedCoinLogo((url) => fetchReferralAvatar(url, (candidate) => fetchCoinLogo(candidate, { trackWork: trackRequestWork })), { maxBytes: 4 * 1024 * 1024 }),
    render: (inviter, avatar) => renderShareImage({ kind: "referral", inviter, avatar }),
  }));
}
