import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { autocommitRead, autocommitWrite } from "@blast/core/modules/database/transaction.ts";
import type {
  SocialAccount,
  SocialAccountKind,
  SocialAccountWallet,
  SocialPrivacy,
  SocialMeAccount,
  SocialWalletKind,
} from "@blast/core/modules/social/contracts/me.ts";
import type { SocialAccountLoader } from "../route-kit/contracts.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { WALLET_SESSION_ACTIVE_SQL } from "@blast/core/modules/social/wallet-sign-in/sessions.ts";

type AccountRow = {
  member_profile_id: string | null;
  account_id: string | null;
  kind: SocialAccountKind | null;
  callsign: string | null;
  display_name: string | null;
  avatar_url: string | null;
  x_handle: string | null;
  verified: boolean | null;
  onboarding_shown: boolean | null;
  onboarding_completed: boolean | null;
  privacy: SocialPrivacy | null;
  sharing_since_ms: string | null;
};

type WalletRow = {
  address: string;
  kind: SocialWalletKind;
  linked_at_ms: string;
};

/**
 * The caller's account, by Privy DID, in one statement. A member is the DID's
 * Mission Control profile (`mission_control_account_identities`, provider
 * `privy`); its account is the `social_accounts` row of that profile, and its
 * callsign, display name, avatar and X handle are the profile's. Without a
 * member identity the account is the new account holding the DID. The one row
 * always comes back: `member_profile_id` says whether a member row is missing.
 * Never selects a Privy DID or an X subject (only whether one is linked).
 */
const ACCOUNT_BY_DID = `
  SELECT
    CASE WHEN a.deleted_at IS NULL THEN member.profile_id END AS member_profile_id,
    CASE WHEN a.deleted_at IS NULL THEN a.account_id END AS account_id,
    CASE WHEN a.account_id IS NULL THEN NULL WHEN a.profile_id IS NULL THEN 'new' ELSE 'member' END AS kind,
    COALESCE(p.callsign, a.callsign) AS callsign,
    -- UI-06: the account's own name and picture choice win (as in social_account_identities, 0062).
    COALESCE(a.display_name, p.display_name) AS display_name,
    CASE a.picture WHEN 'upload' THEN a.picture_url WHEN 'none' THEN NULL
      ELSE CASE WHEN a.profile_id IS NULL THEN a.x_avatar_url ELSE COALESCE(p.avatar_reference, p.x_avatar_reference) END
    END AS avatar_url,
    CASE WHEN a.profile_id IS NULL THEN a.x_handle ELSE p.x_handle END AS x_handle,
    -- OA-8: verified means X linked (a member's profile always holds its X subject).
    CASE WHEN a.profile_id IS NULL THEN a.x_subject IS NOT NULL ELSE p.x_subject IS NOT NULL END AS verified,
    a.onboarding_shown_at IS NOT NULL AS onboarding_shown,
    a.onboarded_at IS NOT NULL AS onboarding_completed,
    a.privacy,
    floor(extract(epoch FROM a.sharing_since) * 1000)::bigint AS sharing_since_ms
  FROM (SELECT 1) AS one
  LEFT JOIN mission_control_account_identities member
    ON member.provider = 'privy' AND member.provider_subject = $1
  LEFT JOIN social_accounts a ON a.account_id = CASE
    WHEN member.profile_id IS NOT NULL THEN (SELECT account_id FROM social_accounts WHERE profile_id = member.profile_id)
    ELSE (SELECT account_id FROM social_accounts WHERE privy_did = $1)
  END
  LEFT JOIN mission_control_profiles p ON p.profile_id = a.profile_id`;

/**
 * Who holds a Sui address, each source looked up by address, best first: a
 * wallet-only account's own address, a proven social wallet, a Mission
 * Control member's wallet (its profile, whose `social_accounts` row may not
 * exist yet), a presale embedded wallet (through a new account's Privy DID
 * or a member's Privy identity). One row per source that holds it.
 */
const HOLDERS_BY_ADDRESS = `
  SELECT h.account_id, h.profile_id, guard.session_active
  FROM (SELECT ${WALLET_SESSION_ACTIVE_SQL} AS session_active) guard
  LEFT JOIN LATERAL (
    SELECT a.account_id, NULL::uuid AS profile_id, 0 AS rank
    FROM social_accounts a WHERE a.sui_address = $1 AND a.deleted_at IS NULL
    UNION ALL
    SELECT w.account_id, NULL::uuid, 1
    FROM social_account_wallets w JOIN social_accounts a ON a.account_id = w.account_id
    WHERE w.address = $1 AND a.deleted_at IS NULL
    UNION ALL
    SELECT a.account_id, w.profile_id, 2
    FROM mission_control_account_wallets w
    LEFT JOIN social_accounts a ON a.profile_id = w.profile_id
    WHERE w.sui_address = $1 AND a.deleted_at IS NULL
    UNION ALL
    SELECT COALESCE(own.account_id, member.account_id), i.profile_id, 3
    FROM presale_embedded_wallets e
    LEFT JOIN social_accounts own ON own.privy_did = e.privy_did
    LEFT JOIN mission_control_account_identities i ON i.provider = 'privy' AND i.provider_subject = e.privy_did
    LEFT JOIN social_accounts member ON member.profile_id = i.profile_id
    WHERE e.address = $1 AND own.deleted_at IS NULL AND member.deleted_at IS NULL
  ) AS h ON guard.session_active
  ORDER BY h.rank`;

/** An account's resolution row by account id (the shape `ACCOUNT_BY_DID` answers). */
const ACCOUNT_BY_ID = `
  SELECT
    NULL::uuid AS member_profile_id,
    a.account_id,
    CASE WHEN a.profile_id IS NULL THEN 'new' ELSE 'member' END AS kind,
    COALESCE(p.callsign, a.callsign) AS callsign,
    CASE WHEN a.profile_id IS NULL THEN a.display_name ELSE p.display_name END AS display_name,
    CASE WHEN a.profile_id IS NULL THEN a.x_avatar_url ELSE COALESCE(p.avatar_reference, p.x_avatar_reference) END AS avatar_url,
    CASE WHEN a.profile_id IS NULL THEN a.x_handle ELSE p.x_handle END AS x_handle,
    a.onboarding_shown_at IS NOT NULL AS onboarding_shown,
    a.onboarded_at IS NOT NULL AS onboarding_completed,
    a.privacy,
    floor(extract(epoch FROM a.sharing_since) * 1000)::bigint AS sharing_since_ms
  FROM social_accounts a
  LEFT JOIN mission_control_profiles p ON p.profile_id = a.profile_id
  WHERE a.account_id = $1 AND a.deleted_at IS NULL`;

/**
 * The account's wallets from `social_wallet_owners`, which already drops an
 * address two accounts reach and keeps an address's earliest link. Kind: a
 * Mission Control linked wallet keeps its kind (`embedded` or `slush`); a
 * presale embedded wallet is `embedded`; a proven social wallet is `slush`
 * when it says so, else `external`.
 */
export const WALLETS_BY_ACCOUNT = `
  SELECT
    o.address,
    CASE
      WHEN mw.wallet_kind IS NOT NULL THEN mw.wallet_kind
      WHEN o.source = 'presale_embedded'
        OR EXISTS (SELECT 1 FROM presale_embedded_wallets e WHERE e.address = o.address) THEN 'embedded'
      WHEN sw.kind IN ('embedded', 'slush') THEN sw.kind
      ELSE 'external'
    END AS kind,
    floor(extract(epoch FROM o.linked_at) * 1000)::bigint AS linked_at_ms
  FROM (
    SELECT w.sui_address AS address
    FROM social_accounts a JOIN mission_control_account_wallets w ON w.profile_id = a.profile_id
    WHERE a.account_id = $1
    UNION
    SELECT e.address
    FROM social_accounts a JOIN presale_embedded_wallets e ON e.privy_did = a.privy_did
    WHERE a.account_id = $1
    UNION
    SELECT e.address
    FROM social_accounts a
    JOIN mission_control_account_identities i ON i.profile_id = a.profile_id AND i.provider = 'privy'
    JOIN presale_embedded_wallets e ON e.privy_did = i.provider_subject
    WHERE a.account_id = $1
    UNION
    SELECT address FROM social_account_wallets WHERE account_id = $1
  ) mine
  -- Rank every claimant of each candidate address, preserving ambiguity and earliest-link rules.
  JOIN LATERAL (
    SELECT * FROM social_wallet_owners WHERE address = mine.address OFFSET 0
  ) o ON o.account_id = $1
  LEFT JOIN mission_control_account_wallets mw ON mw.sui_address = o.address
  LEFT JOIN social_account_wallets sw ON sw.address = o.address
  ORDER BY o.linked_at, o.address`;

/** Reuse the ownership query and order the aggregate explicitly at the snapshot boundary. */
function accountWithWallets(statement: string): string {
  const orderedWallets = WALLETS_BY_ACCOUNT.replace(
    "floor(extract(epoch FROM o.linked_at) * 1000)::bigint AS linked_at_ms",
    "floor(extract(epoch FROM o.linked_at) * 1000)::bigint AS linked_at_ms, o.linked_at AS linked_at_order",
  );
  if (orderedWallets === WALLETS_BY_ACCOUNT) throw new Error("The account wallet query must expose its full-precision ordering timestamp.");
  return `SELECT selected.*, COALESCE(wallets.entries, '[]'::jsonb) AS wallets
    FROM (${statement}) selected
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
        'address', wallet.address, 'kind', wallet.kind, 'linked_at_ms', wallet.linked_at_ms::text
      ) ORDER BY wallet.linked_at_order, wallet.address) AS entries
      FROM (${orderedWallets.replaceAll("$1", "selected.account_id")}) wallet
    ) wallets ON true`;
}

const ACCOUNT_WITH_WALLETS_BY_DID = accountWithWallets(ACCOUNT_BY_DID);
const ACCOUNT_WITH_WALLETS_BY_ID = accountWithWallets(ACCOUNT_BY_ID);
type AccountWithWalletsRow = AccountRow & { wallets: WalletRow[] };

function meAccount(row: AccountWithWalletsRow): SocialMeAccount | null {
  const resolved = account(row);
  return resolved ? {
    ...resolved,
    wallets: row.wallets.map((wallet) => ({ ...wallet, linked_at_ms: Number(wallet.linked_at_ms) })),
  } : null;
}

type WalletHolder = { account_id: string | null; profile_id: string | null };

/** Multiple evidence rows for one owner are valid; different owners are not. */
function walletHolder(holders: readonly WalletHolder[]): WalletHolder {
  const accounts = new Set(holders.map((holder) => holder.account_id).filter((id): id is string => id !== null));
  const profiles = new Set(holders.filter((holder) => holder.account_id === null && holder.profile_id).map((holder) => holder.profile_id!));
  if (accounts.size + profiles.size > 1) throw new SocialRouteError("wallet_ambiguous");
  return { account_id: [...accounts][0] ?? null, profile_id: [...profiles][0] ?? null };
}

function account(row: AccountRow): SocialAccount | null {
  if (!row.account_id || !row.kind || !row.callsign || !row.privacy) return null;
  return {
    account_id: row.account_id,
    kind: row.kind,
    callsign: row.callsign,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    x_handle: row.x_handle,
    verified: row.verified === true,
    onboarding: { shown: row.onboarding_shown === true, completed: row.onboarding_completed === true },
    privacy: row.privacy,
    sharing_since_ms: row.sharing_since_ms === null ? null : Number(row.sharing_since_ms),
  };
}

/**
 * Blast Account resolution and wallet listing on the primary pool (the pool
 * is resolved per call, so a configuration error fails that request as
 * `service_unavailable`).
 *
 * A signed-in caller resolves to at most one account: a member through its
 * Privy identity's profile, else a new account through its own Privy DID,
 * else none. A member's first resolution creates its `social_accounts` row
 * (`onboarded_at` null) with `INSERT … ON CONFLICT DO NOTHING`, then reads
 * it, so concurrent first calls create exactly one row.
 */
export class PostgresSocialAccounts implements SocialAccountLoader {
  readonly #pool: () => Pool;
  readonly #createId: () => string;

  constructor(pool: () => Pool, options: Readonly<{ createId?: () => string }> = {}) {
    this.#pool = pool;
    this.#createId = options.createId ?? randomUUID;
  }

  async resolve(did: string): Promise<SocialAccount | null> {
    const first = await this.#read(did);
    if (first.account_id || !first.member_profile_id) return account(first);
    await autocommitWrite(
      this.#pool(),
      "social",
      "social_accounts",
      "INSERT INTO social_accounts (account_id, profile_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [this.#createId(), first.member_profile_id],
    );
    return account(await this.#read(did));
  }

  /**
   * A wallet session's account (OA-16): whoever holds the address
   * (`HOLDERS_BY_ADDRESS`). A Mission Control member's first resolution
   * creates its `social_accounts` row as `resolve` does. An address two
   * different accounts hold is `wallet_ambiguous` (linking refuses that, so
   * only data from before the guard can hit it). No holder: null, a
   * wallet-only visitor who may create an account.
   */
  async resolveWallet(address: string, sessionId?: string): Promise<SocialAccount | null> {
    const accountId = await this.#walletAccountId(address, sessionId);
    if (!accountId) return null;
    const found: string = accountId;
    const result = await autocommitRead<AccountRow>(this.#pool(), "social", ACCOUNT_BY_ID, [found], {
      label: "social.account", prepare: true,
    });
    return result.rows[0] ? account(result.rows[0]) : null;
  }

  /** A Me snapshot: the ordinary Privy account and its wallets in one statement. */
  async resolveWithWallets(did: string): Promise<SocialMeAccount | null> {
    const first = await this.#readWithWallets(ACCOUNT_WITH_WALLETS_BY_DID, did);
    if (first.account_id || !first.member_profile_id) return meAccount(first);
    await autocommitWrite(
      this.#pool(), "social", "social_accounts",
      "INSERT INTO social_accounts (account_id, profile_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [this.#createId(), first.member_profile_id],
    );
    // A separate statement observes both our insert and a concurrent winner's row.
    return meAccount(await this.#readWithWallets(ACCOUNT_WITH_WALLETS_BY_DID, did));
  }

  /** Ownership is checked first; account fields and wallets then share a read snapshot. */
  async resolveWalletWithWallets(address: string, sessionId?: string): Promise<SocialMeAccount | null> {
    const accountId = await this.#walletAccountId(address, sessionId);
    if (!accountId) return null;
    const result = await autocommitRead<AccountWithWalletsRow>(
      this.#pool(), "social", ACCOUNT_WITH_WALLETS_BY_ID, [accountId],
      { label: "social.account_with_wallets", prepare: true },
    );
    return result.rows[0] ? meAccount(result.rows[0]) : null;
  }

  async #readWithWallets(statement: string, did: string): Promise<AccountWithWalletsRow> {
    const result = await autocommitRead<AccountWithWalletsRow>(this.#pool(), "social", statement, [did], {
      label: "social.account_with_wallets", prepare: true,
    });
    const row = result.rows[0];
    if (!row) throw new Error("The account statement returned no row.");
    return row;
  }

  async #walletAccountId(address: string, sessionId?: string): Promise<string | null> {
    const holder = walletHolder(await this.#holders(address, sessionId));
    if (holder.account_id || !holder.profile_id) return holder.account_id;
    await autocommitWrite(
      this.#pool(), "social", "social_accounts",
      "INSERT INTO social_accounts (account_id, profile_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [this.#createId(), holder.profile_id],
    );
    // The ownership reread must reject a competing owner that appeared during creation.
    return walletHolder(await this.#holders(address, sessionId)).account_id;
  }

  async #holders(address: string, sessionId?: string): Promise<WalletHolder[]> {
    const { rows } = await autocommitRead<WalletHolder & { session_active: boolean }>(
      this.#pool(),
      "social",
      HOLDERS_BY_ADDRESS,
      [address, sessionId ?? null],
      { label: "social.wallet_holders", prepare: true },
    );
    if (rows[0]?.session_active !== true) {
      throw Object.assign(new SocialRouteError("unauthorized"), { clearWallet: true });
    }
    return rows;
  }

  /** One round trip, with the exact same ownership/kind rules as a single account. */
  async walletsForAccounts(accountIds: readonly string[]): Promise<ReadonlyMap<string, readonly SocialAccountWallet[]>> {
    const result = new Map<string, SocialAccountWallet[]>(accountIds.map((id) => [id, []]));
    if (accountIds.length === 0) return result;
    const rows = await autocommitRead<WalletRow & { account_id: string }>(this.#pool(), "social",
      `SELECT selected.account_id::text, wallet.* FROM unnest($1::uuid[]) AS selected(account_id)
       CROSS JOIN LATERAL (${WALLETS_BY_ACCOUNT.replaceAll("$1", "selected.account_id")}) wallet`,
      [[...new Set(accountIds)]], { label: "social.account_wallets_batch", prepare: true });
    for (const row of rows.rows) result.get(row.account_id)!.push({ address: row.address, kind: row.kind, linked_at_ms: Number(row.linked_at_ms) });
    return result;
  }

  async wallets(accountId: string): Promise<SocialAccountWallet[]> {
    const result = await autocommitRead<WalletRow>(this.#pool(), "social", WALLETS_BY_ACCOUNT, [accountId], {
      label: "social.account_wallets", prepare: true,
    });
    return result.rows.map((row) => ({ address: row.address, kind: row.kind, linked_at_ms: Number(row.linked_at_ms) }));
  }

  async #read(did: string): Promise<AccountRow> {
    const result = await autocommitRead<AccountRow>(this.#pool(), "social", ACCOUNT_BY_DID, [did], {
      label: "social.account", prepare: true,
    });
    const row = result.rows[0];
    if (!row) throw new Error("The account statement returned no row.");
    return row;
  }
}
