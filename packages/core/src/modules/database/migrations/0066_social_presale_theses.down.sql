DROP INDEX IF EXISTS social_whys_presale_active_idx;
DROP TRIGGER IF EXISTS social_whys_presale ON social_whys;
DROP FUNCTION IF EXISTS social_whys_set_presale();
DROP FUNCTION IF EXISTS social_whys_presale_of(TEXT);
ALTER TABLE social_whys DROP COLUMN IF EXISTS presale_id;
