ALTER TABLE social_sale_metadata
  DROP CONSTRAINT IF EXISTS social_sale_metadata_cover_source,
  DROP COLUMN IF EXISTS cover_source_height,
  DROP COLUMN IF EXISTS cover_source_width;

ALTER TABLE social_presale_drafts
  DROP CONSTRAINT IF EXISTS social_presale_drafts_cover_source,
  DROP COLUMN IF EXISTS cover_source_height,
  DROP COLUMN IF EXISTS cover_source_width;
