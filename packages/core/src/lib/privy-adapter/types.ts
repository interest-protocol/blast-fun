export const PRIVY_TOKEN_ISSUER = "privy.io" as const;

export type PrivyAccessClaims = Readonly<{
  appId: string;
  expiration: number;
  issuedAt: number;
  issuer: string;
  sessionId: string;
  userId: string;
}>;

export interface PrivyProviderGateway {
  verifyAccessToken(accessToken: string): Promise<PrivyAccessClaims>;
  getUser(privyDid: string): Promise<unknown>;
  createEmbeddedSuiWallet(input: Readonly<{
    chainType: "sui";
    ownerPrivyDid: string;
  }>): Promise<unknown>;
}

export type VerifiedXIdentity = Readonly<{
  authProvider: "privy";
  displayNameSuggestion: string | null;
  handle: string | null;
  avatarReference: string | null;
  callsignSuggestion: string | null;
  privyDid: string;
  proofReference: string;
  socialProvider: "x";
  verifiedAtEpochSeconds: number;
  xSubject: string;
}>;

export type EmbeddedSuiWallet = Readonly<{
  address: string;
  chain: "sui";
  created: boolean;
  custodyProvider: "privy";
  privyDid: string;
  providerWalletReference: string;
}>;

export type PrivyOnboardingProof = Readonly<{
  identity: VerifiedXIdentity;
  wallet: EmbeddedSuiWallet;
}>;

export interface PrivyOnboardingAdapter {
  verifyXIdentity(accessToken: string): Promise<VerifiedXIdentity>;
  verifyXIdentityAndGetExistingWallet(
    accessToken: string,
  ): Promise<PrivyOnboardingProof>;
  verifyXIdentityAndResolveWallet(
    accessToken: string,
  ): Promise<PrivyOnboardingProof>;
}

/** A verified Privy session of any login method: the DID stays server-side. */
export type PrivySession = Readonly<{
  privyDid: string;
  suiWalletAddress: string | null;
}>;

export interface PrivySessionVerifier {
  verifySession(accessToken: string): Promise<PrivySession>;
}

export type PrivyContractProbeResult = Readonly<{
  hasEmbeddedSuiWallet: boolean;
  hasVerifiedXIdentity: boolean;
  provider: "privy";
  reachable: true;
}>;
