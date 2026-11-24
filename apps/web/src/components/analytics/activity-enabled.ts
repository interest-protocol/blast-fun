/** Public build-time opt-in, independent of the server's private collection flag. */
export function isAccountActivityEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ANALYTICS_ACCOUNT_ACTIVITY_ENABLED === "true";
}
