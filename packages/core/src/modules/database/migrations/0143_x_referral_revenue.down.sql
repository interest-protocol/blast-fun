DROP TRIGGER mission_control_profiles_referral_code_guard ON mission_control_profiles;
DROP TRIGGER social_accounts_referral_code_guard ON social_accounts;
DROP FUNCTION social_guard_reserved_referral_code();
DROP TRIGGER social_accounts_claim_referral ON social_accounts;
DROP FUNCTION social_claim_referral_reservation();
DROP TRIGGER social_accounts_referrer_immutable ON social_accounts;
ALTER TABLE social_accounts DROP COLUMN referrer_reservation_code;
CREATE OR REPLACE FUNCTION social_accounts_check_referrer() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.referrer_account_id IS DISTINCT FROM OLD.referrer_account_id THEN
    RAISE EXCEPTION 'an account referral is assigned only at creation'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'social_accounts_referrer_immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER social_accounts_referrer_immutable BEFORE UPDATE OF referrer_account_id ON social_accounts
  FOR EACH ROW EXECUTE FUNCTION social_accounts_check_referrer();
DROP TABLE social_referral_events,social_referral_entities,social_referral_reservations;

-- A reapply must replay native receipts instead of resuming a cursor for dropped rows.
DELETE FROM social_worker_state WHERE name = 'referral-accounting';
