-- Cluster-wide privilege role; a separately provisioned LOGIN inherits only this role.
-- No passwords or existing key/policy/recognition/quota rows are changed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'blast_partner_verifier') THEN
    BEGIN
      CREATE ROLE blast_partner_verifier NOLOGIN;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
    END;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'blast_partner_verifier'
    AND (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
    OR EXISTS (SELECT FROM pg_auth_members WHERE member = 'blast_partner_verifier'::regrole) THEN
    RAISE EXCEPTION 'blast_partner_verifier must be an unprivileged NOLOGIN role without inherited roles';
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO blast_partner_verifier;
GRANT SELECT (id, origins) ON public.partner_api_partners TO blast_partner_verifier;
GRANT SELECT (id, partner_id, key_hash, revoked_at, tier, requests_per_minute, requests_per_day)
  ON public.partner_api_keys TO blast_partner_verifier;
