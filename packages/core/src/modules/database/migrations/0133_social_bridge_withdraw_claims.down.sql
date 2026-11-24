DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM social_bridge_withdraw_claims) THEN
    RAISE EXCEPTION '0133 down: withdrawal claims retain reservation identities; refusing to delete them';
  END IF;
END
$$;
DROP TABLE presale_sponsor_budget_attempts;
DROP FUNCTION presale_sponsor_budget_attempts_check_update();
DROP TABLE social_bridge_withdraw_claims;
DROP FUNCTION social_bridge_withdraw_claims_check_update();
