import type { LinkedWalletDto } from "@blast/core/modules/mission-control/account-links/contracts.ts";

export const OWNER_RECRUIT_PAGE_MAX = 25;
export type Fleet = "Recon" | "Foundry" | "Signal" | "Ground";
export type OwnerWalletKind = "embedded" | "slush";

export type OwnerProfileDto = Readonly<{
  callsignPath: string;
  profile: Readonly<{
    avatarReference: string | null;
    callsign: string;
    displayName: string | null;
    resolvedDisplayName: string;
  }>;
  social: Readonly<{
    avatarReference: string | null;
    handle: string | null;
    verified: true;
  }>;
  wallet: Readonly<{
    address: string;
    kind: OwnerWalletKind;
    state: "verified";
  }>;
  wallets: readonly LinkedWalletDto[];
  membership: Readonly<{
    crewNumber: number;
    fleet: Fleet;
    fleetTitle: `${Fleet} Fleet`;
    gold: boolean;
    ownerTitle: string;
    zeroFleet: boolean;
  }>;
  card: Readonly<{ id: string }>;
  recruitTotal: number;
  codeTotal: number;
  rewards: Readonly<{
    followedBlast: boolean;
    rewarded: boolean;
    sharedOnX: boolean;
    telegramUsername: string | null;
  }>;
}>;

export type OwnerRecruitDto = Readonly<{
  callsign: string;
  completedAt: string;
  crewNumber: number;
  displayName: string | null;
  fleet: Fleet;
  ownerTitle: string;
  x: Readonly<{
    avatarReference: string | null;
    handle: string | null;
  }>;
}>;

export type OwnerRecruitPageDto = Readonly<{
  items: readonly OwnerRecruitDto[];
  nextCursor: string | null;
}>;

export type DisplayNameDto = Readonly<{
  callsign: string;
  displayName: string | null;
  resolvedDisplayName: string;
}>;

export type RecruitCursorPosition = Readonly<{
  completedAt: string;
  profileId: string;
}>;
