import { testClient } from "../../../../../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";
export async function GET(request: Request) {
  const { meRoute } = await (process.env.T020_CONFIG_DIR ? import("../../../../portfolio/server") : process.env.T014_CONFIG_DIR ? import("../../../../confirmation/server") : import("../../../../sync/server"));
  return meRoute.GET(request, testClient());
}
