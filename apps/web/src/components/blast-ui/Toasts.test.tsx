import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { toast as sonner, type ToastT } from "sonner";

import { LibraryProviders } from "#web/components/ui-libraries/LibraryProviders.tsx";

import { ToastProvider, useToast, type ShowToast } from "./Toasts.tsx";

/**
 * OA-28 M1: the shell's toasts on sonner. What needs no browser is here: the
 * server's HTML, what `useToast()` hands sonner, the toast's markup and its
 * dismiss button, and the motion rules in the CSS module. Showing, the timers,
 * hover, the exit and reduced motion run in Chromium under the site's CSP:
 * `scripts/ui-libraries-csp-check.ts` drives `/dev/social/ui-libraries`, whose
 * sonner probe is this provider.
 */

const NONCE = "toastsTestNonce0123456789abcdefghij";
const LINK = { sub: "From your Blast wallet", href: "https://suiscan.xyz/mainnet/tx/abc", link: "View on Suiscan" } as const;

const latest = () => sonner.getToasts().at(-1) as ToastT;
const markup = (entry: ToastT) => renderToString(entry.jsx as ReactElement);

/** Renders what `useToast()` hands it, so a test can read it. */
function Shows({ children }: Readonly<{ children: (show: ShowToast) => ReactNode }>): ReactNode {
  return children(useToast());
}

/** Tests call the same shell API as the app's surfaces. */
function toastFromShell(): ShowToast {
  let showToast: ShowToast | undefined;
  renderToString(
    <ToastProvider>
      <Shows>{(show) => { showToast = show; return null; }}</Shows>
    </ToastProvider>,
  );
  assert.ok(showToast);
  return showToast;
}

const showToast = toastFromShell();

test("OA-28 M1: the server writes the page, then one empty live region with no style, even with toasts in sonner's store", () => {
  showToast("Already showing");
  const html = renderToString(
    <LibraryProviders nonce={NONCE}>
      <ToastProvider>
        <main>Page</main>
      </ToastProvider>
    </LibraryProviders>,
  );
  assert.match(html, /^<main>Page<\/main><section aria-label="Notifications" tabindex="-1" aria-live="polite" aria-relevant="additions text" aria-atomic="false"[^>]*><\/section>$/);
  assert.doesNotMatch(html, /\sstyle="|<style|<li|<ol/);
  // No Alt+T in the label: the hotkey is off.
  assert.doesNotMatch(html, /alt\+T/i);
});

test("OA-28 M1: useToast() is the provider's showToast in a shell, and does nothing outside one", () => {
  let inside: ShowToast | null = null;
  let outside: ShowToast | null = null;
  renderToString(
    <ToastProvider>
      <Shows>
        {(show) => {
          inside = show;
          return <p>in</p>;
        }}
      </Shows>
    </ToastProvider>,
  );
  renderToString(
    <Shows>
      {(show) => {
        outside = show;
        return <p>out</p>;
      }}
    </Shows>,
  );
  assert.equal(inside, showToast);
  assert.ok(outside);
  const before = sonner.getHistory().length;
  (outside as ShowToast)("Nowhere to show");
  assert.equal(sonner.getHistory().length, before);
});

test("OA-28 M1: a plain toast lives 3.6 s, a subtitle makes it rich, a link makes it rich for 7 s; none can be swiped away", () => {
  showToast("Celebrations are on");
  const plain = latest();
  assert.equal(plain.duration, 3600);
  assert.equal(plain.className, undefined);
  assert.equal(plain.dismissible, false);
  assert.equal(plain.type, undefined);
  assert.ok(isValidElement(plain.jsx));

  showToast("Profile saved", { sub: "@kai" });
  assert.equal(latest().duration, 3600);
  assert.equal(latest().className, "rich");

  showToast("Committed $250 to Meridian", LINK);
  assert.equal(latest().duration, 7000);
  assert.equal(latest().className, "rich");
  assert.equal(latest().dismissible, false);
});

test("OA-28 M1: a toast has a tick, bold title, subtitle, explorer link and dismiss button, without a countdown", () => {
  showToast("Logged out. You can keep reading.");
  const plain = markup(latest());
  assert.match(plain, /^<span class="tick"><svg aria-hidden="true"[^>]*>.*?<\/svg><\/span><span class="text"><b>Logged out\. You can keep reading\.<\/b><\/span>$/);

  showToast("Profile saved", { sub: "@kai" });
  const rich = markup(latest());
  assert.match(rich, /<span class="text"><b>Profile saved<\/b><span>@kai<\/span><\/span>/);
  assert.doesNotMatch(rich, /<a |<button/);

  showToast("Committed $250 to Meridian", LINK);
  const linked = markup(latest());
  assert.match(
    linked,
    /<span class="text"><b>Committed \$250 to Meridian<\/b><span>From your Blast wallet<\/span><a class="link" href="https:\/\/suiscan\.xyz\/mainnet\/tx\/abc" rel="noopener noreferrer" target="_blank">View on Suiscan<svg aria-hidden="true"[^>]*>.*?<\/svg><\/a><\/span><button aria-label="Dismiss" class="close" type="button"><svg aria-hidden="true"/,
  );
  assert.doesNotMatch(linked, /countdown|--toast-life/);

  showToast("Sent", { href: "https://suiscan.xyz/mainnet/tx/def" });
  assert.match(markup(latest()), />View transaction<svg/, "a link without its own words reads View transaction");
});

test("OA-28 M1: the dismiss button closes its own toast through sonner", () => {
  const frame = globalThis.requestAnimationFrame;
  const cancel = globalThis.cancelAnimationFrame;
  // sonner tells its Toaster on the next frame; Node has none, so the frame runs at once.
  globalThis.requestAnimationFrame = (callback) => {
    callback(0);
    return 1;
  };
  globalThis.cancelAnimationFrame = () => undefined;
  try {
    showToast("Stays", { href: "https://suiscan.xyz/mainnet/tx/1" });
    const stays = latest();
    showToast("Goes", { href: "https://suiscan.xyz/mainnet/tx/2" });
    const goes = latest();
    const button = findButton(goes.jsx as ReactElement);
    button.props.onClick();
    const active = sonner.getToasts().map((entry) => entry.id);
    assert.ok(!active.includes(goes.id));
    assert.ok(active.includes(stays.id));
  } finally {
    globalThis.requestAnimationFrame = frame;
    globalThis.cancelAnimationFrame = cancel;
  }
});

test("pending feedback stays visible with a named status and no success icon", () => {
  showToast("Opening wallet…", { id: "test-loading", tone: "pending" });
  const entry = latest();
  assert.equal(entry.duration, Infinity);
  const html = markup(entry);
  assert.match(html, /aria-label="Opening wallet…"[^>]*role="status"/);
  assert.match(html, /<b>Opening wallet…<\/b>/);
  assert.doesNotMatch(html, /class="tick"/);
});

test("an error has an alert icon, separate recovery copy and a persistent, dismissible retry action", () => {
  let attempts = 0;
  showToast("Claim failed", { id: "claim-test", tone: "error", sub: "Nothing was claimed. Try again.", action: { label: "Retry", onClick: () => { attempts++; } } });
  const entry = latest();
  assert.equal(entry.duration, Infinity, "recovery remains available until used or dismissed");
  assert.equal(entry.className, "error");
  const html = markup(entry);
  assert.match(html, /class="tick errorIcon"/);
  assert.match(html, /d="M12 7.5v5"/);
  assert.match(html, /<b>Claim failed<\/b><span>Nothing was claimed\. Try again\.<\/span>/);
  assert.match(html, /class="retry"[^>]*>Retry<\/button>/);
  assert.match(html, /aria-label="Dismiss"/);
  const frame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => { callback(0); return 1; };
  try {
    findButton(entry.jsx as ReactElement).props.onClick();
    assert.equal(attempts, 1);
    assert.ok(!sonner.getToasts().some((toast) => toast.id === entry.id));
  } finally {
    globalThis.requestAnimationFrame = frame;
  }
});

/** The dismiss button in a toast's element tree (`ToastBody` renders it directly). */
function findButton(element: ReactElement): ReactElement<{ onClick: () => void }> {
  const body = element as ReactElement<Record<string, unknown>>;
  const tree = (body.type as (props: unknown) => ReactElement<{ children: ReactNode[] }>)(body.props);
  const button = tree.props.children.find((child) => isValidElement(child) && child.type === "button");
  assert.ok(isValidElement(button));
  return button as ReactElement<{ onClick: () => void }>;
}

const css = readFileSync(new URL("./Toasts.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector: string, within = css) => {
  const start = within.indexOf(`${selector} {`);
  assert.ok(start >= 0, `no rule ${selector}`);
  return within.slice(start, within.indexOf("}", start));
};
test("toast motion retargets transform and opacity without animating layout", () => {
  const toast = rule("ol.toasts > li.toast[data-sonner-toast]");
  assert.match(toast, /transition: opacity/);
  assert.match(toast, /transform 240ms/);
  assert.doesNotMatch(toast, /animation:|transition: all|transition: height/);
  assert.match(rule('ol.toasts > li.toast[data-sonner-toast][data-removed="true"][data-removed="true"]'), /opacity: 0/);
});

test("reduced-motion toast feedback keeps opacity and removes decorative movement", () => {
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /transition: opacity var\(--t1\) linear !important/);
  assert.match(reduced, /animation: none !important/);
  assert.doesNotMatch(reduced, /scale\(/);
});


test("one keyed lifecycle toast is updated in place, and app links stay in this tab", () => {
  showToast("Tidal is funded", { id: "presale-lifecycle", href: "/presale/tide", link: "View TIDE" });
  showToast("Tidal has migrated", { id: "presale-lifecycle", href: "/presale/tide", link: "View TIDE" });
  const entries = sonner.getToasts().filter((entry) => entry.id === "presale-lifecycle");
  assert.equal(entries.length, 1);
  const html = markup(entries[0]!);
  assert.match(html, /Tidal has migrated/);
  assert.match(html, /href="\/presale\/tide">View TIDE<\/a>/);
  assert.doesNotMatch(html, /target="_blank"|aria-modal|<dialog/);
  assert.match(html, /aria-label="Dismiss"/);
});
