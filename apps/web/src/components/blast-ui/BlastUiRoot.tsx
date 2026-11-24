import clsx from "clsx";
import type { ReactNode } from "react";

// The UI libraries' static styles (OA-28, ui-libraries.md): what base-ui would
// otherwise write inline. sonner's own sheet is the `<style>` it inserts when
// its module loads, which the CSP allows by its hash (OA-30).
import "#web/components/ui-libraries/library-csp.css";
import { LibraryProviders } from "#web/components/ui-libraries/LibraryProviders.tsx";
import { QueryProvider } from "#web/lib/query/provider.tsx";

import "./blast-ui.css";
import "./cursors.css";
import { CursorMount } from "./CursorMount";
import { bricolage, geist, geistMono } from "./fonts";
import { ShellPrefsBoot } from "./ShellPrefsBoot";

/**
 * The page root of every Blast UI page: the tokens, the fonts (Geist, and
 * Bricolage Grotesque for display, OA-32) and the device's preferences. Its first child (`ShellPrefsBoot`) copies the stored
 * theme, rail, right-column and privacy choices onto this element before
 * anything paints, so there is no flash of the wrong theme or layout. Those attributes are the device's, not
 * the server's, hence `suppressHydrationWarning`. `LibraryProviders` hands
 * the request's CSP nonce to the UI libraries (OA-28) and renders no element;
 * `QueryProvider` holds the server-state cache (OA-38), also no element.
 */
export function BlastUiRoot({
  nonce,
  children,
}: Readonly<{ nonce: string | null; children: ReactNode }>) {
  return (
    <div
      className={clsx(geist.variable, geistMono.variable, bricolage.variable)}
      data-blast-ui=""
      suppressHydrationWarning
    >
      <ShellPrefsBoot nonce={nonce} />
      <CursorMount />
      <link
        as="image"
        href="/blast-ui/cursors/arrow.svg"
        media="(hover: hover) and (pointer: fine) and (forced-colors: none)"
        rel="preload"
      />
      <link
        as="image"
        href="/blast-ui/cursors/arrow-dark.svg"
        media="(hover: hover) and (pointer: fine) and (forced-colors: none)"
        rel="preload"
      />
      <LibraryProviders nonce={nonce}>
        <QueryProvider>{children}</QueryProvider>
      </LibraryProviders>
    </div>
  );
}
