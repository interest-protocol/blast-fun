-- The canonical presale (2026-10-28) adds its own Aftermath migrator, venue
-- `aftermath-native`. The lifecycle planner records such sales; the relayer
-- blocks them with `venue-unsupported` (owner: Cetus and Bluefin only at
-- launch). The venue check widens to it; nothing else changes.
ALTER TABLE presale_lifecycle_records DROP CONSTRAINT presale_lifecycle_records_venue_check;
ALTER TABLE presale_lifecycle_records ADD CONSTRAINT presale_lifecycle_records_venue_check
  CHECK (venue IN ('cetus', 'bluefin', 'aftermath', 'aftermath-native'));
