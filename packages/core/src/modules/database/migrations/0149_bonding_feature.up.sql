-- Editorial selections for the /bonding carousel, newest pin first.
CREATE TABLE mission_control_bonding_feature (
  launch_id TEXT PRIMARY KEY CHECK (launch_id ~ '^0x[0-9a-f]{64}$'),
  pinned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE mission_control_bonding_feature FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON TABLE mission_control_bonding_feature TO blast_web;
GRANT SELECT ON TABLE mission_control_bonding_feature TO blast_replica;
