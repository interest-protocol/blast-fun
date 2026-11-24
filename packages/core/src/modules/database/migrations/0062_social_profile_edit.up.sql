-- Social feed UI-06 (canonical UI §6, Profile): the own profile's "Edit
-- profile" sheet changes the account's display name and picture (owner
-- decision OA-14). Both are stored on the account (module `social`), never on
-- the Mission Control profile, which stays Mission Control's to write.
--
-- - `display_name`: a new account's own name already lives here. A member's
--   row now may hold one too: it overrides the Mission Control profile's
--   name on Blast (NULL keeps the profile's).
-- - `picture`: NULL shows the source's picture (a new account's X avatar, a
--   member's profile avatar or X avatar); 'upload' shows `picture_url` (an
--   image the account uploaded, stored at its content address in the public
--   blob store); 'none' shows the generated avatar.
-- - `profile_updated_at`: when the sheet last saved, for operators.
--
-- Every column is nullable without a default, so adding them rewrites no row.
-- The table keeps its grants: the web runtime updates its members' own rows,
-- the replica reads them through `social_account_identities`.

ALTER TABLE social_accounts
  ADD COLUMN picture TEXT CONSTRAINT social_accounts_picture CHECK (picture IN ('upload', 'none')),
  ADD COLUMN picture_url TEXT CONSTRAINT social_accounts_picture_url
    CHECK (char_length(picture_url) BETWEEN 9 AND 2048 AND picture_url LIKE 'https://%'),
  ADD COLUMN profile_updated_at TIMESTAMPTZ,
  ADD CONSTRAINT social_accounts_picture_upload
    CHECK ((picture IS NOT DISTINCT FROM 'upload') = (picture_url IS NOT NULL));

-- The public identity reads the account's own choices first. The column list
-- and order are 0056's plus UI-02/03's `verified` (0057: OA-8, verified
-- means X linked), so either migration may run first; CREATE OR REPLACE keeps
-- the view's grants and its owner's rights.
CREATE OR REPLACE VIEW social_account_identities AS
SELECT
  a.account_id,
  COALESCE(p.callsign, a.callsign) AS callsign,
  COALESCE(a.display_name, p.display_name) AS display_name,
  CASE a.picture
    WHEN 'upload' THEN a.picture_url
    WHEN 'none' THEN NULL
    ELSE CASE WHEN a.profile_id IS NULL THEN a.x_avatar_url ELSE COALESCE(p.avatar_reference, p.x_avatar_reference) END
  END AS avatar_url,
  CASE WHEN a.profile_id IS NULL THEN a.x_handle ELSE p.x_handle END AS x_handle,
  CASE WHEN a.profile_id IS NULL THEN a.x_subject IS NOT NULL ELSE p.x_subject IS NOT NULL END AS verified
FROM social_accounts a
LEFT JOIN mission_control_profiles p ON p.profile_id = a.profile_id;
