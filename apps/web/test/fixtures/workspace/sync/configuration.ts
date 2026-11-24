/** Only the two explicitly allocated test lanes are supported. Never use live configuration. */
export function syncFixtureConfiguration(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const capacity = Boolean(environment.T018_CONFIG_DIR);
  const directory = capacity
    ? environment.T018_CONFIG_DIR
    : environment.T013_CONFIG_DIR;
  const url = new URL(
    environment.MISSION_CONTROL_TEST_DATABASE_URL ?? "invalid:",
  );
  if (
    !directory ||
    url.protocol !== "postgresql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== (capacity ? "35307" : "35275") ||
    url.pathname !== "/mission_control_test" ||
    url.search !== ""
  ) {
    throw new Error("Use the assigned isolated workspace fixture");
  }
  return {
    directory,
    url: url.toString(),
    origin: capacity ? "http://127.0.0.1:42970" : "http://127.0.0.1:42928",
  };
}
