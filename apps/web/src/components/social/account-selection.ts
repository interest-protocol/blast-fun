import { withdrawalSwitchBlock } from "./coins/withdraw-attempt.ts";

const PREFERENCE = "blast_active_account";
const accountSwitch = new AbortController();

/** Cancels work from the old account while the browser reloads. */
export const accountSwitchSignal = accountSwitch.signal;

export type AccountSession = "privy" | "wallet";

/** A non-secret preference. Authentication still requires the chosen session. */
export function selectedAccountSession(cookie: string): AccountSession | null {
  const selection = cookie.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${PREFERENCE}=`))?.slice(PREFERENCE.length + 1);
  return selection === "privy" || selection === "wallet" ? selection : null;
}

export function rememberAccountSession(session: AccountSession | null): boolean {
  const setting = session ?? "; Max-Age=0";
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  try {
    document.cookie = `${PREFERENCE}=${setting}; Path=/; SameSite=Lax${secure}`;
    return selectedAccountSession(document.cookie) === session;
  } catch {
    return false;
  }
}

export function switchAccountSession(session: AccountSession): boolean {
  if (withdrawalSwitchBlock() || !rememberAccountSession(session)) {
    return false;
  }
  accountSwitch.abort();
  // Start the selected account with a fresh server render, query cache, and transaction forms.
  window.location.reload();
  return true;
}
