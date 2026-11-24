DROP FUNCTION IF EXISTS public.analytics_account_id(TEXT,TEXT);
-- Cluster-wide roles can be used by another database; remove only this database's grants.
REVOKE ALL ON SCHEMA public FROM blast_analytics_identity,blast_analytics_identity_owner;
REVOKE SELECT(account_id,profile_id,privy_did,sui_address) ON public.social_accounts FROM blast_analytics_identity_owner;
REVOKE SELECT(provider,provider_subject,profile_id) ON public.mission_control_account_identities FROM blast_analytics_identity_owner;
REVOKE SELECT(address,account_id) ON public.social_account_wallets FROM blast_analytics_identity_owner;
REVOKE SELECT(sui_address,profile_id) ON public.mission_control_account_wallets FROM blast_analytics_identity_owner;
REVOKE SELECT(address,privy_did) ON public.presale_embedded_wallets FROM blast_analytics_identity_owner;
REVOKE SELECT(token_hash,wallet_address,revoked_at,expires_at,last_used_at) ON public.social_wallet_sessions FROM blast_analytics_identity_owner;
