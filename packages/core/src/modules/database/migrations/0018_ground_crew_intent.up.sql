ALTER TABLE mission_control_season_memberships
  DROP CONSTRAINT mission_control_season_memberships_fleet_check,
  ADD CONSTRAINT mission_control_season_memberships_fleet_check
    CHECK (fleet IN ('Recon', 'Foundry', 'Signal', 'Ground'));
