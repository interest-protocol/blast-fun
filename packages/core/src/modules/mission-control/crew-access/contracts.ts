export type RecoveryWalletKind = "embedded" | "slush";

export type CrewRestoreChallengeRequest = Readonly<{
  address: string;
  recoveryId: string;
  walletKind: RecoveryWalletKind;
}>;

export type CrewRestoreVerifyRequest = CrewRestoreChallengeRequest &
  Readonly<{
    challengeId: string;
    message: string;
    signature: string;
  }>;

export type CrewRestoreChallengeDto = Readonly<{
  challengeId: string;
  expiresAt: string;
  message: string;
}>;
