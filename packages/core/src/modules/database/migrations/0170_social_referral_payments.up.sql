CREATE TABLE social_referral_payments (
  account_id UUID NOT NULL REFERENCES social_accounts(account_id),
  month DATE NOT NULL CHECK (extract(day FROM month) = 1),
  amount_atoms NUMERIC(20, 0) NOT NULL CHECK (amount_atoms > 0 AND amount_atoms <= 18446744073709551615),
  digest TEXT NOT NULL CHECK (digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  recipient TEXT NOT NULL CHECK (recipient ~ '^0x[0-9a-f]{64}$'),
  PRIMARY KEY (account_id, month),
  UNIQUE (digest, recipient)
);

REVOKE ALL ON social_referral_payments FROM PUBLIC;
GRANT SELECT (account_id, month, amount_atoms, digest) ON social_referral_payments TO blast_web;
