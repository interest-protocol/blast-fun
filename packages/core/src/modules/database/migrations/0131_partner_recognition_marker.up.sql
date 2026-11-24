-- Scheduling metadata only. Existing identities, hashes and quota counters stay intact.
CREATE TABLE partner_api_recognition (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  generation UUID NOT NULL,
  revision BIGINT NOT NULL CHECK (revision >= 0)
);
INSERT INTO partner_api_recognition (singleton, generation, revision)
VALUES (true, gen_random_uuid(), 0);
REVOKE ALL ON TABLE partner_api_recognition FROM PUBLIC;
-- blast_web is the existing administrative writer. A read-only verification role
-- receives no mutation grant here; separating its deployed credential is a rollout gate.
GRANT SELECT, UPDATE (generation, revision) ON partner_api_recognition TO blast_web;
