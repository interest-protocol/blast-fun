/** This fixture may only touch its allocated disposable PostgreSQL lane. */
export function portfolioFixtureConfiguration(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const url = new URL(environment.MISSION_CONTROL_TEST_DATABASE_URL ?? "invalid:");
  const directory = environment.T020_CONFIG_DIR;
  if (!directory || url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "35320" || url.pathname !== "/mission_control_test" || url.search !== "")
    throw new Error("Use the assigned isolated T020 Portfolio fixture");
  return { directory, url: url.toString(), origin: "http://127.0.0.1:42980" };
}
export const portfolioAccountId = (n: number) => `02000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export const portfolioAddress = (n: number) => `0x${(0x2000 + n).toString(16).padStart(64, "0")}`;
export const portfolioSaleId = `0x${"4".repeat(64)}`;
