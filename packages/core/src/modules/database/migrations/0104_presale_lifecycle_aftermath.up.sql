-- Next release: the lifecycle relayer migrates Aftermath DAO-pool sales
-- (modules/presale/lifecycle). A sale created through the vendor package
-- `blast_aftermath_dao_presale` records the vendor's witness as its migrator,
-- so blast-infra lists its venue as `aftermath`, and the relayer migrates it
-- through the vendor's `migrate` once it is funded. The venue check widens to
-- it; every other column and check of 0048 is unchanged.
ALTER TABLE presale_lifecycle_records DROP CONSTRAINT presale_lifecycle_records_venue_check;
ALTER TABLE presale_lifecycle_records ADD CONSTRAINT presale_lifecycle_records_venue_check
  CHECK (venue IN ('cetus', 'bluefin', 'aftermath'));

-- Where an Aftermath sale's `PoolCreation` is, as blast-infra indexed its
-- `PoolCreationReserved` (`venue.pool_creation_id`); null until it does, and
-- for every other venue. It only says where to look: the relayer reads the
-- object from the chain at each migration, and the chain decides whether it is
-- the vendor's `PoolCreation` bound to this sale, and its LP coin.
ALTER TABLE presale_lifecycle_records ADD COLUMN aftermath_pool_creation_id TEXT
  CHECK (aftermath_pool_creation_id ~ '^0x[0-9a-f]{64}$');
ALTER TABLE presale_lifecycle_records ADD CONSTRAINT presale_lifecycle_records_pool_creation_venue
  CHECK (aftermath_pool_creation_id IS NULL OR venue = 'aftermath');
