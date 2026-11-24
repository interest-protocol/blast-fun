/**
 * The signed-in account as the shell shows it: the top bar's avatar and the
 * account menu. `verified` is the rosette:
 * `me.verified` (OA-8: X linked; UI-02/03 added the field). `callsign` and `displayName` are null for a
 * session whose Blast Account is not created yet.
 */
export type ShellViewer = Readonly<{
  accountId: string;
  callsign: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  verified: boolean;
}>;

/** The `me` account fields the shell reads. */
export type ShellViewerSource = Readonly<{
  account_id: string;
  callsign: string;
  display_name: string | null;
  avatar_url: string | null;
  verified: boolean;
}>;

/** The shell's viewer for a `me` account (OA-8: verified = X linked). */
export function shellViewerOf(account: ShellViewerSource): ShellViewer {
  return {
    accountId: account.account_id,
    callsign: account.callsign,
    displayName: account.display_name,
    avatarUrl: account.avatar_url,
    verified: account.verified,
  };
}
