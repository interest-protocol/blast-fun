/** Restrict the load test to the disposable loopback database. */
export function assertLoadTestDatabaseUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("The load-test DATABASE_URL must point at the local loopback container.");
  }
  if (!/^\/blast_lt_\d{14}$/.test(url.pathname)) {
    throw new Error("The load-test DATABASE_URL must name a blast_lt_<timestamp> database.");
  }
}
