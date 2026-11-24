"use client";

import { createContext, useContext } from "react";

/**
 * The request's launchpad flag (`launchFlagsFor`), from the app layout through `SocialShell`.
 * A surface that reads the launchpad's API hides while it is off: `/api/launchpad` answers
 * not-found under the same flag, which would otherwise read as a failed or invalid answer.
 * Outside the shell (tests, fixtures) the launchpad counts as on.
 */
const LaunchpadFlag = createContext(true);

export const LaunchpadFlagProvider = LaunchpadFlag.Provider;

export function useLaunchpadEnabled(): boolean {
  return useContext(LaunchpadFlag);
}
