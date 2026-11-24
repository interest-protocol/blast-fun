import { CARD_EDITION_NAMES, cardEditionForCrew } from "@blast/core/modules/mission-control/card-renderer/editions.ts";


export type ReferralInviter = Readonly<{ callsign: string; crew: number | null; title: string | null; avatarUrl: string | null }>;


export function referralRank(inviter: ReferralInviter): string | null {
  if (!Number.isSafeInteger(inviter.crew) || inviter.crew === null || inviter.crew < 1 || inviter.crew > 999999) return null;
  return `${CARD_EDITION_NAMES[cardEditionForCrew(inviter.crew)]} · Crew #${inviter.crew}`;
}
