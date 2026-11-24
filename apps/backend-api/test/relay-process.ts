import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import { quotaNamespace } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { createServer } from "node:http";
import { frontendClientAddress } from "@blast/core/modules/backend-api/frontend-ingress.ts";
import { createBackendRelay } from "../../web/src/modules/partner-api/v1/relay.ts";

const partner = createBackendRelay(
  process.env.TEST_BACKEND_ORIGIN!,
  process.env.BLAST_BACKEND_GATEWAY_SECRET!,
  {
    namespace: quotaNamespace(process.env.BLAST_REDIS_NAMESPACE, deploymentIdentity(process.env)),
    clientAddress: (request) => frontendClientAddress(request, { vercel: true, localRun: false }),
  },
);
const firstParty = createBackendRelay(
  process.env.TEST_BACKEND_ORIGIN!,
  process.env.BLAST_BACKEND_GATEWAY_SECRET!,
  {
    firstParty: true,
    namespace: quotaNamespace(process.env.BLAST_REDIS_NAMESPACE, deploymentIdentity(process.env)),
    clientAddress: (request) => frontendClientAddress(request, { vercel: true, localRun: false }),
  },
);
const server = createServer(async (incoming, outgoing) => {
  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (typeof value === "string") {
        headers.set(name, value);
      }
    }
    // Model Vercel's overwrite: a caller cannot choose the gateway's client IP.
    headers.set("x-vercel-forwarded-for", incoming.socket.remoteAddress ?? "unavailable");
    const request = new Request("https://frontend.test" + incoming.url, {
      method: incoming.method,
      headers,
    });
    const response = await (incoming.url?.startsWith("/api/v1/") ? partner : firstParty)(request);
    const responseHeaders: Record<string, string | string[]> = Object.fromEntries(response.headers);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) {
      responseHeaders["set-cookie"] = cookies;
    }
    outgoing.writeHead(response.status, responseHeaders);
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(503);
    outgoing.end();
  }
});
server.listen(Number(process.env.PORT), "127.0.0.1", () => process.send?.("ready"));
process.once("SIGTERM", () => server.close(() => process.exit(0)));
