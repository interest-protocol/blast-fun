import { testClient } from "../../../../../../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";
async function route() { return process.env.T020_CONFIG_DIR ? import("../../../../../portfolio/server") : import("../../../../../confirmation/server"); }
export async function GET(request: Request) { return (await route()).settingsRoute.GET(request, testClient()); }
export async function PUT(request: Request) { return (await route()).settingsRoute.PUT(request, testClient()); }
