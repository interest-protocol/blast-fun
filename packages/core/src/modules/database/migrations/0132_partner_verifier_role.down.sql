REVOKE SELECT (id, origins) ON public.partner_api_partners FROM blast_partner_verifier;
REVOKE SELECT (id, partner_id, key_hash, revoked_at, tier, requests_per_minute, requests_per_day)
  ON public.partner_api_keys FROM blast_partner_verifier;
-- Keep the cluster-wide NOLOGIN role and schema USAGE: another database or a
-- separately provisioned login may still use it. No CASCADE or data deletion.
