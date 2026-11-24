export const ACCOUNT_IDENTITY_PROVIDERS = ["x", "google", "privy"] as const;
export type AccountIdentityProvider = (typeof ACCOUNT_IDENTITY_PROVIDERS)[number];

export const ACCOUNT_WALLET_KINDS = ["embedded", "slush"] as const;
export type AccountWalletKind = (typeof ACCOUNT_WALLET_KINDS)[number];

export type LinkedWalletDto = Readonly<{
  id: string;
  address: string;
  kind: AccountWalletKind;
  primary: boolean;
  state: "verified";
}>;
