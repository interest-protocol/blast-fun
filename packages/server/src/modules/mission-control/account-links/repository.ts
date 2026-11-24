import type { TransactionContext } from "@blast/core/modules/database/transaction.ts";
import type { AccountIdentityProvider, AccountWalletKind, LinkedWalletDto } from "@blast/core/modules/mission-control/account-links/contracts.ts";

interface WalletRow {
  wallet_id: string;
  sui_address: string;
  wallet_kind: AccountWalletKind;
  is_primary: boolean;
}

export class AccountLinksRepository {
  async createInitialLinks(
    transaction: TransactionContext,
    input: Readonly<{
      profileId: string;
      privyDid: string;
      xSubject: string;
      walletAddress: string;
      walletKind: AccountWalletKind;
      providerWalletReference: string;
      verifiedAt: string;
    }>,
  ): Promise<void> {
    const account = transaction.forModule("account");
    // One statement; rows insert in order, so a conflict on X is still
    // reported before one on Privy.
    await account.write(
      "mission_control_account_identities",
      `INSERT INTO mission_control_account_identities (
         profile_id, provider, provider_subject, verified_at
       ) VALUES ($1, 'x', $2, $4), ($1, 'privy', $3, $4)`,
      [input.profileId, input.xSubject, input.privyDid, input.verifiedAt],
    );
    await account.write(
      "mission_control_account_wallets",
      `INSERT INTO mission_control_account_wallets (
         wallet_id, profile_id, wallet_kind, sui_address,
         provider_wallet_reference, is_primary, verified_at
       ) VALUES ($1, $1, $2, $3, $4, TRUE, $5)`,
      [
        input.profileId,
        input.walletKind,
        input.walletAddress,
        input.providerWalletReference,
        input.verifiedAt,
      ],
    );
  }

  async addIdentity(
    transaction: TransactionContext,
    input: Readonly<{
      profileId: string;
      provider: AccountIdentityProvider;
      subject: string;
      verifiedAt: string;
    }>,
  ): Promise<"linked" | "already-linked" | "conflict"> {
    const account = transaction.forModule("account");
    const [firstClaim, secondClaim] = [
      `identity-profile:${input.profileId}:${input.provider}`,
      `identity-subject:${input.provider}:${input.subject}`,
    ].sort();
    await transaction.read("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [firstClaim]);
    await transaction.read("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [secondClaim]);

    const existing = await transaction.read<{
      profile_id: string;
      provider_subject: string;
    }>(
      `SELECT profile_id::text, provider_subject
       FROM mission_control_account_identities
       WHERE (profile_id = $1 AND provider = $2)
          OR (provider = $2 AND provider_subject = $3)
       FOR UPDATE`,
      [input.profileId, input.provider, input.subject],
    );
    if (
      existing.rows.some(
        (row) =>
          row.profile_id !== input.profileId ||
          row.provider_subject !== input.subject,
      )
    ) {
      return "conflict";
    }
    if (existing.rows.length > 0) return "already-linked";

    await account.write(
      "mission_control_account_identities",
      `INSERT INTO mission_control_account_identities (
         profile_id, provider, provider_subject, verified_at
       ) VALUES ($1, $2, $3, $4)`,
      [input.profileId, input.provider, input.subject, input.verifiedAt],
    );
    return "linked";
  }

  async listWallets(
    transaction: TransactionContext,
    profileId: string,
  ): Promise<readonly LinkedWalletDto[]> {
    const result = await transaction.read<WalletRow>(
      `SELECT wallet_id, sui_address, wallet_kind, is_primary
       FROM mission_control_account_wallets
       WHERE profile_id = $1
       ORDER BY is_primary DESC, created_at, wallet_id`,
      [profileId],
    );
    return result.rows.map((row) => ({
      id: row.wallet_id,
      address: row.sui_address,
      kind: row.wallet_kind,
      primary: row.is_primary,
      state: "verified" as const,
    }));
  }

  async lockClaims(
    transaction: TransactionContext,
    profileId: string,
    kind: AccountWalletKind,
    address: string,
  ): Promise<void> {
    const [firstClaim, secondClaim] = [`account:${profileId}:${kind}`, `sui:${address}`].sort();
    await transaction.read("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [firstClaim]);
    await transaction.read("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [secondClaim]);
  }

  async findWalletClaim(
    transaction: TransactionContext,
    profileId: string,
    kind: AccountWalletKind,
    address: string,
  ): Promise<Readonly<{
    addressProfileId: string | null;
    kindWalletId: string | null;
  }>> {
    const result = await transaction.read<{
      address_profile_id: string | null;
      kind_wallet_id: string | null;
    }>(
      `SELECT
         (SELECT profile_id::text FROM mission_control_account_wallets
          WHERE sui_address = $1) AS address_profile_id,
         (SELECT wallet_id::text FROM mission_control_account_wallets
          WHERE profile_id = $2 AND wallet_kind = $3) AS kind_wallet_id`,
      [address, profileId, kind],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Wallet claim check returned no row.");
    return {
      addressProfileId: row.address_profile_id,
      kindWalletId: row.kind_wallet_id,
    };
  }

  async addWallet(
    transaction: TransactionContext,
    input: Readonly<{
      walletId: string;
      profileId: string;
      kind: AccountWalletKind;
      address: string;
      providerWalletReference: string;
      verifiedAt: string;
    }>,
  ): Promise<void> {
    await transaction.forModule("account").write(
      "mission_control_account_wallets",
      `INSERT INTO mission_control_account_wallets (
         wallet_id, profile_id, wallet_kind, sui_address,
         provider_wallet_reference, is_primary, verified_at
       ) VALUES ($1, $2, $3, $4, $5, FALSE, $6)`,
      [
        input.walletId,
        input.profileId,
        input.kind,
        input.address,
        input.providerWalletReference,
        input.verifiedAt,
      ],
    );
  }

  async setPrimary(
    transaction: TransactionContext,
    profileId: string,
    walletId: string,
  ): Promise<boolean> {
    await transaction.read(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`primary-wallet:${profileId}`],
    );
    const target = await transaction.read<{ wallet_id: string }>(
      `SELECT wallet_id FROM mission_control_account_wallets
       WHERE wallet_id = $1 AND profile_id = $2
       FOR UPDATE`,
      [walletId, profileId],
    );
    if (!target.rows[0]) return false;
    const account = transaction.forModule("account");
    await account.write(
      "mission_control_account_wallets",
      `UPDATE mission_control_account_wallets
       SET is_primary = FALSE
       WHERE profile_id = $1 AND is_primary`,
      [profileId],
    );
    await account.write(
      "mission_control_account_wallets",
      `UPDATE mission_control_account_wallets
       SET is_primary = TRUE
       WHERE wallet_id = $1 AND profile_id = $2`,
      [walletId, profileId],
    );
    return true;
  }
}
