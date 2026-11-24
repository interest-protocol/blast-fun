-- Social feed R3-24 (OA-25 Q5, Q7): a published sale's public details that the
-- chain does not carry: its cover image, its one-line description and its
-- outbound links, plus the published launch date. The chain-derived
-- description (the coin's `Currency<T>`) stays blast-infra's
-- (`chain_read_v1.presales.sale_description`); a sale's terms are chain state
-- and have no column here.
--
-- One row per sale, written by its creator through
-- PUT /api/social/sales/{presale_id}/metadata and the cover routes, and by the
-- operator CLI (`sale metadata clear|revert|launch-at`). Every value is stored
-- already validated (`sales/validate.ts`): the tagline NFC-normalized, trimmed,
-- one line, no link; the links as `https://<host>[/<path>]` with no userinfo or
-- port; the handles bare. The checks below are the last line, not the rules.
--
-- Who last wrote a row is an account (the creator) or an operator, exactly one.
-- Neither is ever in a public read.
CREATE TABLE social_sale_metadata (
  presale_id TEXT PRIMARY KEY CHECK (presale_id ~ '^0x[0-9a-f]{64}$'),
  tagline TEXT CHECK (char_length(tagline) BETWEEN 1 AND 120 AND tagline !~ '[[:cntrl:]]'),
  site TEXT CHECK (char_length(site) <= 512 AND site ~ '^https://[^[:space:]/?#@:]+(/[^[:space:]#]*)?$'),
  x_handle TEXT CHECK (x_handle ~ '^[A-Za-z0-9_]{1,15}$'),
  telegram TEXT CHECK (telegram ~ '^[A-Za-z0-9_]{5,32}$'),
  docs_url TEXT CHECK (char_length(docs_url) <= 512 AND docs_url ~ '^https://[^[:space:]/?#@:]+(/[^[:space:]#]*)?$'),
  audit_url TEXT CHECK (char_length(audit_url) <= 512 AND audit_url ~ '^https://[^[:space:]/?#@:]+(/[^[:space:]#]*)?$'),
  -- OA-25 Q5: the published launch date; NULL until one is published (no estimate is ever stored).
  launch_at_ms BIGINT CHECK (launch_at_ms > 0),
  -- The cover: its key in the public launch-asset store (`sale-covers/<presale_id>/<sha256>.webp`, a
  -- per-sale path, so deleting a replaced cover never removes another sale's; or the
  -- `draft-covers/<draft_id>/…` object Create uploaded, when the sale was published with it), the
  -- URL the store answered for it, and its stored dimensions. All four or none.
  cover_key TEXT CHECK (cover_key ~ '^(sale-covers/0x[0-9a-f]{64}|draft-covers/[0-9a-f-]{36})/[0-9a-f]{64}\.webp$'),
  cover_url TEXT CHECK (char_length(cover_url) <= 2048 AND cover_url ~ '^https://[^[:space:]]+$'),
  cover_width INTEGER CHECK (cover_width BETWEEN 1 AND 8192),
  cover_height INTEGER CHECK (cover_height BETWEEN 1 AND 8192),
  updated_by_account_id UUID,
  updated_by_operator TEXT CHECK (char_length(updated_by_operator) BETWEEN 1 AND 200),
  updated_at_ms BIGINT NOT NULL CHECK (updated_at_ms > 0),
  CONSTRAINT social_sale_metadata_cover CHECK (num_nulls(cover_key, cover_url, cover_width, cover_height) IN (0, 4)),
  CONSTRAINT social_sale_metadata_author CHECK (num_nonnulls(updated_by_account_id, updated_by_operator) = 1)
);

-- One insert-only row per change, holding the fields as they were before it,
-- so an operator can revert any edit and a moderation decision has evidence.
-- `before` holds exactly the row's value columns (tagline, the links, the
-- launch date and the cover). The author is an account or an operator.
-- `edit_id` counts edits in the order they were written (a sale's edits are
-- serialized by its advisory lock), so the edit after another is well defined.
CREATE TABLE social_sale_metadata_edits (
  edit_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  presale_id TEXT NOT NULL CHECK (presale_id ~ '^0x[0-9a-f]{64}$'),
  account_id UUID,
  operator_id TEXT CHECK (char_length(operator_id) BETWEEN 1 AND 200),
  at_ms BIGINT NOT NULL CHECK (at_ms > 0),
  before JSONB NOT NULL CHECK (jsonb_typeof(before) = 'object' AND octet_length(before::text) <= 8192),
  CONSTRAINT social_sale_metadata_edits_author CHECK (num_nonnulls(account_id, operator_id) = 1)
);

-- A sale's edits, newest first (the operator's revert lists them).
CREATE INDEX social_sale_metadata_edits_presale_idx ON social_sale_metadata_edits (presale_id, edit_id DESC);

-- An edit is evidence: no role rewrites, deletes or truncates one, the
-- migration login and the CLI's owner login included (0080's pattern).
CREATE FUNCTION social_sale_metadata_edits_refuse()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'a sale metadata edit is never changed or removed'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'social_sale_metadata_edits_insert_only';
END;
$$;

CREATE TRIGGER social_sale_metadata_edits_immutable
BEFORE UPDATE OR DELETE ON social_sale_metadata_edits
FOR EACH ROW EXECUTE FUNCTION social_sale_metadata_edits_refuse();

CREATE TRIGGER social_sale_metadata_edits_no_truncate
BEFORE TRUNCATE ON social_sale_metadata_edits
FOR EACH STATEMENT EXECUTE FUNCTION social_sale_metadata_edits_refuse();

-- The web runtime writes rows (never deletes one: clearing a field is an
-- update) and logs edits; the replica reads the public rows for the presale
-- list, the sale page and the public portfolio. Nobody else reads either.
REVOKE ALL ON TABLE social_sale_metadata, social_sale_metadata_edits FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE social_sale_metadata TO blast_web;
GRANT SELECT ON TABLE social_sale_metadata TO blast_replica;
GRANT SELECT, INSERT ON TABLE social_sale_metadata_edits TO blast_web;
