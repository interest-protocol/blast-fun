/** The public site origin without trailing slashes; production when unset. */
export function normalizeSiteOrigin(value: string | undefined): string {
  return (value ?? "https://www.blast.fun").replace(/\/+$/, "");
}

/**
 * The site origin a server signs and checks requests against. Servers have
 * no default: an unset `NEXT_PUBLIC_SITE_URL` fails at boot.
 */
export function requiredSiteOrigin(environment: Readonly<Record<string, string | undefined>>): string {
  const value = environment.NEXT_PUBLIC_SITE_URL;
  if (!value) {
    throw new Error("NEXT_PUBLIC_SITE_URL must be set.");
  }
  return normalizeSiteOrigin(value);
}
