-- Social feed OA-33 (the owner, 2026-10-06, amending OA-25 Q3a): sound
-- effects are off by default and play only after the person turns them on
-- (Settings -> Feel -> Sound, or Blast mode's speaker button); once they have
-- chosen, the choice is kept.
--
-- 0093 gave every account `sound BOOLEAN NOT NULL DEFAULT true`, so the first
-- sign-in turned sound on without anyone asking. Here an account that has
-- never chosen has no choice: the column is nullable with no default, and
-- NULL means "not chosen yet" (the browser then keeps its own flag, which is
-- off until the person turns it on). A choice is only ever written as an
-- explicit boolean by `PUT /api/social/me/settings`, which never writes NULL.
--
-- Existing rows. Under 0093 a `false` can only have been written by that PUT,
-- so it is a person's choice and is kept. A `true` is 0093's default unless
-- the person switched sound back on. 0093 is not deployed: it is not on `main`
-- or any pushed branch (production's migrations end at 0029; 0054 onwards
-- live only on the unpushed social-feed integration branch and disposable
-- test databases), so no person has made a choice that a `true` could hold.
-- Every `true` therefore becomes NULL and no choice is lost. Were this ever
-- run over a database where people had chosen, the only cost would be a
-- deliberate "on" reading as "not chosen" (off) — never sound turning on.
--
-- No grant changes (0054's table-level grants still let the web read and
-- update `social_accounts`), no index (the column is only read and written
-- with its account's row, by primary key), and no trigger fires: the only
-- trigger on the table is `UPDATE OF callsign`.
ALTER TABLE social_accounts
  ALTER COLUMN sound DROP NOT NULL,
  ALTER COLUMN sound DROP DEFAULT;

UPDATE social_accounts SET sound = NULL WHERE sound;
