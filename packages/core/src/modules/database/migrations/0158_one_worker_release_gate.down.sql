DO $$ BEGIN RAISE EXCEPTION 'Release gate records are append-only custody evidence; restore a pre-0158 snapshot to roll back'; END $$;
