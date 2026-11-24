-- Verify that the exact rollback application accepts canonical bodies before
-- deploying it. Do not rename every canonical row back: some predated this
-- migration or were edited
-- afterward. Exact restoration requires protected preimages and current-row
-- postimage/version/metadata checks; see the migration runbook.
ALTER TABLE social_presale_drafts
  DROP CONSTRAINT social_presale_drafts_canonical_recipients;
