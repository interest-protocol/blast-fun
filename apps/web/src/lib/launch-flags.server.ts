import { cache } from "react";

import { launchFlagsFor, type LaunchFlags } from "@blast/core/lib/launch-flags.ts";

export const requestLaunchFlags = cache(async (): Promise<LaunchFlags> => launchFlagsFor());
