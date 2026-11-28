"use client";

import Link from "next/link";
import { SIGN_IN_DRAFT_EVENT } from "#web/components/social/sign-in-draft.ts";
import { redirect } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { Button, DisclosureButton } from "#web/components/blast-ui/Button.tsx";
import { DiagnosticCode } from "#web/components/blast-ui/DiagnosticText.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { GoogleLogo, HelmetMark, WalletIcon, XLogo } from "#web/components/blast-ui/Icons.tsx";
import { Sheet, SheetClose, SheetHeading } from "#web/components/blast-ui/Sheet.tsx";
import { SkeletonBox, SkeletonRegion } from "#web/components/blast-ui/Skeleton.tsx";
import { useShellAction } from "#web/components/blast-ui/shell-actions.tsx";
import { startPrivy, usePrivyLoginEvents, usePrivySession } from "#web/components/auth/privy-session.ts";
import { usePreparePrivyWalletPicker } from "#web/components/auth/privy-wallet-picker.ts";
import { usePrivySessionMounted } from "#web/components/presale/providers/PrivySessionProvider.tsx";
import { switchAccountSession, type AccountSession } from "#web/components/social/account-selection.ts";
import { useSocialViewer } from "#web/components/social/SignInGate.tsx";
import { useWalletSession } from "#web/components/social/WalletSession.tsx";
import { diagnosticMessage } from "#web/lib/errors.ts";

import styles from "./SignIn.module.css";
import { methodsDisabled, oauthErrorState, PRIVY_OAUTH_PROVIDERS, PRIVY_WALLET_LOGIN, SIGN_IN_ATTEMPT_STORAGE_KEY, SIGN_IN_IDLE, SIGN_IN_METHOD_LABELS, SIGN_IN_METHOD_NAMES, SOCIAL_SIGN_IN_METHODS, signInMessage, storedAttempt, waitingMethod, walletLoginErrorState, type PrivySignInMethod, type SignInMethod, type SignInState, type SuiSignInMethod } from "./sign-in-flow";

type SuiWalletSignerModule = typeof import("./sui-wallet-signer");
let suiWalletSignerModule: SuiWalletSignerModule | null = null;

/** The Sui wallet kit (dApp Kit, Slush, the node client): code only, loaded when a sign-in surface opens, not with every page. */
function loadSuiWalletSigner(): Promise<SuiWalletSignerModule> {
  return import("./sui-wallet-signer").then((module) => (suiWalletSignerModule = module));
}

type SuiWalletDiscovery = readonly SuiSignInMethod[] | "unavailable" | null;

function useSuiSignInWallets(active: boolean) {
  const [wallets, setWallets] = useState<SuiWalletDiscovery>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setWallets(null);
    setAttempt((previous) => previous + 1);
  }, []);
  useEffect(() => {
    if (!active) return;

    let current = true;
    let unsubscribe: (() => void) | undefined;
    void loadSuiWalletSigner().then((module) => {
      if (current) unsubscribe = module.subscribeSuiSignInWallets(setWallets);
    }).catch(() => {
      if (current) setWallets("unavailable");
    });
    return () => {
      current = false;
      unsubscribe?.();
    };
  }, [active, attempt]);
  return { wallets, retry };
}

const HEADING_ID = "blast-sign-in-title";
const SUI_WALLETS_UNAVAILABLE = "Sui wallets could not load";
const SUI_WALLETS_VISIBLE = 4;
const METHOD_ICONS: Readonly<Record<PrivySignInMethod, () => ReactNode>> = {
  x: () => <XLogo />,
  google: () => <GoogleLogo />,
  wallet: () => <WalletIcon />,
};

/** The shared sign-in options for the sheet and the standalone page. */
export function SignInContent({
  state,
  walletAvailable,
  suiWallets = null,
  onRetryWallets,
  onMethod,
  unavailable = false,
  headingId = HEADING_ID,
  additionalAccount,
  resumeAccount,
}: Readonly<{
  state: SignInState;
  walletAvailable: boolean;
  suiWallets?: SuiWalletDiscovery;
  onRetryWallets?: () => void;
  onMethod?: (method: SignInMethod) => void;
  /** No Privy session: the methods show but cannot start. */
  unavailable?: boolean;
  headingId?: string;
  additionalAccount?: AccountSession;
  resumeAccount?: AccountSession;
}>) {
  const waiting = waitingMethod(state);
  const disabled = unavailable || methodsDisabled(state);
  const message = signInMessage(state, additionalAccount !== undefined);
  const title = signInTitle(additionalAccount);

  const renderMethod = (method: SignInMethod) => {
    const suiWallet = typeof method !== "string";
    const id = suiWallet ? `sui:${method.id}` : method;
    const name = suiWallet ? method.wallet.name : SIGN_IN_METHOD_NAMES[method];
    const isWaiting = suiWallet ? typeof waiting === "object" && waiting?.id === method.id : waiting === method;
    const label = isWaiting ? `Waiting for ${name}` : suiWallet ? name : SIGN_IN_METHOD_LABELS[method];
    const accessibleLabel = suiWallet && !isWaiting ? `Sign in with ${name}` : label;
    const icon = suiWallet ? <SuiWalletIcon icon={method.wallet.icon} /> : METHOD_ICONS[method]();
    return (
      <Button
        aria-busy={isWaiting || undefined}
        aria-label={accessibleLabel}
        className={styles.method}
        data-sign-in-method={id}
        disabled={disabled}
        key={id}
        onClick={() => onMethod?.(method)}
        size="lg"
        variant={method === "x" ? "ink" : "secondary"}
      >
        {isWaiting ? <span aria-hidden="true" className={styles.spin} /> : icon}
        <span className={styles.methodLabel}>{label}</span>
      </Button>
    );
  };

  return (
    <>
      <span aria-hidden="true" className={styles.mark}>
        <HelmetMark />
      </span>
      <SheetHeading id={headingId} title={title} />
      <div className={styles.methods}>
        {resumeAccount === "privy" ? (
          <Button className={styles.method} data-sign-in-method="resume-privy" disabled={disabled} onClick={() => switchAccountSession("privy")} size="lg" variant="ink">
            Continue with Privy
          </Button>
        ) : additionalAccount !== "wallet" && SOCIAL_SIGN_IN_METHODS.map(renderMethod)}
        {walletAvailable ? (
          <SuiWalletOptions disabled={disabled} onRetry={onRetryWallets} renderMethod={renderMethod} wallets={suiWallets} />
        ) : null}
        {resumeAccount !== "privy" && additionalAccount !== "wallet" && renderMethod("wallet")}
        {resumeAccount === "wallet" && (
          <Button className={styles.method} data-sign-in-method="resume-wallet" disabled={disabled} onClick={() => switchAccountSession("wallet")} size="lg" variant="secondary">
            Continue with Sui wallet
          </Button>
        )}
      </div>
      {message ? (
        <p className={styles.message} role={message.alert ? "alert" : "status"}>
          {message.text}
        </p>
      ) : null}
      <p className={styles.fine}>
        By continuing you agree to the <Link href="/terms">Terms</Link> and the <Link href="/privacy">Privacy Policy</Link>.
      </p>
    </>
  );
}

function signInTitle(additionalAccount?: AccountSession): string {
  if (additionalAccount === "wallet") {
    return "Sign in with Slush";
  }
  if (additionalAccount === "privy") {
    return "Sign in with Privy";
  }
  return "Join Blast";
}

function SuiWalletOptions({ disabled, onRetry, renderMethod, wallets }: Readonly<{
  disabled: boolean;
  onRetry?: () => void;
  renderMethod: (method: SuiSignInMethod) => ReactNode;
  wallets: SuiWalletDiscovery;
}>) {
  const labelId = useId();

  return (
    <div aria-labelledby={labelId} className={styles.walletGroup} role="group">
      <p className={styles.groupLabel} id={labelId}>Sui wallets</p>
      {wallets === null ? (
        <SkeletonRegion className={styles.walletMethods} label="Finding Sui wallets">
          <SkeletonBox className={styles.walletSkeleton} />
          <SkeletonBox className={styles.walletSkeleton} />
        </SkeletonRegion>
      ) : wallets === "unavailable" ? (
        <EmptyState
          action={onRetry ? <Button disabled={disabled} onClick={onRetry} size="sm" variant="secondary">Try again</Button> : null}
          compact
          role="alert"
          title={SUI_WALLETS_UNAVAILABLE}
        >
          <DiagnosticCode
            generic={SUI_WALLETS_UNAVAILABLE}
            message={diagnosticMessage(SUI_WALLETS_UNAVAILABLE, { code: "authentication_unavailable" })}
          />
        </EmptyState>
      ) : wallets.length === 0 ? (
        <EmptyState compact role="status" title="No compatible Sui wallets detected" />
      ) : (
        <SuiWalletList disabled={disabled} renderMethod={renderMethod} wallets={wallets} />
      )}
    </div>
  );
}

function SuiWalletList({ disabled, renderMethod, wallets }: Readonly<{
  disabled: boolean;
  renderMethod: (method: SuiSignInMethod) => ReactNode;
  wallets: readonly SuiSignInMethod[];
}>) {
  const [expanded, setExpanded] = useState(false);
  const moreWalletsId = useId();
  return (
    <>
      <div className={styles.walletMethods}>{wallets.slice(0, SUI_WALLETS_VISIBLE).map(renderMethod)}</div>
      {wallets.length > SUI_WALLETS_VISIBLE ? (
        <>
          <DisclosureButton aria-controls={moreWalletsId} aria-expanded={expanded} disabled={disabled} onClick={() => setExpanded(!expanded)} size="lg" variant="ghost">
            {expanded ? "Show fewer Sui wallets" : "See all Sui wallets"}
          </DisclosureButton>
          <div hidden={!expanded} id={moreWalletsId}>
            <div className={styles.walletMethods}>{wallets.slice(SUI_WALLETS_VISIBLE).map(renderMethod)}</div>
          </div>
        </>
      ) : null}
    </>
  );
}

function SuiWalletIcon({ icon }: Readonly<{ icon: string }>) {
  if (!icon.startsWith("data:image/")) return <WalletIcon />;

  // Wallet Standard provides an inline image with no optimizable source URL.
  // eslint-disable-next-line @next/next/no-img-element
  return <img alt="" aria-hidden="true" draggable={false} height={24} src={icon} width={24} />;
}

type SignInFlow = Readonly<{
  state: SignInState;
  walletAvailable: boolean;
  start: (method: SignInMethod) => void;
  reset: () => void;
}>;

function readAttempt() {
  try {
    const saved = window.sessionStorage.getItem(SIGN_IN_ATTEMPT_STORAGE_KEY);
    const [savedMethod, intent] = saved?.split(":") ?? [];
    const method = storedAttempt(savedMethod ?? null);
    const switchToPrivy = intent === "switch";
    return method ? { method, switchToPrivy } : null;
  } catch {
    return null;
  }
}

function writeAttempt(method: ReturnType<typeof storedAttempt>, switchToPrivy = false): void {
  try {
    if (method) window.sessionStorage.setItem(SIGN_IN_ATTEMPT_STORAGE_KEY, switchToPrivy ? `${method}:switch` : method);
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
  onReturn: (outcome: Readonly<{ signedIn: boolean; additionalAccount?: AccountSession }>) => void,
  additionalAccount?: AccountSession,
): SignInFlow {
  const { load } = usePrivySession();
  const viewer = useSocialViewer();
  const wallet = useWalletSession();
  const [state, setState] = useState<SignInState>(SIGN_IN_IDLE);
  const live = useRef({ onReturn });
  useEffect(() => {
    live.current = { onReturn };
  });

  const finish = useCallback((method: SignInMethod, target?: AccountSession) => {
    if (target) {
      if (!switchAccountSession(target)) {
        setState({ status: "failed", method });
        live.current.onReturn({ signedIn: false, additionalAccount: target });
      }
      return;
    }
    setState(SIGN_IN_IDLE);
    live.current.onReturn({ signedIn: true });
  }, []);

  // Only answer Privy wallet logins this sheet started.
  const walletLoginOpen = useRef(false);
  const attemptGeneration = useRef(0);
  usePrivyLoginEvents((event) => {
    if (event.kind === "oauth" || event.kind === "oauth-error") {
      const attempt = readAttempt();
      writeAttempt(null);
      if (!attempt) {
        return;
      }
      const target = attempt.switchToPrivy ? "privy" : undefined;
      if (event.kind === "oauth-error") {
        setState(oauthErrorState(attempt.method, event.code));
        live.current.onReturn({ signedIn: false, additionalAccount: target });
      } else if (!event.wasAlreadyAuthenticated || target) {
        finish(attempt.method, target);
      }
      return;
    }
    if (!walletLoginOpen.current) {
      return;
    }
    if (event.kind === "login-error") {
      walletLoginOpen.current = false;
      setState(walletLoginErrorState(event.code));
    } else if (!event.wasAlreadyAuthenticated && (event.loginMethod === "siwe" || event.loginMethod === "siws")) {
      walletLoginOpen.current = false;
      finish("wallet", wallet.selection === "wallet" ? "privy" : additionalAccount);
    }
  });

  const failPrivyAttempt = useCallback((generation: number, state: SignInState) => {
    if (generation === attemptGeneration.current) {
      writeAttempt(null);
      setState(state);
    }
  }, []);

  const start = useCallback(
    (method: SignInMethod) => {
      const generation = ++attemptGeneration.current;
      setState({ status: "waiting", method });
      void (async () => {
        if (typeof method !== "string") {
          // Sui wallets use the app's own session (OA-16): no Privy step.
          // Discovery loads the module before showing a wallet so its popup can open on the click.
          const signers = suiWalletSignerModule;
          const result = signers ? await wallet.signIn(signers.suiWalletSigner(method.wallet)) : "failed";
          if (generation !== attemptGeneration.current) {
            return;
          }
          if (result === "signed-in") {
            finish(method, wallet.selection === "privy" ? "wallet" : additionalAccount);
          } else {
            setState({ status: result, method });
          }
          return;
        }
        // Privy's SDK loads with the first sign-in; the pressed method waits up to 15 s for it to start.
        let privy;
        try {
          privy = await startPrivy(load);
        } catch {
          failPrivyAttempt(generation, { status: "stalled" });
          return;
        }
        if (generation !== attemptGeneration.current) {
          return;
        }
        if (method === "wallet") {
          walletLoginOpen.current = true;
          privy.login({ ...PRIVY_WALLET_LOGIN, loginMethods: [...PRIVY_WALLET_LOGIN.loginMethods] });
          return;
        }
        document.dispatchEvent(new Event(SIGN_IN_DRAFT_EVENT));
        writeAttempt(method, additionalAccount === "privy" || wallet.selection === "wallet");
        try {
          await privy.initOAuth({ provider: PRIVY_OAUTH_PROVIDERS[method] });
        } catch {
          failPrivyAttempt(generation, { status: "failed", method });
        }
      })();
    },
    [additionalAccount, failPrivyAttempt, finish, load, wallet],
  );

  const reset = useCallback(() => {
    attemptGeneration.current += 1;
    walletLoginOpen.current = false;
    writeAttempt(null);
    setState(SIGN_IN_IDLE);
  }, []);

  // A signed-in viewer has nothing left to wait for.
  return { state: viewer.signedIn && !additionalAccount ? SIGN_IN_IDLE : state, walletAvailable: wallet.available, start, reset };
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
  const resumeAccount = useResumableAccount();
  const [mode, setMode] = useState<"default" | AccountSession | null>(null);
  const additionalAccount = mode === "wallet" || mode === "privy" ? mode : undefined;
  const open = mode !== null && (additionalAccount !== undefined || !viewer.signedIn);
  usePreparePrivyWalletPicker(open && mode !== "wallet");
  const flow = useSignInFlow((outcome) => setMode(outcome.signedIn ? null : (outcome.additionalAccount ?? "default")), additionalAccount);
  const showWallets = flow.walletAvailable && mode !== "privy";
  const suiWallets = useSuiSignInWallets(open && showWallets);
  const choices = mode === "wallet" && suiWallets.wallets !== null && suiWallets.wallets !== "unavailable"
    ? suiWallets.wallets.filter((choice) => choice.slush)
    : suiWallets.wallets;
  const { reset } = flow;

  useShellAction("openSignIn", () => {
    if (viewer.signedIn) return;
    reset();
    setMode("default");
  });
  useShellAction("openAccountSignIn", (account) => {
    if (account !== "wallet" && account !== "privy") return;
    reset();
    setMode(account);
  });

  function close() {
    reset();
    setMode(null);
  }

  return (
    <Sheet
      initialFocus={() => document.getElementById(HEADING_ID)?.closest('[role="dialog"]')?.querySelector<HTMLElement>("[data-sign-in-method]") ?? null}
      labelledBy={HEADING_ID}
      onRequestClose={close}
      open={open}
    >
      <SheetClose onClick={close} />
      <SignInContent
        additionalAccount={additionalAccount}
        onMethod={flow.start}
        resumeAccount={mode === "default" ? resumeAccount : undefined}
        onRetryWallets={suiWallets.retry}
        state={flow.state}
        suiWallets={choices}
        walletAvailable={showWallets}
      />
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

function useResumableAccount(): AccountSession | undefined {
  const privy = usePrivySession();
  const wallet = useWalletSession();
  if (wallet.selection === "wallet" && !wallet.active && privy.authenticated) {
    return "privy";
  }
  if (wallet.selection === "privy" && privy.ready && !privy.authenticated && wallet.active) {
    return "wallet";
  }
}

function PrivySignInCard({ returnTo }: Readonly<{ returnTo: string }>) {
  const viewer = useSocialViewer();
  const resumeAccount = useResumableAccount();
  usePreparePrivyWalletPicker(!viewer.signedIn);
  const flow = useSignInFlow(() => undefined);
  const suiWallets = useSuiSignInWallets(!viewer.signedIn && flow.walletAvailable);
  // react-doctor-disable-next-line react-doctor/clickjacking-redirect-risk -- The page passes only signInReturnPath-allowlisted local paths; CSP forbids framing.
  if (viewer.signedIn) redirect(returnTo);
  return (
    <SignInContent
      headingId="blast-sign-in-page-title"
      onMethod={flow.start}
      resumeAccount={resumeAccount}
      state={flow.state}
      onRetryWallets={suiWallets.retry}
      suiWallets={suiWallets.wallets}
      walletAvailable={flow.walletAvailable}
    />
  );
}
