"use client";

import { DiagnosticText } from "#web/components/blast-ui/DiagnosticText.tsx";
import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import { SUI_NAME_LOOKUP_ERROR_CODE } from "#web/lib/sui-address-input.ts";
import { diagnosticMessage } from "#web/lib/errors.ts";
import { SUI_NAME_SEARCH_NOT_FOUND, walletSearchLookup, WALLET_SEARCH_MAX_LENGTH } from "#web/lib/wallet-search.ts";
import { useContext, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from "react";

import type { PagedGroup } from "@blast/core/modules/launchpad-search/contracts.ts";

import { CloseSearchContext } from "../terminal-search-model";
import styles from "./Search.module.css";
import { readSearch } from "./search-client";
import { afterGroupPage, afterSearch, groupPageUrl, searchSummary, searchUrl, withLoadingMore, type SearchView } from "./search-model";
import { SearchResults } from "./SearchResults";

/** How long typing pauses before a search runs. Enter runs it at once. */
const DEBOUNCE_MS = 250;
const TEXT_QUERY_LIMIT = 200;

/**
 * The launchpad's global search slot, signed out: one field, and grouped
 * results from `/api/launchpad/search` as the user types. A newer search
 * cancels an older one and an older answer is dropped; while a new search
 * runs the last results stay under a Searching status. Enter searches again,
 * so a group that was unavailable can be retried. Choosing a result closes
 * the search surface.
 */
export function LaunchpadSearch() {
  const [text, setText] = useState("");
  const [view, setView] = useState<SearchView>({ status: "idle" });
  const [busy, setBusy] = useState(false);
  const close = useContext(CloseSearchContext);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const latest = useRef(0);
  const searched = useRef<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  /** After a next page, focus goes to its first new row, unless the user has moved it meanwhile. */
  const focusAfterMore = useRef<{ group: PagedGroup; index: number; from: Element | null } | null>(null);
  const id = useId();

  /** Searches `raw`; typing skips a query already searched, Enter and Try again search it again. */
  const run = (raw: string, again = false) => {
    const query = raw.trim();
    if (query === searched.current && !again) return;
    searched.current = query;
    focusAfterMore.current = null;
    inFlight.current?.abort();
    const ticket = ++latest.current;
    if (!query) {
      inFlight.current = null;
      setBusy(false);
      setView({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    inFlight.current = controller;
    setBusy(true);
    setView((current) => (current.status === "results" ? current : { status: "searching", query }));
    const finish = (next: SearchView) => {
      if (controller.signal.aborted || latest.current !== ticket) return;
      inFlight.current = null;
      setBusy(false);
      setView(next);
    };
    const lookup = walletSearchLookup(query);
    const search = (address: string | null) => {
      if (controller.signal.aborted) return;
      if (address === null && query.length > TEXT_QUERY_LIMIT) {
        const message = lookup ? SUI_NAME_SEARCH_NOT_FOUND : `Search terms can have at most ${TEXT_QUERY_LIMIT} characters`;
        finish({ status: "invalid", query, message: `${message}.` });
        return;
      }

      void readSearch(searchUrl(address ?? query), { signal: controller.signal })
        .then((answer) => finish(afterSearch(query, answer, address ?? undefined)));
    };
    if (lookup) {
      void lookup.then(search, () => finish({ status: "failed", query, reason: "the SuiNS name couldn’t be looked up", code: SUI_NAME_LOOKUP_ERROR_CODE }));
    } else {
      search(null);
    }
  };

  const debounced = useEffectEvent((value: string) => run(value));
  useEffect(() => {
    const timer = setTimeout(() => debounced(text), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  useLayoutEffect(() => () => inFlight.current?.abort(), []);

  useEffect(() => {
    const pending = focusAfterMore.current;
    if (!pending || view.status !== "results") return;
    const entry = view.groups.find((group) => group.group === pending.group);
    if (!entry || entry.loadingMore) return;
    focusAfterMore.current = null;
    if (document.activeElement !== pending.from && document.activeElement !== document.body) return;
    const rows = [...(resultsRef.current?.querySelectorAll<HTMLAnchorElement>(`[data-search-group="${pending.group}"] li > a`) ?? [])];
    // The first new row; with none, the last row only if the Show more button (and focus) went away.
    const target = rows.length > pending.index ? rows[pending.index] : document.activeElement === document.body ? rows.at(-1) : null;
    target?.focus();
  }, [view]);

  const more = (group: PagedGroup) => {
    if (view.status !== "results" || busy) return;
    const entry = view.groups.find((candidate) => candidate.group === group);
    const state = entry?.state;
    if (!entry || entry.loadingMore || !state || (state.status !== "ready" && state.status !== "stale") || !state.value.nextCursor) return;
    const ticket = latest.current;
    focusAfterMore.current = { group, index: state.value.items.length, from: document.activeElement };
    setView((current) => withLoadingMore(current, group));
    const { query, walletAddress } = view;
    void readSearch(groupPageUrl(walletAddress ?? query, group, state.value.nextCursor)).then((answer) => {
      if (latest.current !== ticket) return;
      setView((current) => afterGroupPage(current, group, query, answer));
    });
  };

  /** Try again: the field keeps focus, since the button that was pressed goes away with the answer. */
  const retry = () => {
    inputRef.current?.focus();
    run(text, true);
  };

  const clear = () => {
    setText("");
    run("");
    inputRef.current?.focus();
  };

  const summary = searchSummary(view);
  const status = view.status === "failed" && view.code ? diagnosticMessage(summary, { code: view.code }) : summary;
  return (
    <div className={styles.search}>
      <form
        className={styles.form}
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          run(text, true);
        }}
      >
        <label className={styles.label} htmlFor={`${id}-query`}>Search Blast launches</label>
        <input
          ref={inputRef}
          className={styles.input}
          id={`${id}-query`}
          type="search"
          name="q"
          value={text}
          onChange={(event) => {
            if (inFlight.current) {
              inFlight.current.abort();
              inFlight.current = null;
              searched.current = null;
            }
            setText(event.target.value);
          }}
          maxLength={WALLET_SEARCH_MAX_LENGTH}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="search"
          placeholder="Name, ticker, ID, wallet or thesis"
          aria-describedby={`${id}-status`}
          data-autofocus="true"
          onKeyDown={(event) => {
            // A search field clears itself on Escape; in this dialog Escape closes Search and keeps the text.
            if (event.key !== "Escape") return;
            event.preventDefault();
            close();
          }}
        />
      </form>
      <p className={styles.status} id={`${id}-status`} role="status" aria-live="polite">{busy ? <LoadingIndicator label="Searching launches" /> : <DiagnosticText message={status} />}</p>
      <div ref={resultsRef} className={styles.resultsRegion} aria-busy={busy || undefined}>
        <SearchResults view={view} busy={busy} onMore={more} onClear={clear} onRetry={retry} onChoose={close} />
      </div>
    </div>
  );
}
