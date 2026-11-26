"use client";

import Link from "next/link";
import { SIGN_IN_DRAFT_EVENT } from "#web/components/social/sign-in-draft.ts";
import { redirect } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "#web/components/blast-ui/Button.tsx";
import { GoogleLogo, HelmetMark, MahaloLogo, NightlyLogo, ScallopLogo, SlushLogo, WalletIcon, XLogo } from "#web/components/blast-ui/Icons.tsx";
import { Sheet, SheetClose, SheetHeading } from "#web/components/blast-ui/Sheet.tsx";
import { useShellAction } from "#web/components/blast-ui/shell-actions.tsx";
import { startPrivy, usePrivyLoginEvents, usePrivySession } from "#web/components/auth/privy-session.ts";
import { usePreparePrivyWalletPicker } from "#web/components/auth/privy-wallet-picker.ts";
import { usePrivySessionMounted } from "#web/components/presale/providers/PrivySessionProvider.tsx";
import { useSocialViewer } from "#web/components/social/SignInGate.tsx";
import { useWalletSession } from "#web/components/social/WalletSession.tsx";

import styles from "./SignIn.module.css";
import { isSuiSignInMethod, methodsDisabled, oauthErrorState, PRIVY_OAUTH_PROVIDERS, PRIVY_WALLET_LOGIN, SIGN_IN_ATTEMPT_STORAGE_KEY, SIGN_IN_IDLE, SIGN_IN_METHOD_LABELS, SIGN_IN_METHOD_NAMES, SIGN_IN_METHODS, SUI_SIGN_IN_METHODS, SUI_WALLET_INSTALL_URLS, signInMessage, storedAttempt, waitingMethod, walletLoginErrorState, type SignInMethod, type SignInState } from "./sign-in-flow";

type SuiWalletSignerModule = typeof import("./sui-wallet-signer");
let suiWalletSignerModule: SuiWalletSignerModule | null = null;

/** The Sui wallet kit (dApp Kit, Slush, the node client): code only, loaded when a sign-in surface opens, not with every page. */
function loadSuiWalletSigner(): Promise<SuiWalletSignerModule> {
  return import("./sui-wallet-signer").then((module) => (suiWalletSignerModule = module));
}

/** Loads the Sui wallet kit while sign-in is on screen, so a press finds it ready and the wallet's popup opens from the click itself. */
function usePrepareSuiWallets(active: boolean): void {
  useEffect(() => {
    if (active) void loadSuiWalletSigner().catch(() => undefined);
  }, [active]);
}

const HEADING_ID = "blast-sign-in-title";
const METHOD_ICONS: Readonly<Record<SignInMethod, () => ReactNode>> = {
  x: () => <XLogo />,
  google: () => <GoogleLogo />,
  slush: () => <SlushLogo />,
  nightly: () => <NightlyLogo />,
  scallop: () => <ScallopLogo />,
  mahalo: () => <MahaloLogo />,
  wallet: () => <WalletIcon />,
};

/**
 * The sign-in content (FEATURE-MAP §8.2) in one state: the helmet tile,
 * "Join Blast", OAuth methods, Sui wallet tiles whenever the wallet session
 * is mounted (OA-16), "Other wallets" (OA-12), a status line after
 * an attempt that did not sign in, and the fine print. Pressing a method
 * disables all of them and shows a spinner with "Waiting for …" on the one
 * pressed.
 */
export function SignInContent({
  state,
  walletAvailable,
  onMethod,
  unavailable = false,
  headingId = HEADING_ID,
}: Readonly<{
  state: SignInState;
  walletAvailable: boolean;
  onMethod?: (method: SignInMethod) => void;
  /** No Privy session: the methods show but cannot start. */
  unavailable?: boolean;
  headingId?: string;
}>) {
  const waiting = waitingMethod(state);
  const disabled = unavailable || methodsDisabled(state);
  const message = signInMessage(state);
  const renderMethod = (method: SignInMethod) => (
    <Button
      aria-busy={waiting === method || undefined}
      aria-label={waiting === method ? `Waiting for ${SIGN_IN_METHOD_NAMES[method]}` : SIGN_IN_METHOD_LABELS[method]}
      className={styles.method}
      data-sign-in-method={method}
      disabled={disabled}
      key={method}
      onClick={() => onMethod?.(method)}
      size="lg"
      variant={method === "x" ? "ink" : "secondary"}
    >
      {waiting === method ? <span aria-hidden="true" className={styles.spin} /> : METHOD_ICONS[method]()}
      {waiting === method ? `Waiting for ${SIGN_IN_METHOD_NAMES[method]}` : isSuiSignInMethod(method) ? SIGN_IN_METHOD_NAMES[method] : SIGN_IN_METHOD_LABELS[method]}
    </Button>
  );
  return (
    <>
      <span aria-hidden="true" className={styles.mark}>
        <HelmetMark />
      </span>
      <SheetHeading id={headingId} title="Join Blast" />
      <div className={styles.methods}>
        {SIGN_IN_METHODS.filter((method) => method === "x" || method === "google").map(renderMethod)}
        {walletAvailable ? (
          <div aria-label="Sui wallets" className={styles.walletGroup} role="group">
            <p className={styles.groupLabel}>Sui wallets</p>
            <div className={styles.walletMethods}>{SUI_SIGN_IN_METHODS.map(renderMethod)}</div>
          </div>
        ) : null}
        {renderMethod("wallet")}
      </div>
      {message ? (
        <p className={styles.message} role={message.alert ? "alert" : "status"}>
          {message.text}
        </p>
      ) : null}
      {state.status === "failed" && (state.method === "nightly" || state.method === "scallop" || state.method === "mahalo") ? (
        <p className={styles.message}>
          Need the extension? <a href={SUI_WALLET_INSTALL_URLS[state.method]} target="_blank" rel="noopener noreferrer">Install {SIGN_IN_METHOD_NAMES[state.method]}</a>, then try again.
        </p>
      ) : null}
      <p className={styles.fine}>
        By continuing you agree to the <Link href="/terms">Terms</Link> and the <Link href="/privacy">Privacy Policy</Link>.
      </p>
    </>
  );
}

type SignInFlow = Readonly<{
  state: SignInState;
  walletAvailable: boolean;
  start: (method: SignInMethod) => void;
  reset: () => void;
}>;

function readAttempt(): SignInMethod | null {
  try {
    return storedAttempt(window.sessionStorage.getItem(SIGN_IN_ATTEMPT_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeAttempt(method: SignInMethod | null): void {
  try {
    if (method) window.sessionStorage.setItem(SIGN_IN_ATTEMPT_STORAGE_KEY, method);
    else window.sessionStorage.removeItem(SIGN_IN_ATTEMPT_STORAGE_KEY);
  } catch {
    // Blocked storage only costs the cancel message after a redirect.
  }
}

/**
 * Runs the methods against the one Privy session. X and Google use Privy's
 * OAuth without its modal: the page goes to the provider and comes back
 * signed in (Privy finishes the flow on return; `onReturn` hears how it
 * ended). A Sui wallet proves the address to the web app, which starts its own
 * session (`WalletSession.tsx`, OA-16; Privy is not involved). A signed-in viewer ends any attempt.
 */
function useSignInFlow(
  onReturn: (outcome: Readonly<{ signedIn: true; method: SignInMethod } | { signedIn: false; state: SignInState }>) => void,
): SignInFlow {
  const { load } = usePrivySession();
  const viewer = useSocialViewer();
  const wallet = useWalletSession();
  const [state, setState] = useState<SignInState>(SIGN_IN_IDLE);
  const live = useRef({ onReturn });
  useEffect(() => {
    live.current = { onReturn };
  });

  // Privy's login events are shared by every flow: only a wallet login this sheet opened is answered.
  const walletLoginOpen = useRef(false);
  usePrivyLoginEvents((event) => {
    if (event.kind === "oauth") {
      const method = readAttempt();
      writeAttempt(null);
      if (method && !event.wasAlreadyAuthenticated) live.current.onReturn({ signedIn: true, method });
    } else if (event.kind === "oauth-error") {
      const method = readAttempt();
      writeAttempt(null);
      if (!method) return;
      const next = oauthErrorState(method, event.code);
      setState(next);
      live.current.onReturn({ signedIn: false, state: next });
    } else if (event.kind === "login") {
      // EVM and Solana wallets: Privy's own wallet list (OA-12).
      if (!walletLoginOpen.current || event.wasAlreadyAuthenticated || (event.loginMethod !== "siwe" && event.loginMethod !== "siws")) return;
      walletLoginOpen.current = false;
      live.current.onReturn({ signedIn: true, method: "wallet" });
    } else {
      if (!walletLoginOpen.current) return;
      walletLoginOpen.current = false;
      setState(walletLoginErrorState(event.code));
    }
  });

  const start = useCallback(
    (method: SignInMethod) => {
      setState({ status: "waiting", method });
      void (async () => {
        if (isSuiSignInMethod(method)) {
          // Sui wallets use the app's own session (OA-16): no Privy step.
          // Loaded with the sheet; a press that beats the load waits for it (a web wallet may then ask for a second click).
          const signers = suiWalletSignerModule ?? (await loadSuiWalletSigner().catch(() => null));
          if (signers === null) {
            setState({ status: "failed", method });
            return;
          }
          const result = await wallet.signIn(signers.suiWalletSigner(method));
          if (result !== "signed-in") {
            setState({ status: result === "rate-limited" ? "rate-limited" : result === "cancelled" ? "cancelled" : "failed", method });
            return;
          }
          setState(SIGN_IN_IDLE);
          live.current.onReturn({ signedIn: true, method });
          return;
        }
        // Privy's SDK loads with the first sign-in; the pressed method waits up to 15 s for it to start.
        let privy;
        try {
          privy = await startPrivy(load);
        } catch {
          setState({ status: "stalled" });
          return;
        }
        if (method === "wallet") {
          walletLoginOpen.current = true;
          privy.login({ ...PRIVY_WALLET_LOGIN, loginMethods: [...PRIVY_WALLET_LOGIN.loginMethods] });
          return;
        }
        document.dispatchEvent(new Event(SIGN_IN_DRAFT_EVENT));
        writeAttempt(method);
        try {
          await privy.initOAuth({ provider: PRIVY_OAUTH_PROVIDERS[method] });
        } catch {
          writeAttempt(null);
          setState({ status: "failed", method });
        }
      })();
    },
    [load, wallet],
  );

  const reset = useCallback(() => setState(SIGN_IN_IDLE), []);

  // A signed-in viewer has nothing left to wait for.
  return { state: viewer.signedIn ? SIGN_IN_IDLE : state, walletAvailable: wallet.available, start, reset };
}

/**
 * The sign-in sheet over the current page, the shell's `openSignIn` action
 * (the rail and top-bar "Sign in" and every gated action). On success it
 * closes, the page reads as signed in, and "Welcome back, <first name>"
 * shows. Needs the Privy session;
 * without it the shell's "Sign in" stays a link to `/sign-in`.
 */
export function SignInSheet() {
  return usePrivySessionMounted() ? <PrivySignInSheet /> : null;
}

function PrivySignInSheet() {
  const viewer = useSocialViewer();
  const [open, setOpen] = useState(false);
  usePreparePrivyWalletPicker(open && !viewer.signedIn);
  usePrepareSuiWallets(open && !viewer.signedIn);
  const flow = useSignInFlow((outcome) => setOpen(!outcome.signedIn));
  const { reset } = flow;

  useShellAction("openSignIn", () => {
    if (viewer.signedIn) return;
    reset();
    setOpen(true);
  });

  return (
    <Sheet
      initialFocus={() => document.querySelector<HTMLElement>("[data-sign-in-method]")}
      labelledBy={HEADING_ID}
      onRequestClose={() => setOpen(false)}
      open={open && !viewer.signedIn}
    >
      <SheetClose onClick={() => setOpen(false)} />
      <SignInContent onMethod={flow.start} state={flow.state} walletAvailable={flow.walletAvailable} />
    </Sheet>
  );
}

/**
 * `/sign-in`, the fallback for deep links and no-JS: the same content as a
 * card in the page. Once signed in (or if already) it goes to `returnTo`, an
 * allowlisted path (`signInReturnPath`).
 */
export function SignInCard({ returnTo }: Readonly<{ returnTo: string }>) {
  const mounted = usePrivySessionMounted();
  return (
    <div className={styles.page}>
      <section aria-labelledby="blast-sign-in-page-title" className={styles.card}>
        {mounted ? (
          <PrivySignInCard returnTo={returnTo} />
        ) : (
          <>
            <SignInContent headingId="blast-sign-in-page-title" state={SIGN_IN_IDLE} unavailable walletAvailable={false} />
            <p className={styles.message} role="status">
              Sign-in is not available right now. You can keep reading as a visitor.
            </p>
          </>
        )}
      </section>
      <Link className={styles.back} href={returnTo}>
        Back
      </Link>
    </div>
  );
}

function PrivySignInCard({ returnTo }: Readonly<{ returnTo: string }>) {
  const viewer = useSocialViewer();
  usePreparePrivyWalletPicker(!viewer.signedIn);
  usePrepareSuiWallets(!viewer.signedIn);
  const flow = useSignInFlow(() => undefined);
  // react-doctor-disable-next-line react-doctor/clickjacking-redirect-risk -- The page passes only signInReturnPath-allowlisted local paths; CSP forbids framing.
  if (viewer.signedIn) redirect(returnTo);
  return (
    <SignInContent
      headingId="blast-sign-in-page-title"
      onMethod={flow.start}
      state={flow.state}
      walletAvailable={flow.walletAvailable}
    />
  );
}
