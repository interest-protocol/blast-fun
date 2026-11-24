// A loopback https node for tests that drive the real gRPC client. Presale
// node URLs are https only, so the fixture serves TLS with a self-signed
// leaf certificate for 127.0.0.1 only (not a CA; valid until 2126, test use
// only) and adds it to the process's default CAs while it runs; the built-in
// fetch then trusts it.

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { getCACertificates, setDefaultCACertificates } from "node:tls";

const key = readFileSync(new URL("./fixture-node.key.pem", import.meta.url));
const cert = readFileSync(new URL("./fixture-node.cert.pem", import.meta.url), "utf8");

export type FixtureHttpsNode = Readonly<{ url: string; server: Server; close(): Promise<void> }>;

export async function startFixtureHttpsNode(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<FixtureHttpsNode> {
  const server = createServer({ key, cert }, handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  setDefaultCACertificates([...getCACertificates("default"), cert]);
  return Object.freeze({
    url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
    server,
    async close() {
      // Remove only this cert, so overlapping fixture nodes restore cleanly.
      setDefaultCACertificates(getCACertificates("default").filter((each) => each.trim() !== cert.trim()));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  });
}
