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
}: Readonly<{
  state: SignInState;
  walletAvailable: boolean;
  suiWallets?: SuiWalletDiscovery;
  onRetryWallets?: () => void;
  onMethod?: (method: SignInMethod) => void;
  /** No Privy session: the methods show but cannot start. */
  unavailable?: boolean;
  headingId?: string;
}>) {
  const waiting = waitingMethod(state);
  const disabled = unavailable || methodsDisabled(state);
  const message = signInMessage(state);

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
      <SheetHeading id={headingId} title="Join Blast" />
      <div className={styles.methods}>
        {SOCIAL_SIGN_IN_METHODS.map(renderMethod)}
        {walletAvailable ? (
          <SuiWalletOptions disabled={disabled} onRetry={onRetryWallets} renderMethod={renderMethod} wallets={suiWallets} />
        ) : null}
        {renderMethod("wallet")}
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

function readAttempt(): ReturnType<typeof storedAttempt> {
  try {
    return storedAttempt(window.sessionStorage.getItem(SIGN_IN_ATTEMPT_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeAttempt(method: ReturnType<typeof storedAttempt>): void {
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
        if (typeof method !== "string") {
          // Sui wallets use the app's own session (OA-16): no Privy step.
          // Discovery loads the module before showing a wallet so its popup can open on the click.
          const signers = suiWalletSignerModule;
          if (signers === null) {
            setState({ status: "failed", method });
            return;
          }
          const result = await wallet.signIn(signers.suiWalletSigner(method.wallet));
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
  const flow = useSignInFlow((outcome) => setOpen(!outcome.signedIn));
  const suiWallets = useSuiSignInWallets(open && !viewer.signedIn && flow.walletAvailable);
  const { reset } = flow;

  useShellAction("openSignIn", () => {
    if (viewer.signedIn) return;
    reset();
    setOpen(true);
  });

  return (
    <Sheet
      initialFocus={() => document.getElementById(HEADING_ID)?.closest('[role="dialog"]')?.querySelector<HTMLElement>("[data-sign-in-method]") ?? null}
      labelledBy={HEADING_ID}
      onRequestClose={() => setOpen(false)}
      open={open && !viewer.signedIn}
    >
      <SheetClose onClick={() => setOpen(false)} />
      <SignInContent onMethod={flow.start} onRetryWallets={suiWallets.retry} state={flow.state} suiWallets={suiWallets.wallets} walletAvailable={flow.walletAvailable} />
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
  const flow = useSignInFlow(() => undefined);
  const suiWallets = useSuiSignInWallets(!viewer.signedIn && flow.walletAvailable);
  // react-doctor-disable-next-line react-doctor/clickjacking-redirect-risk -- The page passes only signInReturnPath-allowlisted local paths; CSP forbids framing.
  if (viewer.signedIn) redirect(returnTo);
  return (
    <SignInContent
      headingId="blast-sign-in-page-title"
      onMethod={flow.start}
      state={flow.state}
      onRetryWallets={suiWallets.retry}
      suiWallets={suiWallets.wallets}
      walletAvailable={flow.walletAvailable}
    />
  );
}
