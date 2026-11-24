-- The caller verifies Privy tokens locally. This capability resolves existing
-- accounts only; a DID supplied to SQL is not proof of authentication.
DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['blast_analytics_identity', 'blast_analytics_identity_owner'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname=role_name) THEN
      BEGIN EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
      EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END;
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname=role_name
      AND (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
      OR EXISTS (SELECT FROM pg_auth_members WHERE member=role_name::regrole) THEN
      RAISE EXCEPTION 'analytics identity roles must be restricted NOLOGIN capabilities';
    END IF;
  END LOOP;
END $$;
GRANT USAGE ON SCHEMA public TO blast_analytics_identity, blast_analytics_identity_owner;
GRANT SELECT(account_id,profile_id,privy_did,sui_address) ON public.social_accounts TO blast_analytics_identity_owner;
GRANT SELECT(provider,provider_subject,profile_id) ON public.mission_control_account_identities TO blast_analytics_identity_owner;
GRANT SELECT(address,account_id) ON public.social_account_wallets TO blast_analytics_identity_owner;
GRANT SELECT(sui_address,profile_id) ON public.mission_control_account_wallets TO blast_analytics_identity_owner;
GRANT SELECT(address,privy_did) ON public.presale_embedded_wallets TO blast_analytics_identity_owner;
GRANT SELECT(token_hash,wallet_address,revoked_at,expires_at,last_used_at) ON public.social_wallet_sessions TO blast_analytics_identity_owner;

CREATE FUNCTION public.analytics_account_id(privy_subject TEXT, wallet_token_hash TEXT)
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
  SELECT account_id FROM resolved WHERE account_id IS NOT NULL AND (SELECT count(*) FROM resolved)=1
$$;
REVOKE ALL ON FUNCTION public.analytics_account_id(TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.analytics_account_id(TEXT,TEXT) TO blast_analytics_identity;
-- PostgreSQL 16+ gives newly created roles ADMIN but no SET authority by default.
GRANT blast_analytics_identity_owner TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
-- Ownership requires CREATE briefly; the owner retains no ability to create objects.
GRANT CREATE ON SCHEMA public TO blast_analytics_identity_owner;
ALTER FUNCTION public.analytics_account_id(TEXT,TEXT) OWNER TO blast_analytics_identity_owner;
REVOKE CREATE ON SCHEMA public FROM blast_analytics_identity_owner;
