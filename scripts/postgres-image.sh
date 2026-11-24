# Sourced by the disposable-database scripts. Production runs Neon Postgres 18;
# set MISSION_CONTROL_TEST_POSTGRES_IMAGE (for example postgres:16-alpine) to
# run the suites against another image.
postgres_image="${MISSION_CONTROL_TEST_POSTGRES_IMAGE:-postgres:18-alpine}"
