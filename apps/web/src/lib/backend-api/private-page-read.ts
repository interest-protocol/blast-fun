import "server-only";

import { headers } from "next/headers";
import { backendPrivateServerRead } from "@blast/server/private/relay.ts";
import { SITE_ORIGIN } from "#web/lib/site.ts";

export type BackendPageReadDependencies = Readonly<{
  origin: string;
  headers: () => Promise<Headers>;
  relay: (request: Request) => Promise<Response>;
}>;

const privatePageRead: BackendPageReadDependencies = {
  origin: SITE_ORIGIN,
  headers: async () => new Headers(await headers()),
  relay: backendPrivateServerRead,
};

export async function readPrivateBackendPage(
  path: string,
  dependencies = privatePageRead,
): Promise<Response> {
  return dependencies.relay(
    new Request(dependencies.origin + path, {
      headers: await dependencies.headers(),
    }),
  );
}

export async function boundedPageText(
  response: Response,
  maxBytes: number,
  unavailable: string,
  invalidBody = unavailable,
): Promise<string> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(unavailable);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error(invalidBody);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size).toString("utf8");
      size += value.byteLength;
      if (size > maxBytes) throw new Error(invalidBody);
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
