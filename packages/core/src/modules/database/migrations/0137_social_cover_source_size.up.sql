-- Redesign data gap 17: a cover keeps the size of the image its creator
-- uploaded, so Create can show the size hint after a reload. Every cover is
-- stored as a 1536 × 512 WebP (`cover_width`, `cover_height`); the upload it
-- came from was 128 to 4,096 pixels a side, measured after its EXIF
-- orientation (`sales/cover.ts`). Both columns or neither, and only beside a
-- cover. Covers stored before this keep NULL: their upload's size was never
-- recorded, and a read shows no hint rather than a guess.
ALTER TABLE social_presale_drafts
  ADD COLUMN cover_source_width INTEGER CHECK (cover_source_width BETWEEN 1 AND 8192),
  ADD COLUMN cover_source_height INTEGER CHECK (cover_source_height BETWEEN 1 AND 8192),
  ADD CONSTRAINT social_presale_drafts_cover_source CHECK (
    num_nulls(cover_source_width, cover_source_height) IN (0, 2)
    AND (cover_source_width IS NULL OR cover_key IS NOT NULL)
  );

ALTER TABLE social_sale_metadata
  ADD COLUMN cover_source_width INTEGER CHECK (cover_source_width BETWEEN 1 AND 8192),
  ADD COLUMN cover_source_height INTEGER CHECK (cover_source_height BETWEEN 1 AND 8192),
  ADD CONSTRAINT social_sale_metadata_cover_source CHECK (
    num_nulls(cover_source_width, cover_source_height) IN (0, 2)
    AND (cover_source_width IS NULL OR cover_key IS NOT NULL)
  );
