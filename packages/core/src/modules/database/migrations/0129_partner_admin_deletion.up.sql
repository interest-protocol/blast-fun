-- Runtime may delete only revoked keys or groups without active keys. Keep a
-- separate, immutable deletion receipt without hashes or raw credentials.
CREATE TABLE partner_api_deletion_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  object_type TEXT NOT NULL CHECK (object_type IN ('key', 'partner')),
  target_id TEXT NOT NULL,
  partner_id TEXT NOT NULL,
  deleted_key_count INTEGER NOT NULL CHECK (deleted_key_count >= 0),
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_by TEXT NOT NULL CHECK (deleted_by ~ '^operator:[A-Za-z0-9][A-Za-z0-9._@-]{2,99}$')
);
REVOKE ALL ON TABLE partner_api_deletion_events FROM PUBLIC;
GRANT SELECT ON partner_api_deletion_events TO blast_web;

CREATE FUNCTION partner_delete_revoked_key(target_id UUID, by_actor TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  owner_id TEXT;
  revoked TIMESTAMPTZ;
BEGIN
  IF by_actor IS NULL OR by_actor !~ '^operator:[A-Za-z0-9][A-Za-z0-9._@-]{2,99}$' THEN
    RAISE EXCEPTION 'invalid deletion actor';
  END IF;
  SELECT partner_id INTO owner_id FROM public.partner_api_keys WHERE id = target_id;
  IF NOT FOUND THEN RETURN false; END IF;
  -- Match group deletion lock order and serialize with FK checks on issuance.
  PERFORM 1 FROM public.partner_api_partners WHERE id = owner_id FOR UPDATE;
  SELECT revoked_at INTO revoked FROM public.partner_api_keys WHERE id = target_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF revoked IS NULL THEN
    RAISE EXCEPTION 'revoke key before deletion'
      USING ERRCODE = '23514', CONSTRAINT = 'partner_deletion_requires_revocation';
  END IF;
  DELETE FROM public.partner_api_key_policy_events WHERE key_id = target_id;
  DELETE FROM public.partner_api_keys WHERE id = target_id;
  INSERT INTO public.partner_api_deletion_events (object_type, target_id, partner_id, deleted_key_count, deleted_by)
  VALUES ('key', target_id::TEXT, owner_id, 1, by_actor);
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION partner_delete_revoked_key(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION partner_delete_revoked_key(UUID, TEXT) TO blast_web;

CREATE FUNCTION partner_delete_inactive_group(target_id TEXT, by_actor TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  IF by_actor IS NULL OR by_actor !~ '^operator:[A-Za-z0-9][A-Za-z0-9._@-]{2,99}$' THEN
    RAISE EXCEPTION 'invalid deletion actor';
  END IF;
  PERFORM 1 FROM public.partner_api_partners WHERE id = target_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.partner_api_keys WHERE partner_id = target_id AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'revoke all keys before group deletion'
      USING ERRCODE = '23514', CONSTRAINT = 'partner_deletion_requires_revocation';
  END IF;
  DELETE FROM public.partner_api_key_policy_events e USING public.partner_api_keys k
  WHERE e.key_id = k.id AND k.partner_id = target_id;
  DELETE FROM public.partner_api_keys WHERE partner_id = target_id;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  DELETE FROM public.partner_api_partners WHERE id = target_id;
  INSERT INTO public.partner_api_deletion_events (object_type, target_id, partner_id, deleted_key_count, deleted_by)
  VALUES ('partner', target_id, target_id, deleted_count, by_actor);
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION partner_delete_inactive_group(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION partner_delete_inactive_group(TEXT, TEXT) TO blast_web;
