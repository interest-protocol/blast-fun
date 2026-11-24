-- Delete only the reserved, per-run release fixtures. Real partner audit rows
-- retain their existing append-only permissions; runtime gets no DELETE grant.
CREATE FUNCTION partner_cleanup_release_fixture(run_label TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  fixture RECORD;
  uuid_pattern CONSTANT TEXT := '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
BEGIN
  IF run_label IS NOT NULL AND run_label !~ ('^release-gate:' || uuid_pattern || '$') THEN
    RAISE EXCEPTION 'invalid release fixture label';
  END IF;
  FOR fixture IN
    SELECT p.id, 'release-gate:' || substr(p.id, 21) AS label
    FROM public.partner_api_partners p
    WHERE p.id ~ ('^ci-partner-read-api-' || uuid_pattern || '$')
      AND CASE WHEN run_label IS NULL THEN p.created_at < now() - interval '1 hour'
        ELSE p.id = 'ci-partner-read-api-' || substr(run_label, 14) END
    ORDER BY p.id FOR UPDATE
  LOOP
    DELETE FROM public.partner_api_key_policy_events e
    USING public.partner_api_keys k
    WHERE e.key_id = k.id AND k.partner_id = fixture.id AND k.label = fixture.label;
    DELETE FROM public.partner_api_keys
    WHERE partner_id = fixture.id AND label = fixture.label;
    DELETE FROM public.partner_api_partners p
    WHERE p.id = fixture.id
      AND NOT EXISTS (SELECT 1 FROM public.partner_api_keys k WHERE k.partner_id = p.id);
    IF run_label IS NOT NULL AND EXISTS (SELECT 1 FROM public.partner_api_partners WHERE id = fixture.id) THEN
      RAISE EXCEPTION 'release fixture cleanup incomplete';
    END IF;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION partner_cleanup_release_fixture(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION partner_cleanup_release_fixture(TEXT) TO blast_web;
