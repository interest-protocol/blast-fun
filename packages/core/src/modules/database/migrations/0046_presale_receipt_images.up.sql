-- Presale (T-012): the catalog of rendered receipt images
-- (`GET /api/presale/receipts/{presale_id}/{wallet}/image`, card-images
-- service). A receipt has no season-zero card, so it cannot share
-- mission_control_card_images (keyed by card_id). A (presale, wallet, format,
-- record digest) key always names the same PNG bytes: the digest covers the
-- receipt record and the receipt renderer version. Bytes live in object
-- storage; this table is the index. The web runtime reads and inserts (first
-- row wins); a row never changes and no role deletes one. Nothing here is a
-- secret: public sale and wallet addresses and a storage path.
CREATE TABLE presale_receipt_images (
  presale_id TEXT NOT NULL CHECK (presale_id ~ '^0x[0-9a-f]{64}$'),
  wallet TEXT NOT NULL CHECK (wallet ~ '^0x[0-9a-f]{64}$'),
  format TEXT NOT NULL CHECK (format IN ('card', 'share')),
  record_digest TEXT NOT NULL CHECK (record_digest ~ '^[0-9a-f]{64}$'),
  pathname TEXT NOT NULL CHECK (length(pathname) BETWEEN 1 AND 512),
  url TEXT NOT NULL CHECK (length(url) BETWEEN 1 AND 2048),
  content_type TEXT NOT NULL CHECK (content_type = 'image/png'),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (presale_id, wallet, format, record_digest)
);

REVOKE ALL ON TABLE presale_receipt_images FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE presale_receipt_images TO blast_web;
