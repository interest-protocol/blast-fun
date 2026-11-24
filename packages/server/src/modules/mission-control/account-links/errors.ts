export type AccountLinksErrorCode =
  | "ACCOUNT_LINK_INVALID"
  | "IDENTITY_ALREADY_LINKED"
  | "WALLET_ALREADY_LINKED"
  | "WALLET_KIND_ALREADY_LINKED"
  | "WALLET_NOT_FOUND"
  | "ACCOUNT_LINK_UNAVAILABLE";

const MESSAGES: Record<AccountLinksErrorCode, string> = {
  ACCOUNT_LINK_INVALID: "The account link request is invalid.",
  IDENTITY_ALREADY_LINKED: "That identity belongs to another Blast account.",
  WALLET_ALREADY_LINKED: "That wallet belongs to another Blast account.",
  WALLET_KIND_ALREADY_LINKED: "That wallet type is already linked.",
  WALLET_NOT_FOUND: "The linked wallet was not found.",
  ACCOUNT_LINK_UNAVAILABLE: "Account linking is temporarily unavailable.",
};

export class AccountLinksError extends Error {
  readonly code: AccountLinksErrorCode;

  constructor(code: AccountLinksErrorCode) {
    super(MESSAGES[code]);
    this.name = "AccountLinksError";
    this.code = code;
  }
}
