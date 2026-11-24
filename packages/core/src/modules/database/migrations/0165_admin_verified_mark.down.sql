DROP TRIGGER social_operator_log_admin_console_only ON social_operator_log;
DROP FUNCTION social_operator_log_admin_console_only();
REVOKE INSERT (presale_id, verified_team, verified_by, verified_at_ms, note, updated_at_ms),
  UPDATE (verified_team, verified_by, verified_at_ms, note, updated_at_ms)
  ON TABLE social_sale_trust FROM blast_web;
REVOKE INSERT, DELETE ON TABLE social_coin_trust FROM blast_web;
REVOKE INSERT ON TABLE social_operator_log FROM blast_web;
