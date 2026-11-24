ALTER TABLE presale_sponsor_reservations
  ADD COLUMN deployment_fingerprint TEXT
  CHECK (deployment_fingerprint ~ '^[0-9a-f]{64}$');
