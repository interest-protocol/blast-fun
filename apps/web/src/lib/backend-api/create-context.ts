import "server-only";

import {
  CREATE_CONTEXT_MAX_BYTES,
  decodeCreateContext,
} from "@blast/core/modules/social/create/context.ts";
import {
  boundedPageText,
  readPrivateBackendPage,
  type BackendPageReadDependencies,
} from "./private-page-read.ts";

export function createBackendPageContext(dependencies?: BackendPageReadDependencies) {
  return async () => {
    const response = await readPrivateBackendPage("/api/social/create-context", dependencies);
    return decodeCreateContext(
      await boundedPageText(response, CREATE_CONTEXT_MAX_BYTES, "Create context unavailable"),
    );
  };
}

export const readCreateContextFromBackend = createBackendPageContext();
