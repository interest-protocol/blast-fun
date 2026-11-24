import "server-only";

import { cache } from "react";

import { readProfileCallsFromBackend, readProfileFromBackend } from "#web/lib/backend-api/social-reads.ts";

/**
 * The profile page's server reads, once per request: the page, its metadata
 * and its right column (the `@rail` slot) share each answer.
 */
export const profileOf = cache(readProfileFromBackend);

/** Calls are read for the request's clock once; the right column reuses the page's answer. */
export const profileCallsOf = cache((callsign: string) => readProfileCallsFromBackend(callsign));

/** The request's clock: relative times on the page and its right column count from the same instant. */
export const requestNow = cache((): number => Date.now());
