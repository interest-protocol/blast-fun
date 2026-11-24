-- Jose 2026-11-21: the pink "Team verified by Blast" mark is set and cleared
-- only from the admin website (admin.blast.fun), behind its admin password.
-- Its server calls the backend's operator route `/api/admin/verified-mark`
-- with the operator bearer; the backend runs as `blast_web`. The operator CLI
-- no longer writes the mark (`coin trust set|clear` are gone, `sale trust`
-- takes `--audited` only); its list and history commands stay.
--
-- Each change still appends one `social_operator_log` row (operator
-- `admin-console`, the required reason) in the same transaction, so the web
-- role may now insert log rows. The log stays append-only: its triggers
-- refuse every update, delete and truncate, whoever runs them.
--
-- Narrow on purpose: on a sale's row the web role may write only the verified
-- columns, never `audited` or its setter, and it never deletes a row. A curve
-- coin's row is the mark itself, so the web role inserts and deletes it.
-- Existing rows are not touched.
--
-- A role that is not the log's owner (the operator CLI runs as the owner) may
-- append only the admin website's own rows: operator `admin-console`, a mark
-- action and a reason. So a bug or injection on a web path cannot forge
-- another operator's history.
GRANT INSERT ON TABLE social_operator_log TO blast_web;
GRANT INSERT, DELETE ON TABLE social_coin_trust TO blast_web;
GRANT INSERT (presale_id, verified_team, verified_by, verified_at_ms, note, updated_at_ms),
  UPDATE (verified_team, verified_by, verified_at_ms, note, updated_at_ms)
  ON TABLE social_sale_trust TO blast_web;

CREATE FUNCTION social_operator_log_admin_console_only()
RETURNS trigger LANGUAGE plpgsql
-- Pinned so a temp table named pg_class cannot stand in for the catalog.
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE')
     AND (NEW.operator_id IS DISTINCT FROM 'admin-console'
       OR NEW.action NOT IN ('coin.trust.set', 'coin.trust.clear', 'sale.trust.set', 'sale.trust.clear')
       OR btrim(coalesce(NEW.reason, '')) = '') THEN
    RAISE EXCEPTION 'social_operator_log: only the admin website''s verified-mark rows may be appended by %', current_user
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER social_operator_log_admin_console_only
  BEFORE INSERT ON social_operator_log
  FOR EACH ROW EXECUTE FUNCTION social_operator_log_admin_console_only();
