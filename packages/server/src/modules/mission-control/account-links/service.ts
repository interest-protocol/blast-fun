import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { withTransaction } from "@blast/core/modules/database/transaction.ts";
import { canonicalSuiAddress } from "@blast/server/modules/mission-control/wallet-challenges/index.ts";
import type {
  AccountIdentityProvider,
  AccountWalletKind,
  LinkedWalletDto,
} from "@blast/core/modules/mission-control/account-links/contracts.ts";
import { AccountLinksError } from "./errors.ts";
import { AccountLinksRepository } from "./repository.ts";

export class AccountLinksService {
  readonly #pool: Pool;
  readonly #repository: AccountLinksRepository;
  readonly #createId: () => string;
  readonly #clock: () => Date;

  constructor(input: Readonly<{
    pool: Pool;
    repository?: AccountLinksRepository;
    createId?: () => string;
    clock?: () => Date;
  }>) {
    this.#pool = input.pool;
    this.#repository = input.repository ?? new AccountLinksRepository();
    this.#createId = input.createId ?? randomUUID;
    this.#clock = input.clock ?? (() => new Date());
  }

  listWallets(profileId: string): Promise<readonly LinkedWalletDto[]> {
    return withTransaction(this.#pool, (transaction) =>
      this.#repository.listWallets(transaction, profileId),
    );
  }

  async attachWallet(input: Readonly<{
    profileId: string;
    kind: AccountWalletKind;
    address: string;
    providerWalletReference: string;
    identity?: Readonly<{
      provider: AccountIdentityProvider;
      subject: string;
    }>;
  }>): Promise<readonly LinkedWalletDto[]> {
    let address: string;
    try {
      address = canonicalSuiAddress(input.address);
    } catch {
      throw new AccountLinksError("ACCOUNT_LINK_INVALID");
    }
    if (!input.profileId || !input.providerWalletReference) {
      throw new AccountLinksError("ACCOUNT_LINK_INVALID");
    }
    const now = this.#clock().toISOString();
    try {
      return await withTransaction(
        this.#pool,
        async (transaction) => {
          await this.#repository.lockClaims(
            transaction,
            input.profileId,
            input.kind,
            address,
          );
          const claim = await this.#repository.findWalletClaim(
            transaction,
            input.profileId,
            input.kind,
            address,
          );
          if (claim.addressProfileId && claim.addressProfileId !== input.profileId) {
            throw new AccountLinksError("WALLET_ALREADY_LINKED");
          }
          if (claim.kindWalletId) {
            throw new AccountLinksError("WALLET_KIND_ALREADY_LINKED");
          }
          if (input.identity) {
            const identityClaim = await this.#repository.addIdentity(transaction, {
              profileId: input.profileId,
              provider: input.identity.provider,
              subject: input.identity.subject,
              verifiedAt: now,
            });
            if (identityClaim === "conflict") {
              throw new AccountLinksError("IDENTITY_ALREADY_LINKED");
            }
          }
          await this.#repository.addWallet(transaction, {
            address,
            kind: input.kind,
            profileId: input.profileId,
            providerWalletReference: input.providerWalletReference,
            verifiedAt: now,
            walletId: this.#createId(),
          });
          return this.#repository.listWallets(transaction, input.profileId);
        },
        { isolationLevel: "SERIALIZABLE", label: "account-link", retry: true },
      );
    } catch (error) {
      if (error instanceof AccountLinksError) throw error;
      const constraint = (error as { constraint?: unknown })?.constraint;
      if (constraint === "mission_control_account_identities_subject_unique") {
        throw new AccountLinksError("IDENTITY_ALREADY_LINKED");
      }
      if (constraint === "mission_control_account_wallets_address_unique") {
        throw new AccountLinksError("WALLET_ALREADY_LINKED");
      }
      if (constraint === "mission_control_account_wallets_profile_kind_unique") {
        throw new AccountLinksError("WALLET_KIND_ALREADY_LINKED");
      }
      throw new AccountLinksError("ACCOUNT_LINK_UNAVAILABLE");
    }
  }

  async setPrimary(
    profileId: string,
    walletId: string,
  ): Promise<readonly LinkedWalletDto[]> {
    if (!profileId || !walletId) {
      throw new AccountLinksError("ACCOUNT_LINK_INVALID");
    }
    return withTransaction(this.#pool, async (transaction) => {
      if (!(await this.#repository.setPrimary(transaction, profileId, walletId))) {
        throw new AccountLinksError("WALLET_NOT_FOUND");
      }
      return this.#repository.listWallets(transaction, profileId);
    });
  }
}
