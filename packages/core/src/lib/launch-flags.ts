/**
 * Launch flags are public when set to "true". The historical "team" value
 * is an alias so existing deployments do not need an environment change.
 */
type Environment = Readonly<Record<string, string | undefined>>;

export const LAUNCH_FLAG_VARIABLES = {
  presale: "BLAST_PRESALE_ENABLED",
  social: "BLAST_SOCIAL_ENABLED",
  trading: "BLAST_TRADING_ENABLED",
  launchpad: "BLAST_LAUNCHPAD_ENABLED",
} as const;
export type LaunchSurface = keyof typeof LAUNCH_FLAG_VARIABLES;
export const LAUNCH_SURFACES = Object.keys(LAUNCH_FLAG_VARIABLES) as readonly LaunchSurface[];

export type LaunchFlags = Readonly<Record<LaunchSurface, boolean>>;

export function launchFlagsFor(environment: Environment = process.env): LaunchFlags {
  return Object.freeze({
    presale: isLaunchEnabled("presale", environment),
    social: isLaunchEnabled("social", environment),
    trading: isLaunchEnabled("trading", environment),
    launchpad: isLaunchEnabled("launchpad", environment),
  });
}

export function isLaunchEnabled(surface: LaunchSurface, environment: Environment = process.env): boolean {
  const value = environment[LAUNCH_FLAG_VARIABLES[surface]];
  return value === "true" || value === "team";
}
