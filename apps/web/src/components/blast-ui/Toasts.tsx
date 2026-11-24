"use client";

import { createContext, useCallback, useContext, useLayoutEffect, useSyncExternalStore, type FocusEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { toast as sonner, Toaster, type ToastClassnames } from "sonner";

import { AlertCircleIcon, CheckIcon, CloseIcon, ExternalIcon } from "./Icons";
import styles from "./Toasts.module.css";

/**
 * Toasts (FEATURE-MAP §18), on sonner (OA-28): bottom right (centred above
 * the tab bar on phones), in a polite live region. A plain toast lives 3.6 s;
 * one with a subtitle or link is "rich", and one with a link lives 7 s with a
 * dismiss button. Errors and recovery actions remain until used or dismissed.
 * The pointer over the stack pauses the timers.
 * sonner keeps the list, the timers and the exit;
 * `Toasts.module.css` draws the gate's toast and its motion.
 */
export type ToastOptions = Readonly<{
  sub?: string;
  titleContent?: ReactNode;
  href?: string;
  link?: string;
  id?: string;
  tone?: "error";
  action?: Readonly<{ label: string; onClick: () => void }>;
  /** Mobile claim feedback occupies space beside its result instead of floating over it. */
  mobileTargetId?: string;
}>;

export type ShowToast = (title: string, options?: ToastOptions) => void;

/**
 * Hands one toast to the shell's `<Toaster>`. `dismissible: false` turns off
 * sonner's swipe to dismiss, which the gate does not have; the dismiss button
 * and the timer still close it.
 */
const showToast: ShowToast = (title, options = {}) => {
  const life = toastDuration(options);
  const returnFocus = typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const inline = options.mobileTargetId && mobileTarget(options.mobileTargetId);
  sonner.custom((id) => options.mobileTargetId
    ? <PlacedToastBody id={id} options={options} returnFocus={returnFocus} title={title} />
    : <ToastBody id={id} options={options} returnFocus={returnFocus} title={title} />, {
    className: [options.tone === "error" ? styles.error : options.sub || options.href || options.action ? styles.rich : undefined, options.mobileTargetId ? styles.anchored : undefined].filter(Boolean).join(" ") || undefined,
    dismissible: false,
    duration: inline ? Infinity : life,
    position: options.mobileTargetId ? inline ? "top-center" : "bottom-right" : undefined,
    id: options.id,
  });
};

const noop: ShowToast = () => undefined;
const ToastContext = createContext<ShowToast>(noop);

/** Shows a toast in the shell's live region (does nothing outside a shell). */
export function useToast(): ShowToast {
  return useContext(ToastContext);
}

/** sonner's two wrappers around a custom toast's markup take no box, so the gate's children lay out in the toast. */
const TOAST_CLASSES: ToastClassnames = { content: styles.contents, title: styles.contents };
/** No hotkey: sonner's Alt+T would take focus from a field where macOS types "†". */
const NO_HOTKEY: string[] = [];

const toastDuration = (options: ToastOptions) => options.tone === "error" || options.action ? Infinity : options.href ? 7000 : 3600;

const MOBILE_QUERY = "(max-width: 760px)";
const mobileTargets = new Map<string, HTMLElement>();
const targetListeners = new Set<() => void>();
function subscribeMobile(listener: () => void) {
  const media = window.matchMedia(MOBILE_QUERY);
  targetListeners.add(listener);
  media.addEventListener("change", listener);
  return () => { targetListeners.delete(listener); media.removeEventListener("change", listener); };
}
const isMobile = () => window.matchMedia(MOBILE_QUERY).matches;
const serverTarget = () => null;

/** Register the row's feedback slot and notify active results when it mounts or leaves. */
export function MobileToastTarget({ id, className }: Readonly<{ id: string; className?: string }>) {
  const register = useCallback((node: HTMLDivElement | null) => {
    if (node) mobileTargets.set(id, node);
    else mobileTargets.delete(id);
    targetListeners.forEach(listener => listener());
  }, [id]);
  return <div className={className} id={id} ref={register} />;
}

function mobileTarget(id: string): HTMLElement | null {
  return typeof document !== "undefined" && isMobile() ? mobileTargets.get(id) ?? null : null;
}

/** Retain Sonner's lifecycle while placing the one visible result in its mobile row. */
function PlacedToastBody(props: Parameters<typeof ToastBody>[0]) {
  const snapshot = useCallback(() => props.options.mobileTargetId ? mobileTarget(props.options.mobileTargetId) : null, [props.options.mobileTargetId]);
  const target = useSyncExternalStore(subscribeMobile, snapshot, serverTarget);
  useLayoutEffect(() => {
    const entry = sonner.getToasts().find(toast => toast.id === props.id);
    if (!entry || !("jsx" in entry) || !entry.jsx) return;
    const duration = target ? Infinity : toastDuration(props.options);
    // Separate the empty shells from floating messages so they add no stack gaps.
    const position = target ? "top-center" : "bottom-right";
    if (entry.duration !== duration || entry.position !== position) {
      const jsx = entry.jsx;
      sonner.custom(() => <>{jsx}</>, { id: props.id, duration, position });
    }
  }, [props.id, props.options, target]);
  if (!target) return <ToastBody {...props} />;
  return <>
    <span aria-hidden="true" data-inline-toast-placeholder />
    {createPortal(
      <ol className={`${styles.toasts} ${styles.inline}`} data-sonner-toaster onBlur={stopToasterFocusTracking} onFocus={stopToasterFocusTracking}>
        <li aria-atomic="true" aria-live="polite" className={`${styles.toast} ${props.options.tone === "error" ? styles.error : styles.rich}`} data-mounted="true" data-sonner-toast role="status">
          <ToastBody {...props} />
        </li>
      </ol>, target,
    )}
  </>;
}

/** Custom actions restore their trigger; Sonner would otherwise refocus the removed toast. */
function stopToasterFocusTracking(event: FocusEvent<HTMLElement>) {
  event.stopPropagation();
}

/** Hosts the toast region; the app shell mounts it once. */
export function ToastProvider({ children }: Readonly<{ children: ReactNode }>) {
  const outer = useContext(ToastContext);
  if (outer !== noop) return children;
  return (
    <ToastContext value={showToast}>
      {children}
      <Toaster
        className={styles.toasts}
        customAriaLabel="Notifications"
        expand
        gap={8}
        hotkey={NO_HOTKEY}
        position="bottom-right"
        toastOptions={{ unstyled: true, className: styles.toast, classNames: TOAST_CLASSES }}
        visibleToasts={Infinity}
      />
    </ToastContext>
  );
}

/** Shared feedback with an error icon and recovery action when requested. */
export function ToastBody({
  id,
  title,
  options,
  returnFocus,
}: Readonly<{ id: number | string; title: string; options: ToastOptions; returnFocus?: HTMLElement | null }>) {
  const dismiss = () => {
    sonner.dismiss(id);
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  };
  return (
    <>
      <span className={options.tone === "error" ? `${styles.tick} ${styles.errorIcon}` : styles.tick}>
        {options.tone === "error" ? <AlertCircleIcon /> : <CheckIcon />}
      </span>
      <span className={styles.text}>
        <b>{options.titleContent ?? title}</b>
        {options.sub ? <span>{options.sub}</span> : null}
        {options.href ? (
          <a className={styles.link} href={options.href} rel={options.href.startsWith("/") ? undefined : "noopener noreferrer"} target={options.href.startsWith("/") ? undefined : "_blank"}>
            {options.link ?? "View transaction"}
            {options.href.startsWith("/") ? null : <ExternalIcon />}
          </a>
        ) : null}
      </span>
      {options.action ? (
        <button className={styles.retry} onBlur={stopToasterFocusTracking} onClick={() => { dismiss(); options.action?.onClick(); }} onFocus={stopToasterFocusTracking} type="button">
          {options.action.label}
        </button>
      ) : null}
      {options.href || options.action || options.tone === "error" ? (
        <button aria-label="Dismiss" className={styles.close} onBlur={stopToasterFocusTracking} onClick={dismiss} onFocus={stopToasterFocusTracking} type="button">
          <CloseIcon />
        </button>
      ) : null}
    </>
  );
}
