import { recordMetric } from "@blast/core/lib/metrics.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { readSocialBody, type SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { WORKSPACE_MAX_BYTES } from "@blast/core/modules/social/blast-workspace/codec.ts";
import { BLAST_WORKSPACE_READ_ROUTE, BLAST_WORKSPACE_WRITE_ROUTE, parseBlastWorkspaceWrite } from "@blast/core/modules/social/contracts/blast-workspace.ts";
import { readBlastWorkspace, saveBlastWorkspace } from "./repository.ts";

function assertNoSelector(request: Request): void {
  if (new URL(request.url).search !== "") throw new SocialRouteError("invalid_request");
}

async function readWrite(request: Request) {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new SocialRouteError("invalid_request");
  const bytes = await readSocialBody(request, WORKSPACE_MAX_BYTES);
  recordMetric("social.workspace.bytes", { operation: "write", bytes: bytes.byteLength });
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new SocialRouteError("invalid_request");
  }
  return parseBlastWorkspaceWrite(value);
}

export function createSocialWorkspaceRoute(dependencies: Readonly<{ kit: SocialRouteKit; database?: () => ReadableDatabase }>) {
  const { kit, database } = dependencies;
  return Object.freeze({
    GET: kit.route(
      { name: BLAST_WORKSPACE_READ_ROUTE, auth: "account", account: "required", bucket: "social_me_read", cache: "private" },
      async (context) => {
        assertNoSelector(context.request);
        const accountId = context.account!.account_id;
        const result = database
          ? await readBlastWorkspace(database(), accountId)
          : await context.transaction((social) => readBlastWorkspace(social, accountId), { label: "social.workspace_read" });
        recordMetric("social.workspace.bytes", { operation: "read", bytes: Buffer.byteLength(JSON.stringify(result)) });
        return context.json(result);
      },
    ),
    PUT: kit.route(
      { name: BLAST_WORKSPACE_WRITE_ROUTE, auth: "account", account: "required", cache: "private" },
      async (context) => {
        await context.consumeAccount("social_workspace_save");
        assertNoSelector(context.request);
        const write = await readWrite(context.request);
        const result = await context.transaction((social) => saveBlastWorkspace(social, context.account!.account_id, write), { label: "social.workspace_save" });
        return context.json(result);
      },
    ),
  });
}
