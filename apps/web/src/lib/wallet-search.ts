"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { isValidSuiNSName } from "@mysten/sui/utils";

import { diagnosticMessage } from "./errors.ts";
import { resolveSuiName, SUI_NAME_LOOKUP_ERROR_CODE } from "./sui-address-input.ts";

export const WALLET_SEARCH_MAX_LENGTH = 235;
export const TRADER_SEARCH_TEXT_LIMIT = 128;
export const SUI_NAME_SEARCH_NOT_FOUND = "This SuiNS name has no wallet address";

/** Only dot-form names are unambiguous in fields that also search @handles. */
export function walletSearchLookup(query: string): Promise<string | null> | null {
  return !query.includes("@") && isValidSuiNSName(query) ? resolveSuiName(query) : null;
}

type WalletSearchStatus =
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "failed"; query: string }>
  | Readonly<{ kind: "invalid"; message: string }>;

export function useWalletSearchSubmit(onSearch: (search: string, query: string) => void) {
  const latest = useRef(0);
  const [status, setStatus] = useState<WalletSearchStatus | null>(null);

  useLayoutEffect(() => () => {
    latest.current += 1;
  }, []);

  function cancel() {
    latest.current += 1;
    setStatus(null);
  }

  function submit(raw: string) {
    const query = raw.trim();
    const ticket = ++latest.current;
    const lookup = walletSearchLookup(query);
    function search(address: string | null) {
      if (latest.current !== ticket) return;
      if (address === null && query.length > TRADER_SEARCH_TEXT_LIMIT) {
        const message = lookup ? SUI_NAME_SEARCH_NOT_FOUND : `Search terms can have at most ${TRADER_SEARCH_TEXT_LIMIT} characters`;
        setStatus({ kind: "invalid", message });
        return;
      }

      setStatus(null);
      onSearch(address ?? query, query);
    }
    if (!lookup) return search(null);

    setStatus({ kind: "pending" });
    void lookup.then(search, () => {
      if (latest.current !== ticket) return;
      setStatus({ kind: "failed", query });
    });
  }

  const issue = status?.kind === "failed"
    ? { message: diagnosticMessage("Couldn’t look up this SuiNS name", { code: SUI_NAME_LOOKUP_ERROR_CODE }), retry: () => submit(status.query) }
    : status?.kind === "invalid" ? { message: status.message, retry: null } : null;
  return { cancel, issue, pending: status?.kind === "pending", submit };
}
