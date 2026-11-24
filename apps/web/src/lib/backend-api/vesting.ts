import "server-only";

import { VestingReadError } from "@blast/core/modules/vesting/errors.ts";
import type { VestingDetail } from "@blast/core/modules/vesting/model.ts";
import {
  readPrivateBackendPage,
  type BackendPageReadDependencies,
} from "./private-page-read.ts";

export function vestingBackendPageRead(dependencies?: BackendPageReadDependencies) {
  return async (id: string): Promise<VestingDetail> => {
    const response = await readPrivateBackendPage(
      `/api/vesting/${encodeURIComponent(id)}`,
      dependencies,
    );
    if (response.status === 404) throw new VestingReadError("not_found");
    if (response.status === 422) throw new VestingReadError("unsupported");
    if (!response.ok) throw new VestingReadError("unavailable");
    return response.json() as Promise<VestingDetail>;
  };
}

export const readVestingFromBackend = vestingBackendPageRead();
