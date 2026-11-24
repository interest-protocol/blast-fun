-- Nothing to restore: the retired `chain_v1` views were never a migration's
-- and read tables the web roles may no longer read. An earlier web release
-- rolled back to recreates them when it migrates.
SELECT 1;
