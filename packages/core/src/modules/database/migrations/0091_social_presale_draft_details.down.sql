DROP INDEX IF EXISTS social_presale_drafts_published_idx;
ALTER TABLE social_presale_drafts
  DROP CONSTRAINT IF EXISTS social_presale_drafts_published,
  DROP CONSTRAINT IF EXISTS social_presale_drafts_cover,
  DROP COLUMN IF EXISTS published_at,
  DROP COLUMN IF EXISTS published_presale_id,
  DROP COLUMN IF EXISTS cover_height,
  DROP COLUMN IF EXISTS cover_width,
  DROP COLUMN IF EXISTS cover_url,
  DROP COLUMN IF EXISTS cover_key,
  DROP COLUMN IF EXISTS audit_url,
  DROP COLUMN IF EXISTS docs_url,
  DROP COLUMN IF EXISTS telegram,
  DROP COLUMN IF EXISTS x_handle,
  DROP COLUMN IF EXISTS site,
  DROP COLUMN IF EXISTS quote_type;
-- The bodies go back to 0068's shape.
UPDATE social_presale_drafts SET body = body - 'quote_type' - 'site' - 'x_handle' - 'telegram' - 'docs_url' - 'audit_url';
