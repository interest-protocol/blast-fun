-- #791: the signing workers keep one release-gate table. The buyback key's records
-- (mission_control_vault_release_gate_checks, 0139, renamed in 0153) move into
-- blast_worker_release_gate_checks with their network, digest, check, verdict, evidence and
-- time, in their original order; the old table goes. The original ids are not kept: the new
-- ids follow the old order, which is all the latest-record-per-check read depends on.
-- Buyback digests hash another JSON shape than keeper and rewards digests, so the two sets
-- cannot share a digest. Both tables are append-only (launchpad_guard_release_gate_checks).
-- A long reader (a dump, say) fails this migration fast instead of queueing every gate read behind it.
SET LOCAL lock_timeout = '15s';
LOCK TABLE mission_control_vault_release_gate_checks, blast_worker_release_gate_checks IN ACCESS EXCLUSIVE MODE;

-- A record the new command made for a buyback identity before this migration would have a
-- lower id than the copied ones, so a revocation could be overtaken by an older pass.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM blast_worker_release_gate_checks AS kept
    JOIN mission_control_vault_release_gate_checks AS moved USING (identity_digest)
  ) THEN
    RAISE EXCEPTION 'blast_worker_release_gate_checks already holds records for a buyback identity; reconcile them before 0158';
  END IF;
END $$;

INSERT INTO blast_worker_release_gate_checks (network, identity_digest, check_name, passed, evidence, recorded_at)
SELECT network, identity_digest, check_name, passed, evidence, recorded_at
FROM mission_control_vault_release_gate_checks
ORDER BY id;

-- The copied rows, numbered in id order, equal the old rows numbered the same way: same
-- content, same multiplicity, same order.
DO $$
BEGIN
  IF EXISTS (
    (SELECT row_number() OVER (ORDER BY id), network, identity_digest, check_name, passed, evidence, recorded_at
     FROM mission_control_vault_release_gate_checks
     EXCEPT ALL
     SELECT row_number() OVER (ORDER BY id), network, identity_digest, check_name, passed, evidence, recorded_at
     FROM blast_worker_release_gate_checks
     WHERE identity_digest IN (SELECT identity_digest FROM mission_control_vault_release_gate_checks))
    UNION ALL
    (SELECT row_number() OVER (ORDER BY id), network, identity_digest, check_name, passed, evidence, recorded_at
     FROM blast_worker_release_gate_checks
     WHERE identity_digest IN (SELECT identity_digest FROM mission_control_vault_release_gate_checks)
     EXCEPT ALL
     SELECT row_number() OVER (ORDER BY id), network, identity_digest, check_name, passed, evidence, recorded_at
     FROM mission_control_vault_release_gate_checks)
  ) THEN
    RAISE EXCEPTION 'the buyback release gate records did not copy exactly';
  END IF;
END $$;

DROP TABLE mission_control_vault_release_gate_checks;
