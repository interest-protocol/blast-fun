DO $$ BEGIN RAISE EXCEPTION 'Scheduled reward rounds require their matching worker binary; restore a pre-0152 snapshot to roll back'; END $$;
