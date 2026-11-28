SET LOCAL lock_timeout = '3s';

-- Keep account IDs and their history. A closed account can give up its last
-- sign-in address, but an active one must still have an identity.
ALTER TABLE social_accounts
  ADD COLUMN deleted_at TIMESTAMPTZ,
  DROP CONSTRAINT social_accounts_new_account_identity,
  ADD CONSTRAINT social_accounts_new_account_identity
    CHECK (deleted_at IS NOT NULL OR profile_id IS NOT NULL OR privy_did IS NOT NULL OR sui_address IS NOT NULL),
  ADD CONSTRAINT social_accounts_deleted_is_private
    CHECK (deleted_at IS NULL OR (privacy = 'private' AND NOT portfolio_public AND sui_address IS NULL));

GRANT DELETE ON TABLE social_account_wallets TO blast_web;

CREATE INDEX social_wallet_sessions_active_address_idx
  ON social_wallet_sessions (wallet_address) WHERE revoked_at IS NULL;

CREATE OR REPLACE VIEW social_account_identities AS
SELECT
  a.account_id,
  COALESCE(p.callsign, a.callsign) AS callsign,
  COALESCE(a.display_name, p.display_name) AS display_name,
  CASE a.picture
    WHEN 'upload' THEN a.picture_url
    WHEN 'none' THEN NULL
    ELSE CASE WHEN a.profile_id IS NULL THEN a.x_avatar_url ELSE COALESCE(p.avatar_reference, p.x_avatar_reference) END
  END AS avatar_url,
  CASE WHEN a.profile_id IS NULL THEN a.x_handle ELSE p.x_handle END AS x_handle,
  CASE WHEN a.profile_id IS NULL THEN a.x_subject IS NOT NULL ELSE p.x_subject IS NOT NULL END AS verified
FROM social_accounts a
LEFT JOIN mission_control_profiles p ON p.profile_id = a.profile_id
WHERE a.deleted_at IS NULL;

CREATE OR REPLACE VIEW social_account_callsigns AS
SELECT a.account_id, p.callsign
FROM social_accounts a JOIN mission_control_profiles p ON p.profile_id = a.profile_id
WHERE a.deleted_at IS NULL
UNION ALL
SELECT account_id, callsign FROM social_accounts WHERE profile_id IS NULL AND deleted_at IS NULL
UNION ALL
SELECT h.account_id, h.callsign FROM social_callsign_aliases h
JOIN social_accounts a ON a.account_id = h.account_id WHERE h.callsign <> a.callsign AND a.deleted_at IS NULL;

CREATE OR REPLACE VIEW social_wallet_owners WITH (security_invoker = true) AS
SELECT address, account_id, linked_at, source
FROM (
  SELECT
    linked.*,
    row_number() OVER (PARTITION BY address ORDER BY linked_at, source) AS rank,
    min(account_id::text) OVER (PARTITION BY address) = max(account_id::text) OVER (PARTITION BY address) AS sole
  FROM (
    SELECT w.sui_address AS address, a.account_id, w.verified_at AS linked_at, 'mission_control'::text AS source
    FROM mission_control_account_wallets w
    JOIN social_accounts a ON a.profile_id = w.profile_id AND a.deleted_at IS NULL
    UNION ALL
    SELECT e.address, a.account_id, e.resolved_at, 'presale_embedded'
    FROM presale_embedded_wallets e
    JOIN social_accounts a ON a.privy_did = e.privy_did AND a.deleted_at IS NULL
    UNION ALL
    SELECT e.address, a.account_id, e.resolved_at, 'presale_embedded'
    FROM presale_embedded_wallets e
    JOIN mission_control_account_identities i ON i.provider = 'privy' AND i.provider_subject = e.privy_did
    JOIN social_accounts a ON a.profile_id = i.profile_id AND a.deleted_at IS NULL
    UNION ALL
    SELECT w.address, w.account_id, w.verified_at, 'social'
    FROM social_account_wallets w
    JOIN social_accounts a ON a.account_id = w.account_id AND a.deleted_at IS NULL
  ) AS linked
) AS ranked
WHERE rank = 1 AND sole;

-- Future activity cannot resolve to a deleted account through a retained identity.
GRANT SELECT(deleted_at) ON public.social_accounts TO blast_analytics_identity_owner;
GRANT CREATE ON SCHEMA public TO blast_analytics_identity_owner;
SET LOCAL ROLE blast_analytics_identity_owner;
CREATE OR REPLACE FUNCTION public.analytics_account_id(privy_subject TEXT, wallet_token_hash TEXT)
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
  WITH credential AS (
    SELECT privy_subject AS did, NULL::text AS address
    WHERE wallet_token_hash IS NULL AND privy_subject ~ '^did:privy:[A-Za-z0-9_-]{1,128}$'
    UNION ALL
    SELECT NULL::text,s.wallet_address FROM public.social_wallet_sessions s
    WHERE privy_subject IS NULL AND wallet_token_hash ~ '^[0-9a-f]{64}$'
      AND s.token_hash=wallet_token_hash AND s.revoked_at IS NULL
      AND s.expires_at>statement_timestamp()
      AND s.last_used_at>statement_timestamp()-INTERVAL '7 days'
  ), did_owner AS (
    SELECT a.account_id
    FROM credential c
    LEFT JOIN public.mission_control_account_identities i ON i.provider='privy' AND i.provider_subject=c.did
    JOIN public.social_accounts a ON CASE WHEN i.profile_id IS NOT NULL
      THEN a.profile_id=i.profile_id ELSE a.privy_did=c.did END
    WHERE c.did IS NOT NULL
  ), wallet_holders AS (
    SELECT a.account_id,NULL::uuid AS profile_id FROM credential c
    JOIN public.social_accounts a ON a.sui_address=c.address
    UNION ALL
    SELECT w.account_id,NULL::uuid FROM credential c
    JOIN public.social_account_wallets w ON w.address=c.address
    UNION ALL
    SELECT a.account_id,w.profile_id FROM credential c
    JOIN public.mission_control_account_wallets w ON w.sui_address=c.address
    LEFT JOIN public.social_accounts a ON a.profile_id=w.profile_id
    UNION ALL
    SELECT coalesce(own.account_id,member.account_id),i.profile_id FROM credential c
    JOIN public.presale_embedded_wallets e ON e.address=c.address
    LEFT JOIN public.social_accounts own ON own.privy_did=e.privy_did
    LEFT JOIN public.mission_control_account_identities i ON i.provider='privy' AND i.provider_subject=e.privy_did
    LEFT JOIN public.social_accounts member ON member.profile_id=i.profile_id
  ), claimants AS (
    SELECT DISTINCT 'account:'||account_id::text AS claimant,account_id FROM wallet_holders WHERE account_id IS NOT NULL
    UNION
    SELECT DISTINCT 'profile:'||profile_id::text,NULL::uuid FROM wallet_holders WHERE account_id IS NULL AND profile_id IS NOT NULL
  ), resolved AS (
    SELECT account_id FROM did_owner
    UNION ALL
    SELECT account_id FROM claimants WHERE (SELECT count(*) FROM claimants)=1
  )
  SELECT r.account_id FROM resolved r
  JOIN public.social_accounts a ON a.account_id = r.account_id AND a.deleted_at IS NULL
  WHERE (SELECT count(*) FROM resolved)=1
$$;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM blast_analytics_identity_owner;
