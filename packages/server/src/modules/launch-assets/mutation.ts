import { z } from "zod";
import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import { createHash } from "node:crypto";

import {
  LAUNCH_IMAGE_MAX_BYTES,
  sniffLaunchImage,
  type LaunchImageType,
} from "@blast/core/lib/launchpad/launch-image.ts";
import { parseHttpsUrl } from "@blast/core/lib/https-url.ts";
import {
  LaunchpadMutationError,
  invalidRequest,
} from "@blast/server/modules/launchpad-identity/errors.ts";
import {
  createLaunchpadMutationHandler,
  type LaunchpadMutationDefinition,
  type LaunchpadMutationDependencies,
} from "@blast/server/modules/launchpad-identity/mutation.ts";
import { sanitizeLaunchImage } from "./image.ts";
import type { LaunchAssetStore } from "./store.ts";

/** A stored launch image: the only reference a launch draft accepts. */
export type LaunchAssetReference = Readonly<{
  url: string;
  sha256: string;
  contentType: LaunchImageType;
  width: number;
  height: number;
  bytes: number;
}>;

type Upload = Readonly<{
  contentType: LaunchImageType;
  bytes: Buffer;
  stored: LaunchAssetReference | null;
}>;

const EXTENSIONS: Readonly<Record<LaunchImageType, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function parseUpload(input: Record<string, unknown>): Upload {
  const { contentType, data } = input;
  const mediaType = z.string().max(32).safeParse(contentType);
  if (!mediaType.success) throw new TypeError("contentType");
  const encoded = z.string().max(Math.ceil(LAUNCH_IMAGE_MAX_BYTES / 3) * 4).regex(BASE64).safeParse(data);
  if (!encoded.success) throw new TypeError("data");
  const bytes = Buffer.from(encoded.data, "base64");
  const sniffed = sniffLaunchImage(bytes, mediaType.data);
  if (!sniffed.ok) throw new TypeError(sniffed.reason);
  return { contentType: sniffed.contentType, bytes, stored: null };
}

/**
 * `launch_asset`: a Privy session or a Wallet Proof uploads one launch image.
 * After the credential is verified and outside any database transaction, the
 * image is decoded, re-encoded, and stored at its content address; the
 * protected write then only returns that reference. A refused image is a 400
 * that spends no proof, stores nothing, and never opens a transaction.
 */
export function launchAssetMutation(
  store: LaunchAssetStore | null,
): LaunchpadMutationDefinition<Upload, LaunchAssetReference> {
  return {
    action: "launch_asset",
    fields: ["contentType", "data"],
    maxBodyBytes: 64 * 1_024,
    parse: parseUpload,
    rateLimit: {
      bucket: "launchpad_launch_asset",
      subject: ({ ip }) => ({ ip }),
    },
    async prepare(input) {
      if (!store) throw new LaunchpadMutationError("LAUNCHPAD_UNAVAILABLE");
      const sanitized = await sanitizeLaunchImage(
        input.bytes,
        input.contentType,
      );
      if (!sanitized.ok) throw invalidRequest();
      const { image } = sanitized;
      const sha256 = createHash("sha256").update(image.bytes).digest("hex");
      let url: string;
      try {
        const stored = await store.write(
          `launch-assets/${sha256}.${EXTENSIONS[image.contentType]}`,
          image.bytes,
          image.contentType,
        );
        url = parseHttpsUrl(stored.url, 2_048);
      } catch {
        throw new LaunchpadMutationError("LAUNCHPAD_UNAVAILABLE");
      }
      const stored = {
        url,
        sha256,
        contentType: image.contentType,
        width: image.width,
        height: image.height,
        bytes: image.bytes.length,
      };
      return { ...input, stored };
    },
    async write({ input }) {
      if (!input.stored)
        throw new LaunchpadMutationError("LAUNCHPAD_UNAVAILABLE");
      return input.stored;
    },
    present: (asset) => ({ asset }),
  };
}

export function launchAssetHandler(
  store: LaunchAssetStore | null,
  dependencies: LaunchpadMutationDependencies,
): (request: Request, client: ClientAddress) => Promise<Response> {
  return createLaunchpadMutationHandler(
    launchAssetMutation(store),
    dependencies,
  );
}
