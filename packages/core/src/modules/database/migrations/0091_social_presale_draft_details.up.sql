-- Social feed R3-25: a Create draft keeps the sale's public details until it
-- is published (R3-24's store then holds them), and records which sale it
-- became.
--
-- The draft's `body` (0068) stays what the creator edits: it gains
-- `quote_type`, `site`, `x_handle`, `telegram`, `docs_url` and `audit_url` as
-- typed (a half-typed link survives autosave; `draftIssues` names it). The
-- columns below hold those values as stored once valid (`sales/validate.ts`:
-- https links, bare handles; NULL when blank or not yet valid), written by
-- every save from the body, so publishing copies checked values and a read
-- never parses JSON. The cover is the server's alone (`…/cover`): its key in
-- the public store (`draft-covers/<draft_id>/<sha256>.webp`), URL and size, all
-- four or none. `published_presale_id` is set once, by `…/published`, in the
-- same transaction that writes the sale's details.
ALTER TABLE social_presale_drafts
  ADD COLUMN quote_type TEXT CHECK (char_length(quote_type) BETWEEN 8 AND 512),
  ADD COLUMN site TEXT CHECK (char_length(site) <= 512 AND site ~ '^https://[^[:space:]/?#@:]+(/[^[:space:]#]*)?$'),
  ADD COLUMN x_handle TEXT CHECK (x_handle ~ '^[A-Za-z0-9_]{1,15}$'),
  ADD COLUMN telegram TEXT CHECK (telegram ~ '^[A-Za-z0-9_]{5,32}$'),
  ADD COLUMN docs_url TEXT CHECK (char_length(docs_url) <= 512 AND docs_url ~ '^https://[^[:space:]/?#@:]+(/[^[:space:]#]*)?$'),
  ADD COLUMN audit_url TEXT CHECK (char_length(audit_url) <= 512 AND audit_url ~ '^https://[^[:space:]/?#@:]+(/[^[:space:]#]*)?$'),
  ADD COLUMN cover_key TEXT CHECK (cover_key ~ '^draft-covers/[0-9a-f-]{36}/[0-9a-f]{64}\.webp$'),
  ADD COLUMN cover_url TEXT CHECK (char_length(cover_url) <= 2048 AND cover_url ~ '^https://[^[:space:]]+$'),
  ADD COLUMN cover_width INTEGER CHECK (cover_width BETWEEN 1 AND 8192),
  ADD COLUMN cover_height INTEGER CHECK (cover_height BETWEEN 1 AND 8192),
  ADD COLUMN published_presale_id TEXT CHECK (published_presale_id ~ '^0x[0-9a-f]{64}$'),
  ADD COLUMN published_at TIMESTAMPTZ,
  ADD CONSTRAINT social_presale_drafts_cover CHECK (num_nulls(cover_key, cover_url, cover_width, cover_height) IN (0, 4)),
  ADD CONSTRAINT social_presale_drafts_published CHECK ((published_presale_id IS NULL) = (published_at IS NULL));

-- A sale is one draft's at most.
CREATE UNIQUE INDEX social_presale_drafts_published_idx ON social_presale_drafts (published_presale_id) WHERE published_presale_id IS NOT NULL;

-- Drafts saved before this hold the new fields at their blank values, so every stored body reads as a whole draft.
UPDATE social_presale_drafts
SET body = body || jsonb_build_object(
  'quote_type', '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
  'site', '', 'x_handle', '', 'telegram', '', 'docs_url', '', 'audit_url', ''
), quote_type = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
WHERE NOT body ? 'quote_type';
