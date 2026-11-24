"use client";

import { createContext, useContext } from "react";

/**
 * The request's CSP nonce on the client (OA-28, `docs/product/social-feed/ui-libraries.md`).
 * `style-src` admits a `<style>` only with this nonce, so a library that
 * writes one (dnd kit's drag styles) is handed it from here. `BlastUiRoot`
 * provides it through `LibraryProviders`; outside a Blast UI root it is
 * `undefined` and those libraries' `<style>` is refused by the browser.
 */
export const StyleNonceContext = createContext<string | undefined>(undefined);

export function useStyleNonce(): string | undefined {
  return useContext(StyleNonceContext);
}
