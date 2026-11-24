-- An empty installation can fully roll back. A saved empty workspace is a
-- real row: retain both tables whenever either holds data or replay history.
DO $$
BEGIN
  -- Lock in the save transaction's read order; a concurrent commit must be
  -- visible before deciding that either table is empty.
  LOCK TABLE social_blast_workspace_writers, social_blast_workspaces IN ACCESS EXCLUSIVE MODE;
  IF NOT EXISTS (SELECT FROM social_blast_workspaces)
     AND NOT EXISTS (SELECT FROM social_blast_workspace_writers) THEN
    DROP TABLE social_blast_workspace_writers;
    DROP TABLE social_blast_workspaces;
  ELSE
    REVOKE ALL ON TABLE social_blast_workspaces, social_blast_workspace_writers FROM blast_web;
  END IF;
END;
$$;
