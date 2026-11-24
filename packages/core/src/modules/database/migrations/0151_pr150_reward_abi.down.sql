DO $$ BEGIN RAISE EXCEPTION 'PR150 reward custody requires its matching worker binary; restore a pre-PR150 snapshot to roll back'; END $$;
