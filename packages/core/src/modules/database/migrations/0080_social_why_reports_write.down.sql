DROP TRIGGER IF EXISTS social_why_reports_immutable ON social_why_reports;
DROP FUNCTION IF EXISTS social_why_reports_check_update();
GRANT UPDATE ON TABLE social_why_reports TO blast_web;
