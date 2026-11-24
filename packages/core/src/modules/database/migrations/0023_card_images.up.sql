-- Persisted card renders. Card records are immutable, so a (card, format,
-- record digest) key always names the same PNG bytes; the digest also covers
-- the renderer version, so artwork changes produce new rows instead of
-- overwriting old ones. Bytes live in object storage; this table is the index.
CREATE TABLE mission_control_card_images (
  card_id UUID NOT NULL REFERENCES mission_control_cards(card_id) ON DELETE CASCADE,
  format TEXT NOT NULL CHECK (format IN ('card', 'share')),
  record_digest TEXT NOT NULL CHECK (record_digest ~ '^[0-9a-f]{64}$'),
  pathname TEXT NOT NULL CHECK (length(pathname) BETWEEN 1 AND 512),
  url TEXT NOT NULL CHECK (length(url) BETWEEN 1 AND 2048),
  content_type TEXT NOT NULL CHECK (content_type = 'image/png'),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (card_id, format, record_digest)
);
