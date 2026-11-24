CREATE TABLE social_presale_pins (
  presale_id TEXT PRIMARY KEY CHECK (presale_id ~ '^0x[0-9a-f]{64}$'),
  pinned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
REVOKE ALL ON social_presale_pins FROM PUBLIC;
GRANT SELECT ON social_presale_pins TO blast_replica;
GRANT SELECT, INSERT, DELETE ON social_presale_pins TO blast_web;
