-- A referral is assigned only when a new Blast account is inserted.
ALTER TABLE social_accounts
  ADD COLUMN referrer_account_id UUID REFERENCES social_accounts(account_id),
  ADD CONSTRAINT social_accounts_no_self_referral CHECK (account_id <> referrer_account_id);

CREATE INDEX social_accounts_referrer_idx ON social_accounts(referrer_account_id)
  WHERE referrer_account_id IS NOT NULL;

CREATE FUNCTION social_accounts_check_referrer() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.referrer_account_id IS DISTINCT FROM OLD.referrer_account_id THEN
    RAISE EXCEPTION 'an account referral is assigned only at creation'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'social_accounts_referrer_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER social_accounts_referrer_immutable
BEFORE UPDATE OF referrer_account_id ON social_accounts
FOR EACH ROW EXECUTE FUNCTION social_accounts_check_referrer();
