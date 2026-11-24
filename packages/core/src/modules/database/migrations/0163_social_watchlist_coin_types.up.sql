-- The watchlist also saves bonding-curve coins, which have no presale: a row
-- keys a sale by its presale id or a curve coin by its coin type
-- (`0x<64 hex>::<module>::<Name>`, as `COIN_TYPE` in lib/sui/ids.ts). The
-- column keeps its name so the deployed code still reads it during the deploy.
-- Fail fast rather than queue stars behind a long transaction. The migration
-- runs in one transaction, so NOT VALID then VALIDATE would hold the same lock
-- through the scan: the plain check is as cheap on this small table.
SET LOCAL lock_timeout = '3s';
ALTER TABLE social_watchlist DROP CONSTRAINT social_watchlist_presale_id;
ALTER TABLE social_watchlist ADD CONSTRAINT social_watchlist_presale_id CHECK (
  presale_id ~ '^0x[0-9a-f]{64}$'
  OR presale_id ~ '^0x[0-9a-f]{64}::[A-Za-z_][A-Za-z0-9_]{0,127}::[A-Za-z_][A-Za-z0-9_]{0,127}$'
);
