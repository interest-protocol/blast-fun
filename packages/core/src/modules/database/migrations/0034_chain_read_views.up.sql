-- blast-infra publishes the versioned chain read views (`chain_read_v1`,
-- its migration 2026-09-30-100000_chain_read_views) and grants the web,
-- watcher, social and replica roles SELECT on them and on nothing else of its
-- schema. The web app's own `chain_v1` views over blast-infra's tables, which
-- earlier releases created after migrating, are retired: chain joins read
-- `chain_read_v1` only.
DROP SCHEMA IF EXISTS chain_v1 CASCADE;
