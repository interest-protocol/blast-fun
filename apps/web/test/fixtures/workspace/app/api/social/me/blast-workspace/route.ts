import { testClient } from "../../../../../../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";
async function route() { return process.env.T020_CONFIG_DIR ? import("../../../../../portfolio/server") : process.env.T014_CONFIG_DIR ? import("../../../../../confirmation/server") : import("../../../../../sync/server"); }
export async function GET(request: Request) { return (await route()).workspaceRoute.GET(request, testClient()); }
export async function PUT(request: Request) { return (await route()).workspaceRoute.PUT(request, testClient()); }
